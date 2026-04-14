#!/usr/bin/env python3
"""Register crux MCP server in Claude Code (~/.claude.json) and VSCode settings.json."""
import json, pathlib, sys

bin_path = str(pathlib.Path.home() / "bin/crux")

# ── 1. Claude Code global config (~/.claude.json) ─────────────────────────────
claude_json = pathlib.Path.home() / ".claude.json"
try:
    config = json.loads(claude_json.read_text()) if claude_json.exists() else {}
except json.JSONDecodeError:
    print("Warning: could not parse ~/.claude.json — skipping Claude Code MCP config", file=sys.stderr)
    config = None

if config is not None:
    config.setdefault("mcpServers", {})["crux"] = {
        "command": bin_path,
        "args": [],
        "scope": "user",
    }
    claude_json.write_text(json.dumps(config, indent=2) + "\n")
    print(f"Claude Code MCP config updated → {claude_json}")

# ── 2. VSCode settings.json (Claude Code VSCode extension) ────────────────────
vscode_settings = pathlib.Path.home() / "Library/Application Support/Code/User/settings.json"
vscode_settings.parent.mkdir(parents=True, exist_ok=True)

try:
    settings = json.loads(vscode_settings.read_text()) if vscode_settings.exists() else {}
except json.JSONDecodeError:
    print("Warning: could not parse VSCode settings.json — skipping VSCode MCP config", file=sys.stderr)
    sys.exit(0)

settings.setdefault("mcp", {}).setdefault("servers", {})["crux"] = {
    "command": bin_path
}
vscode_settings.write_text(json.dumps(settings, indent=2) + "\n")
print(f"VSCode MCP config updated → {vscode_settings}")
