#!/usr/bin/env python3
"""Blocks git commands that destroy uncommitted work with no way back.

Written after a hard reset was run here to clean up a cherry-pick that had
already aborted on its own. It wiped every uncommitted change in the working
tree. Unstaged changes are not in the object database, so git has nothing to
restore from: no reflog entry, no dangling blob, nothing.

The rule these share: they discard state that was never committed. Anything
recoverable (reset --soft, reset --mixed, revert, restore --staged) is NOT
blocked.

Heredoc bodies and quoted strings are stripped before matching, because the
first version of this guard blocked a commit whose *message* described the
incident. A guard that blocks legitimate work gets switched off, which is
worse than no guard at all.
"""
import json
import re
import sys


def strip_noise(cmd: str) -> str:
    """Remove heredoc bodies and quoted literals — prose, not invocations."""
    for m in re.finditer(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1", cmd):
        delim = m.group(2)
        end = re.search(rf"^\s*{re.escape(delim)}\s*$", cmd[m.end():], re.M)
        stop = m.end() + (end.end() if end else len(cmd))
        cmd = cmd[:m.end()] + " " * (stop - m.end()) + cmd[stop:]
    cmd = re.sub(r"'[^']*'", "''", cmd)
    cmd = re.sub(r'"[^"]*"', '""', cmd)
    return re.sub(r"\s+", " ", cmd)


def deny(reason: str) -> None:
    json.dump({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}, sys.stdout)
    sys.exit(0)


TAIL = "\nIf you genuinely intend this, run it yourself outside Claude."

RULES = [
    (r"\bgit\s+reset\b[^|;&]*--hard",
     "a hard reset discards every uncommitted change in the working tree, and "
     "unstaged work is not in the object database — there is no reflog entry or "
     "dangling blob to recover from. This guard exists because that command "
     "destroyed a day of work in this repo.\n\n"
     "To test something safely: git stash push -u   (then git stash pop)\n"
     "To move HEAD but keep changes: git reset --soft <ref>"),
    (r"\bgit\s+clean\b[^|;&]*-[a-zA-Z]*f",
     "a forced clean permanently deletes untracked files. Git has never seen "
     "them, so nothing about them is recoverable.\n\n"
     "To preview: git clean -n"),
    (r"\bgit\s+checkout\s+--\s|\bgit\s+checkout\s+\.(\s|$)",
     "checking out a path overwrites the working copy from the index, "
     "discarding uncommitted edits.\n\n"
     "To keep them: git stash push -u -- <path>"),
    (r"\bgit\s+restore\b(?![^|;&]*--staged)",
     "restoring a path without --staged overwrites the working copy.\n\n"
     "To unstage only: git restore --staged <path>\n"
     "To keep changes:  git stash push -u -- <path>"),
    (r"\bgit\s+stash\s+(drop|clear)\b",
     "this deletes stashed work. A dropped stash leaves a dangling commit that "
     "is hard to find and is garbage-collected — treat it as unrecoverable.\n\n"
     "To inspect first: git stash list && git stash show -p"),
    (r"\bgit\s+branch\b[^|;&]*\s-D\b",
     "a forced branch delete removes a branch whose commits may be unmerged.\n\n"
     "To check:  git log --oneline <branch> --not --remotes\n"
     "Safe form: git branch -d <branch>"),
    (r"\bgit\s+push\b(?![^|;&]*--force-with-lease)[^|;&]*(--force\b|\s-f\b)",
     "a bare force push can destroy commits on the remote you never fetched.\n\n"
     "Safer: git push --force-with-lease"),
]


def main() -> None:
    try:
        cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command") or ""
    except Exception:
        sys.exit(0)
    if not cmd:
        sys.exit(0)
    haystack = strip_noise(cmd)
    for pattern, reason in RULES:
        if re.search(pattern, haystack):
            deny("BLOCKED: " + reason + TAIL)
    sys.exit(0)


main()
