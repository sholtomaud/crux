/**
 * lib/workflow.ts — Deterministic workflow engine
 *
 * Each task_type maps to a scaffolded sequence of steps:
 *   - git steps  (branch, commit, push)       — deterministic, no LLM
 *   - llm steps  (write tests, write impl)     — focused single-purpose LLM call
 *   - verify steps (run tests, check errors)   — deterministic
 *
 * Each LLM step gets a fresh, scoped context — no accumulation, no context overflow.
 * Falls back to the free-form runAgent loop for task_type='other'.
 *
 * Entry point: runWorkflow(db, proj, task, opts)
 * Called by cmdAgent in index.ts — auto-selected based on task.task_type.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './ask.ts';
import { updateTaskStatus, logAudit, listAdrs, dependenciesByProject, tasksByProject, taskBySlug, activeSession, findRepoRoot, updateTaskWorktreePath } from './db.ts';
import type { Project, Task, TaskType } from './db.ts';
import { readDbSignatures, readTestPattern, resolveConventions } from './codebase.ts';

// ── Codebase grounding helpers ────────────────────────────────────────────────
// readDbSignatures and readTestPattern imported from lib/codebase.ts

/** Read the first N lines of a file for context */
function readFileHead(filePath: string, lines = 80): string {
  if (!existsSync(filePath)) return `(file not found: ${filePath})`;
  return readFileSync(filePath, 'utf8').split('\n').slice(0, lines).join('\n');
}

/** Parse files_affected JSON array from task */
function affectedFiles(task: Task): string[] {
  if (!task.files_affected) return [];
  try { return JSON.parse(task.files_affected) as string[]; }
  catch { return []; }
}

/** Parse files_to_create JSON array from task */
interface FileToCreate { path: string; signature: string; imports?: string }
function filesToCreate(task: Task): FileToCreate[] {
  if (!task.files_to_create) return [];
  try { return JSON.parse(task.files_to_create) as FileToCreate[]; }
  catch { return []; }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkflowResult {
  completed:  boolean;
  blocked:    boolean;
  step:       string;       // last step reached
  note?:      string;
}

interface StepContext {
  db:            DatabaseSync;
  proj:          Project;
  task:          Task;
  branch:        string;
  cwd:           string;
  usingWorktree: boolean;
  /** Paths already dirty when the run started — never this run's work, so never
   *  swept into its commits (see commitGuard). */
  preexistingDirty: string[];
  log:           (s: string) => void;
  llm:           LlmConfig;
  containerName: string | null;
}

interface LlmConfig {
  endpoint: string;
  model:    string;
  ctxTokens: number;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function git(args: string[], cwd: string, log: (s: string) => void): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
  if (r.status !== 0) log(`  [git] FAIL: git ${args.join(' ')}\n  ${out}`);
  return { ok: r.status === 0, out };
}

// ── Standalone git operations (no StepContext/workflow session required) ─────
// Used by crux_git_commit/crux_git_push for incremental interactive work,
// as opposed to stepCommit/stepPush which are steps inside the full
// autonomous tddWorkflow pipeline.

/** Absolute git toplevel containing `path` — the linked worktree's own root when
 *  the path lives in one — or null if it isn't inside a repo at all. */
export function gitToplevel(path: string): string | null {
  const dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  if (!existsSync(dir)) return null;
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export function currentBranch(cwd: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.trim() || null) : null;
}

/**
 * Decide which checkout a commit of `files` belongs to, by asking git about the
 * files themselves rather than trusting the caller's cwd. A worktree created by
 * createTaskWorktree is a sibling directory, so committing its files from the
 * primary checkout used to fail with "outside repository" — resolving from the
 * paths makes crux_git_commit work whether or not a task slug was passed.
 * Files spanning two worktrees are refused outright: git would stage part of the
 * set and then fail, leaving the caller with a half-staged index.
 */
export function resolveCommitRoot(cwd: string, files: string[]): { ok: boolean; root: string; out: string } {
  const byRoot = new Map<string, string[]>();
  for (const f of files) {
    const top = gitToplevel(isAbsolute(f) ? f : join(cwd, f));
    if (!top) continue;
    byRoot.set(top, [...(byRoot.get(top) ?? []), f]);
  }
  if (byRoot.size === 0) return { ok: true, root: cwd, out: '' };
  if (byRoot.size > 1) {
    const detail = [...byRoot.entries()].map(([root, fs]) => `  ${root}\n    ${fs.join('\n    ')}`).join('\n');
    return {
      ok: false, root: cwd,
      out: `files span ${byRoot.size} different worktrees — commit each separately:\n${detail}`,
    };
  }
  return { ok: true, root: [...byRoot.keys()][0], out: '' };
}

export function gitCommitFiles(
  cwd: string, message: string, files: string[]
): { ok: boolean; out: string; root?: string; branch?: string } {
  if (files.length === 0) return { ok: false, out: 'no files given — nothing to commit' };
  const resolved = resolveCommitRoot(cwd, files);
  if (!resolved.ok) return { ok: false, out: resolved.out };

  const root = resolved.root;
  const noop = () => {};
  // Absolute paths throughout: `files` are relative to the caller's cwd, which
  // is not necessarily the worktree we resolved to.
  const abs = files.map(f => (isAbsolute(f) ? f : join(cwd, f)));

  // `-A --` rather than a bare `git add`: plain add fails with "pathspec did
  // not match any files" on a path deleted from the working tree, which
  // rejected the whole commit whenever it included a deletion. With -A a single
  // call stages adds, modifications and deletions alike.
  //
  // The commit itself stays unrestricted by path on purpose. Callers rely on it
  // sweeping in whatever is already staged — that is what made the manual
  // `git rm --cached` workaround for this very bug work — so narrowing it to
  // `commit -- <paths>` would be a separate behaviour change, not a bug fix.
  const add = git(['add', '-A', '--', ...abs], root, noop);
  if (!add.ok) return { ...add, root };
  const commit = git(['commit', '-m', message], root, noop);
  return { ...commit, root, branch: currentBranch(root) ?? undefined };
}

export function gitPushBranch(cwd: string, branch?: string): { ok: boolean; out: string } {
  const noop = () => {};
  const args = branch ? ['push', '-u', 'origin', branch] : ['push'];
  return git(args, cwd, noop);
}

/**
 * Resolve which directory a git operation for this project should run in.
 * If a slug is given and that task has an isolated worktree (see
 * createTaskWorktree below), operate there — otherwise interactive tools like
 * crux_git_commit/crux_git_push always resolve to the primary repo root and
 * silently can't reach a task's isolated worktree at all (files/paths that
 * only exist there get rejected by git as outside the repo). The autonomous
 * runWorkflow engine doesn't need this — it threads ctx.cwd itself.
 * Falls back to repoRoot when there's no slug, no matching task, or no worktree.
 */
export function resolveTaskCwd(db: DatabaseSync, projectId: string, repoRoot: string, slug?: string): string {
  if (!slug) return repoRoot;
  const task = taskBySlug(db, projectId, slug);
  if (task?.worktree_path && existsSync(task.worktree_path)) return task.worktree_path;
  return repoRoot;
}

/** The remote to sync against — `origin` when present, else the first one
 *  configured, else null. Asked of git directly: a project can have a working
 *  origin while its gh_repo column is null, so the DB is not a reliable source. */
export function detectRemote(repoRoot: string): string | null {
  const r = spawnSync('git', ['remote'], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const remotes = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (remotes.length === 0) return null;
  return remotes.includes('origin') ? 'origin' : remotes[0];
}

function refExists(repoRoot: string, ref: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: repoRoot, encoding: 'utf8' }).status === 0;
}

/** Commits on `local` not on `remote`, and vice versa. Null when either ref is missing. */
function aheadBehind(repoRoot: string, local: string, remote: string): { ahead: number; behind: number } | null {
  const r = spawnSync('git', ['rev-list', '--left-right', '--count', `${local}...${remote}`], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

export interface WorktreeResult {
  ok: boolean;
  out: string;
  path?: string;
  branch?: string;
  remote?: string | null;
  base?: string;              // commit sha the new branch starts at
  base_ref?: string;          // what that sha was resolved from, e.g. 'origin/main'
  reused_branch?: boolean;    // re-attached to an existing feat/<slug> branch
  ahead?: number | null;      // local main vs remote main; null when there's no remote
  behind?: number | null;
}

/**
 * Creates an isolated git worktree + feat/<slug> branch for interactive task work,
 * as a sibling directory of repoRoot — so a human or agent working on one task
 * never collides with other in-flight work in the primary checkout.
 *
 * Fetches before branching so the branch starts from the current remote tip
 * rather than whatever the local clone last saw — a stale base only surfaces
 * later, as a needless conflict at PR time. Local commits are never discarded:
 * if local main is ahead of, or diverged from, the remote, the branch is based
 * on local main and the ahead/behind counts are reported so the caller can see
 * what it got. A repo with no remote branches locally rather than failing.
 */
export function createTaskWorktree(repoRoot: string, slug: string): WorktreeResult {
  const noop = () => {};
  const branch = `feat/${slug}`;
  const worktreePath = join(dirname(repoRoot), `${basename(repoRoot)}-${slug}`);

  if (existsSync(worktreePath)) {
    return { ok: false, out: `Worktree path already exists: ${worktreePath}` };
  }

  const remote = detectRemote(repoRoot);
  const localRef = refExists(repoRoot, 'main') ? 'main' : 'HEAD';
  let baseRef = localRef;
  let counts: { ahead: number; behind: number } | null = null;

  if (remote) {
    // Update the remote-tracking ref only — never the local branch, which may
    // hold unpushed commits. Forced because a tracking ref is a mirror of the
    // remote and may legitimately be rewritten there.
    const remoteMain = `refs/remotes/${remote}/main`;
    const fetch = git(['fetch', remote, `+main:${remoteMain}`], repoRoot, noop);
    if (!fetch.ok) return { ok: false, out: `Failed to fetch ${remote}: ${fetch.out}`, remote };

    counts = aheadBehind(repoRoot, localRef, remoteMain);
    // Strictly behind → the remote tip is what we want. Ahead or diverged →
    // stay local so unpushed work is carried into the worktree, not dropped.
    if (counts && counts.behind > 0 && counts.ahead === 0) baseRef = `${remote}/main`;
  }

  // Drop admin entries for worktrees whose directory was deleted by hand —
  // otherwise git still considers the path registered and refuses to re-add it.
  git(['worktree', 'prune'], repoRoot, noop);

  // The branch outlives the directory. Re-attach to it rather than passing -b
  // (which fails when it exists) or -B (which would reset it, discarding any
  // commits made before the directory was removed).
  const branchExists = refExists(repoRoot, `refs/heads/${branch}`);
  const add = branchExists
    ? git(['worktree', 'add', worktreePath, branch], repoRoot, noop)
    : git(['worktree', 'add', worktreePath, '-b', branch, baseRef], repoRoot, noop);
  if (!add.ok) return { ok: false, out: add.out, remote };

  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim();
  return {
    ok: true, out: add.out, path: worktreePath, branch,
    remote, base, base_ref: branchExists ? branch : baseRef, reused_branch: branchExists,
    ahead: counts ? counts.ahead : null,
    behind: counts ? counts.behind : null,
  };
}

function run(cmd: string, cwd: string, log: (s: string) => void): { ok: boolean; out: string } {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 120_000 });
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
  return { ok: r.status === 0, out };
}

/** Run a command either in a session container (exec) or directly in the shell */
function runInEnv(cmd: string, cwd: string, containerName: string | null, log: (s: string) => void): { ok: boolean; out: string } {
  if (containerName) {
    const r = spawnSync('container', ['exec', containerName, 'sh', '-c', cmd], { encoding: 'utf8', timeout: 120_000 });
    const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
    if (r.error) log(`  [container] exec error: ${r.error.message}`);
    return { ok: r.status === 0, out };
  }
  return run(cmd, cwd, log);
}

// ── LLM call (single focused prompt, fresh context) ───────────────────────────

async function llmCall(
  prompt: string,
  systemPrompt: string,
  cfg: LlmConfig,
  log: (s: string) => void,
): Promise<string | null> {
  log(`  [llm] → ${cfg.model} (${Math.ceil(prompt.length / 4)} est. tokens)`);
  try {
    const resp = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system',  content: systemPrompt },
          { role: 'user',    content: prompt + ' /no_think' },
        ],
        temperature: 0.1,
        max_tokens:  2048,
      }),
    });
    if (!resp.ok) { log(`  [llm] HTTP ${resp.status}`); return null; }
    const data = await resp.json() as { choices?: Array<{ message: { content: string } }> };
    let content = data.choices?.[0]?.message?.content ?? null;
    if (content) content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return content;
  } catch (e) {
    log(`  [llm] fetch error: ${(e as Error).message}`);
    return null;
  }
}

// ── Shared system prompt ──────────────────────────────────────────────────────

function baseSystemPrompt(task: Task, proj: Project, db: DatabaseSync, cwd: string, resuming = false): string {
  const adrs     = listAdrs(db, proj.id).slice(0, 3);
  const tasks    = tasksByProject(db, proj.id);
  const deps     = dependenciesByProject(db, proj.id);
  const slugById = new Map(tasks.map(t => [t.id, t.slug]));
  const preds    = deps.filter(d => d.successor_id === task.id).map(d => slugById.get(d.predecessor_id) ?? '?');
  const files    = affectedFiles(task);

  const resumeNote = resuming
    ? `\nNOTE: This task was previously started but did not complete. Branch feat/${task.slug} may have partial work — check before overwriting.`
    : '';

  const newFiles  = filesToCreate(task);

  // Inject heads of files_affected (existing files needing minor edits — imports, wiring)
  const fileContext = files.length
    ? '\n\n## Existing files needing edits (first 80 lines — add imports/exports only):\n' +
      files.map(f => `### ${f}\n${readFileHead(join(cwd, f))}`).join('\n\n')
    : '';

  // Structured list of new files to create
  const newFilesContext = newFiles.length
    ? '\n\n## New files to CREATE (do not modify any other file):\n' +
      newFiles.map(f =>
        `### ${f.path}\nSignature: ${f.signature}${f.imports ? `\nImports needed: ${f.imports}` : ''}`
      ).join('\n\n')
    : '';

  // DB signatures from modular lib/db/*.ts. Empty for any repo without one,
  // which is most of them — the section is omitted rather than printed blank.
  const dbSigs = readDbSignatures(cwd);
  const dbSection = dbSigs
    ? `\n\n## lib/db exports (real API — use these, do not invent):\n${dbSigs}`
    : '';

  // The agent is told this project's conventions, or none at all. It used to be
  // told crux's — "edit lib/db/<domain>.ts", "run make test-ci" — for every
  // project, so an agent working a C or Python task was instructed to edit files
  // that do not exist. Silence is recoverable; confident wrong house rules
  // are not.
  const { conventions, conventions_source } = resolveConventions(proj.repo_path);
  const conventionsSection = conventions.length
    ? `\n\n## Project conventions (from ${conventions_source})\n${conventions.map(c => `- ${c}`).join('\n')}`
    : '\n\n## Project conventions\nNone recorded for this project. Follow the conventions visible in the surrounding code — do not assume a stack or a layout.';

  const commands = [
    proj.verify_cmd ? `Verify: ${proj.verify_cmd}` : null,
    proj.test_cmd   ? `Tests: ${proj.test_cmd}`    : null,
  ].filter(Boolean);
  const commandsSection = commands.length ? `\n\n## Commands\n${commands.map(c => `- ${c}`).join('\n')}` : '';

  return `You are an expert software engineer working on the ${proj.name} project.${conventionsSection}${commandsSection}${dbSection}

## Task: ${task.slug}
Title: ${task.title}
Description: ${task.description ?? 'infer from title'}
Acceptance criteria: ${task.acceptance_criteria ?? 'see description'}
Depends on: ${preds.length ? preds.join(', ') : 'none'}
ADRs: ${adrs.map(a => `ADR-${a.number}: ${a.decision?.slice(0, 80)}`).join(' | ')}${resumeNote}${newFilesContext}${fileContext}

Respond with file contents only. First line of each file: // path/to/file.ts`;
}

// ── Step: create + checkout branch ───────────────────────────────────────────

function stepBranch(ctx: StepContext): boolean {
  const { branch, log, cwd, usingWorktree } = ctx;

  // In a worktree, createTaskWorktree() already created + checked out the
  // branch (from up-to-date main) when the worktree itself was created — just
  // confirm we're on it rather than redoing checkout logic in-place, which
  // would touch the shared primary checkout other tasks may be using.
  if (usingWorktree) {
    const current = git(['branch', '--show-current'], cwd, log);
    if (current.out.trim() === branch) {
      log(`  [branch] worktree already on ${branch}`);
      return true;
    }
    log(`  [branch] worktree not on expected branch (found "${current.out.trim()}") — checking out ${branch}`);
    const co = git(['checkout', branch], cwd, log);
    return co.ok;
  }

  // No worktree (creation failed, or an older task predating this feature
  // with no worktree_path) — fall back to in-place checkout as before.
  // Resuming a task already in progress — check out its existing branch as-is.
  // Do NOT sync main here: this branch may already have diverged from main
  // by design (partial prior work), and that's fine.
  const existing = git(['branch', '--list', branch], cwd, log);
  if (existing.out.includes(branch)) {
    log(`  [branch] ${branch} already exists — checking out`);
    const co = git(['checkout', branch], cwd, log);
    return co.ok;
  }

  // New task — sync main first so the new branch always forks from an
  // up-to-date trunk, not from whatever HEAD a previous task left behind.
  const mainCheckout = git(['checkout', 'main'], cwd, log);
  if (!mainCheckout.ok) { log('  [branch] could not checkout main'); return false; }
  const pull = git(['pull', '--ff-only', 'origin', 'main'], cwd, log);
  if (!pull.ok) { log(`  [branch] main not fast-forwardable from origin — aborting: ${pull.out}`); return false; }

  const r = git(['checkout', '-b', branch], cwd, log);
  if (r.ok) log(`  [branch] created + checked out: ${branch} (from up-to-date main)`);
  return r.ok;
}

// ── Step: commit staged changes ───────────────────────────────────────────────

/** Repo-relative paths with uncommitted changes, including untracked files. */
export function dirtyPaths(cwd: string): string[] {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const entry = line.slice(3);
    const renamed = entry.indexOf(' -> ');           // "R  old -> new"
    const path = renamed >= 0 ? entry.slice(renamed + 4) : entry;
    return path.replace(/^"|"$/g, '');               // git quotes paths with odd chars
  });
}

/**
 * Decide whether the autonomous engine is allowed to make this commit.
 *
 * Two failures observed in GSSK on 2026-08-02, both of which committed work the
 * engine did not author:
 *  - it committed a working tree another session had left dirty, under its own
 *    message. Only files the run itself wrote may be committed, so a file that
 *    was ALREADY modified when the run started is refused rather than swept up.
 *  - it committed one task's changes onto another task's branch. The branch is
 *    resolved from the task being worked, so a checkout sitting on a sibling
 *    task's branch is refused rather than written to.
 *
 * Pure so both rules are testable without driving a full workflow run.
 */
export function commitGuard(opts: {
  branch: string;
  currentBranch: string | null;
  preexistingDirty: string[];
  files: string[];
}): { ok: boolean; reason?: string } {
  const { branch, currentBranch, preexistingDirty, files } = opts;

  if (currentBranch && currentBranch !== branch) {
    return {
      ok: false,
      reason: `refusing to commit: checkout is on "${currentBranch}" but this task's branch is "${branch}" — `
            + `committing here would put this task's changes on another task's branch`,
    };
  }

  const dirty = new Set(preexistingDirty);
  const foreign = files.filter(f => dirty.has(f));
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `refusing to commit: ${foreign.length} file(s) were already modified before this run started `
            + `and may belong to another session — commit, stash or revert them first:\n  ${foreign.join('\n  ')}`,
    };
  }

  return { ok: true };
}

function stepCommit(ctx: StepContext, message: string, files: string[]): boolean {
  const { log, cwd, branch, preexistingDirty } = ctx;
  if (files.length === 0) { log('  [commit] nothing to commit'); return true; }

  const guard = commitGuard({ branch, currentBranch: currentBranch(cwd), preexistingDirty, files });
  if (!guard.ok) { log(`  [commit] ${guard.reason}`); return false; }

  const add = git(['add', ...files], cwd, log);
  if (!add.ok) return false;
  const commit = git(['commit', '-m', message], cwd, log);
  if (commit.ok) log(`  [commit] ${message}`);
  return commit.ok;
}

// ── Step: run tests ───────────────────────────────────────────────────────────

/** Filter raw `make test` output to failures + summary only */
function filterTestOutput(raw: string): string {
  return raw.split('\n')
    .filter(l => /^(✖|  Error:|  AssertionError|ℹ (tests|fail|pass|suites))/.test(l))
    .join('\n');
}

/** Filter raw `make typecheck` output to error lines only */
function filterTscOutput(raw: string): string {
  return raw.split('\n')
    .filter(l => l.includes('error TS'))
    .join('\n');
}

function stepRunTests(ctx: StepContext): { ok: boolean; output: string } {
  const { log, proj, containerName, cwd, usingWorktree } = ctx;
  const cmd = proj.test_cmd ?? (proj.run_env === 'shell' ? 'make test-ci 2>&1' : null);
  if (!cmd) {
    if (proj.run_env === 'container') {
      log('  [test] run_env=container but no test_cmd configured — cannot verify, blocking');
      return { ok: false, output: 'run_env=container requires test_cmd (crux project env --test-cmd "...")' };
    }
    log('  [test] no test_cmd — skipped');
    return { ok: true, output: '(skipped: no test_cmd)' };
  }
  if (usingWorktree && containerName) {
    log('  [test] WARNING: containerName is set but its volume mount is fixed to the primary checkout at session-start — this runs against that mount, not the isolated worktree (see p18-worktree-task-isolation follow-up)');
  }
  log(`  [test] ${cmd}...`);
  const r = runInEnv(cmd, cwd, containerName, log);
  log(`  [test] ${r.ok ? 'PASS' : 'FAIL'}`);
  return { ok: r.ok, output: filterTestOutput(r.out).slice(0, 2000) };
}

// ── Step: tsc check ───────────────────────────────────────────────────────────

function stepTsc(ctx: StepContext): { ok: boolean; output: string } {
  const { log, proj, containerName, cwd, usingWorktree } = ctx;
  const cmd = proj.verify_cmd ?? (proj.run_env === 'shell' ? 'make typecheck 2>&1' : null);
  if (!cmd) {
    if (proj.run_env === 'container') {
      log('  [tsc] run_env=container but no verify_cmd configured — cannot verify, blocking');
      return { ok: false, output: 'run_env=container requires verify_cmd (crux project env --verify-cmd "...")' };
    }
    log('  [tsc] no verify_cmd — skipped');
    return { ok: true, output: '(skipped: no verify_cmd)' };
  }
  if (usingWorktree && containerName) {
    log('  [tsc] WARNING: containerName is set but its volume mount is fixed to the primary checkout at session-start — this runs against that mount, not the isolated worktree (see p18-worktree-task-isolation follow-up)');
  }
  log(`  [tsc] ${cmd}...`);
  const r = runInEnv(cmd, cwd, containerName, log);
  log(`  [tsc] ${r.ok ? 'OK' : 'errors'}`);
  return { ok: r.ok, output: filterTscOutput(r.out).slice(0, 2000) };
}

// ── Step: push branch ─────────────────────────────────────────────────────────

function stepPush(ctx: StepContext): boolean {
  const { branch, log, cwd } = ctx;
  const r = git(['push', '-u', 'origin', branch], cwd, log);
  if (r.ok) log(`  [push] pushed ${branch}`);
  return r.ok;
}

// ── Step: open PR (idempotent) + wait for CI checks ───────────────────────────

function stepOpenPr(ctx: StepContext): { url: string | null } {
  const { branch, log, proj } = ctx;
  if (!proj.gh_repo) { log('  [pr] no gh_repo configured — skipping PR'); return { url: null }; }

  const existing = spawnSync('gh', ['pr', 'view', branch, '--repo', proj.gh_repo, '--json', 'url'], { encoding: 'utf8' });
  if (existing.status === 0) {
    try {
      const { url } = JSON.parse(existing.stdout) as { url: string };
      log(`  [pr] existing PR: ${url}`);
      return { url };
    } catch { /* fall through to create */ }
  }

  const created = spawnSync('gh', ['pr', 'create', '--repo', proj.gh_repo, '--head', branch, '--fill'], { encoding: 'utf8' });
  if (created.status !== 0) { log(`  [pr] gh pr create failed: ${created.stderr}`); return { url: null }; }
  const url = created.stdout.trim();
  log(`  [pr] created: ${url}`);
  return { url };
}

interface CheckRun { status: string; conclusion: string | null; name?: string }

const CI_FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

/** Pure decision logic — given the GH check-runs for a commit, what's the verdict? */
export function checksConclusion(runs: CheckRun[]): 'pending' | 'success' | 'failure' | 'none' {
  if (runs.length === 0) return 'none';
  if (runs.some(r => r.status !== 'completed')) return 'pending';
  if (runs.some(r => r.conclusion && CI_FAILURE_CONCLUSIONS.has(r.conclusion))) return 'failure';
  return 'success';
}

function stepWaitForChecks(ctx: StepContext, maxAttempts = 8, intervalSeconds = 15): { outcome: 'success' | 'failure' | 'none'; output: string } {
  const { log, proj, cwd } = ctx;
  if (!proj.gh_repo) return { outcome: 'none', output: '(no gh_repo configured)' };

  const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const sha = shaResult.stdout?.trim();
  if (!sha) return { outcome: 'none', output: '(could not resolve HEAD sha)' };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = spawnSync('gh', ['api', `repos/${proj.gh_repo}/commits/${sha}/check-runs`], { encoding: 'utf8' });
    if (r.status !== 0) { log(`  [ci] check-runs API error: ${r.stderr}`); return { outcome: 'none', output: r.stderr }; }
    let runs: CheckRun[] = [];
    try { runs = ((JSON.parse(r.stdout) as { check_runs?: CheckRun[] }).check_runs ?? []); } catch { /* leave empty */ }
    const conclusion = checksConclusion(runs);
    log(`  [ci] attempt ${attempt}/${maxAttempts}: ${conclusion} (${runs.length} checks)`);
    if (conclusion !== 'pending') {
      const output = JSON.stringify(runs.map(r => ({ name: r.name, conclusion: r.conclusion })), null, 2);
      return { outcome: conclusion, output };
    }
    if (attempt < maxAttempts) spawnSync('sleep', [String(intervalSeconds)]);
  }
  return { outcome: 'none', output: '(CI still pending after max wait — proceeding without a verdict)' };
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW: coding (TDD)
// Steps: branch → write tests → commit → implement → commit → tsc → fix loop
//        → run tests → fix loop → push → done
// ══════════════════════════════════════════════════════════════════════════════

async function tddWorkflow(ctx: StepContext): Promise<WorkflowResult> {
  const { task, proj, db, log, llm, cwd } = ctx;
  const resuming = task.status === 'in-progress';
  const sys = baseSystemPrompt(task, proj, db, cwd, resuming);

  // 1. Branch
  log('\n[step 1/9] create branch');
  if (!stepBranch(ctx)) return { completed: false, blocked: true, step: 'branch', note: 'git branch failed' };

  // 2. LLM: write tests
  log('\n[step 2/9] LLM: write tests');
  const testPattern = readTestPattern(cwd);
  const testPrompt = `Write failing tests for: ${task.slug} — ${task.title}

Acceptance criteria (what the tests must verify):
${task.acceptance_criteria ?? task.description ?? 'see title'}

Files that will be changed by the implementation:
${affectedFiles(task).join(', ') || 'lib/db.ts, index.ts'}

MANDATORY — follow this exact test pattern from the existing codebase:
\`\`\`typescript
${testPattern}
\`\`\`

Rules:
- Use node:test and node:assert/strict — no jest, no mocha, no other frameworks
- Use new DatabaseSync(':memory:') for DB tests — never openDb() which touches ~/.crux/crux.db
- Load schema.sql manually (see pattern above)
- Import only from lib/db.ts, lib/cpm.ts etc — the real modules
- Tests must FAIL before implementation exists (red phase of TDD)
- Output the full test file. First line: // test/unit/${task.slug}.test.ts`;

  const testCode = await llmCall(testPrompt, sys, llm, log);
  if (!testCode) return { completed: false, blocked: true, step: 'write-tests', note: 'LLM unavailable' };

  // Extract path hint and write file
  const testPathMatch = testCode.match(/\/\/\s*(test\/[\w\-/.]+\.ts)/);
  const testPath = testPathMatch ? testPathMatch[1] : `test/${task.slug}.test.ts`;
  const testContent = testCode.replace(/^\/\/\s*test\/[\w\-/.]+\.ts\n/, '');
  run(`mkdir -p $(dirname ${testPath})`, cwd, log);
  run(`cat > ${testPath} << 'CRUX_EOF'\n${testContent}\nCRUX_EOF`, cwd, log);
  log(`  [write] ${testPath}`);

  // 3. Commit tests
  log('\n[step 3/9] commit tests');
  stepCommit(ctx, `test(${task.slug}): add failing tests`, [testPath]);

  // 4. LLM: write implementation
  log('\n[step 4/9] LLM: write implementation');
  const newFiles  = filesToCreate(task);
  const createInstruction = newFiles.length
    ? `Create ONLY these new files (do not modify any existing file):\n${newFiles.map(f => `- ${f.path} — ${f.signature}`).join('\n')}`
    : `Files to change: ${affectedFiles(task).join(', ') || 'determine from tests'}`;

  const implPrompt = `Implement: ${task.slug} — ${task.title}

Acceptance criteria: ${task.acceptance_criteria ?? task.description ?? ''}
${createInstruction}

These tests must pass:
${testContent.slice(0, 1500)}

Rules:
- Schema changes go in BOTH schema.sql AND applyMigrations() in lib/db/open.ts
- New DB functions go in a new lib/db/<domain>.ts file, then export from lib/db/index.ts
- Do NOT edit lib/db.ts (re-export shim — contains only "export * from './db/index.ts'")
- New MCP tools go in runMcpServer() in index.ts
- No console.log in MCP code — use process.stderr.write

Output each file in full. First line of each file: // path/to/file.ts`;

  const implCode = await llmCall(implPrompt, sys, llm, log);
  if (!implCode) return { completed: false, blocked: true, step: 'write-impl', note: 'LLM unavailable' };

  // Parse and write files (// path.ts pattern)
  // Guard: only write files listed in files_to_create, or genuinely new paths.
  // Never overwrite an existing file unless it's explicitly in files_affected.
  const allowedNew = new Set(newFiles.map(f => f.path));
  const allowedEdit = new Set(affectedFiles(task));

  const implFiles: string[] = [];
  const fileBlocks = implCode.split(/(?=^\/\/ \S)/m).filter(b => b.trim());
  for (const block of fileBlocks) {
    const pathMatch = block.match(/^\/\/ ([\w\-/.]+\.[a-z]+)/m);
    if (!pathMatch) continue;
    const filePath = pathMatch[1];
    const exists   = existsSync(join(cwd, filePath));

    // Reject writes to existing files not explicitly allowed
    if (exists && !allowedEdit.has(filePath)) {
      log(`  [guard] BLOCKED write to existing file: ${filePath} (not in files_affected)`);
      continue;
    }
    // If files_to_create was specified, only allow those new paths
    if (!exists && allowedNew.size > 0 && !allowedNew.has(filePath)) {
      log(`  [guard] BLOCKED new file not in files_to_create: ${filePath}`);
      continue;
    }

    const content = block.replace(/^\/\/ [\w\-/.]+\.[a-z]+\n/, '');
    run(`mkdir -p $(dirname ${filePath})`, cwd, log);
    run(`cat > ${filePath} << 'CRUX_EOF'\n${content}\nCRUX_EOF`, cwd, log);
    implFiles.push(filePath);
    log(`  [write] ${filePath}`);
  }

  // 5. Commit implementation
  log('\n[step 5/9] commit implementation');
  stepCommit(ctx, `feat(${task.slug}): implement`, implFiles);

  // 6. TypeScript check (fix loop, max 3 attempts)
  log('\n[step 6/9] tsc check');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { ok, output } = stepTsc(ctx);
    if (ok) break;
    if (attempt === 3) return { completed: false, blocked: true, step: 'tsc', note: `tsc errors after 3 fix attempts:\n${output.slice(0, 300)}` };

    log(`\n[step 6/9] LLM: fix tsc errors (attempt ${attempt})`);
    const fixPrompt = `Fix these TypeScript errors in the crux project:\n${output}\nOutput fixed file contents only. First line of each file: // PATH`;
    const fixCode = await llmCall(fixPrompt, sys, llm, log);
    if (!fixCode) break;
    const fixBlocks = fixCode.split(/(?=^\/\/ \S)/m).filter(b => b.trim());
    const fixedFiles: string[] = [];
    for (const block of fixBlocks) {
      const pm = block.match(/^\/\/ ([\w\-/.]+\.[a-z]+)/m);
      if (!pm) continue;
      const content = block.replace(/^\/\/ [\w\-/.]+\.[a-z]+\n/, '');
      run(`cat > ${pm[1]} << 'CRUX_EOF'\n${content}\nCRUX_EOF`, cwd, log);
      fixedFiles.push(pm[1]);
    }
    stepCommit(ctx, `fix(${task.slug}): tsc errors attempt ${attempt}`, fixedFiles);
  }

  // 7. Run tests (fix loop, max 3 attempts)
  log('\n[step 7/9] run tests');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { ok, output } = stepRunTests(ctx);
    if (ok) break;
    if (attempt === 3) return { completed: false, blocked: true, step: 'tests', note: `tests failing after 3 fix attempts:\n${output.slice(0, 300)}` };

    log(`\n[step 7/9] LLM: fix test failures (attempt ${attempt})`);
    const fixPrompt = `Fix failing tests in the crux project.\nTest output:\n${output}\nOutput fixed file contents only. First line of each file: // PATH`;
    const fixCode = await llmCall(fixPrompt, sys, llm, log);
    if (!fixCode) break;
    const fixBlocks = fixCode.split(/(?=^\/\/ \S)/m).filter(b => b.trim());
    const fixedFiles: string[] = [];
    for (const block of fixBlocks) {
      const pm = block.match(/^\/\/ ([\w\-/.]+\.[a-z]+)/m);
      if (!pm) continue;
      const content = block.replace(/^\/\/ [\w\-/.]+\.[a-z]+\n/, '');
      run(`cat > ${pm[1]} << 'CRUX_EOF'\n${content}\nCRUX_EOF`, cwd, log);
      fixedFiles.push(pm[1]);
    }
    stepCommit(ctx, `fix(${task.slug}): test failures attempt ${attempt}`, fixedFiles);
  }

  // 8. Push
  log('\n[step 8/9] push');
  stepPush(ctx);

  // 8.5 Open PR + wait for CI checks (skipped entirely when no gh_repo is configured)
  if (proj.gh_repo) {
    log('\n[step 8.5/9] open PR + wait for CI checks');
    stepOpenPr(ctx);
    const { outcome, output } = stepWaitForChecks(ctx);
    if (outcome === 'failure') {
      updateTaskStatus(db, proj.id, task.slug, 'blocked');
      logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.blocked', detail: `CI checks failed:\n${output.slice(0, 300)}`, actor: 'crux-auto' });
      return { completed: false, blocked: true, step: 'ci-checks', note: output.slice(0, 300) };
    }
  }

  // 9. Mark done
  log('\n[step 9/9] mark done');
  updateTaskStatus(db, proj.id, task.slug, 'done');
  logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.done', detail: `tdd workflow completed`, actor: 'crux-auto' });

  return { completed: true, blocked: false, step: 'done' };
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW: writing
// Steps: branch → LLM outline → commit → LLM draft → commit → push → done
// ══════════════════════════════════════════════════════════════════════════════

async function writingWorkflow(ctx: StepContext): Promise<WorkflowResult> {
  const { task, proj, db, log, llm, cwd } = ctx;
  const sys = baseSystemPrompt(task, proj, db, cwd, task.status === 'in-progress');

  log('\n[step 1/4] create branch');
  if (!stepBranch(ctx)) return { completed: false, blocked: true, step: 'branch', note: 'git branch failed' };

  log('\n[step 2/4] LLM: draft document');
  const draftPrompt = `Write the following document for the crux project:
Task: ${task.slug} — ${task.title}
Description: ${task.description ?? ''}
Output the document content only. First line: // docs/PATH.md`;

  const draft = await llmCall(draftPrompt, sys, llm, log);
  if (!draft) return { completed: false, blocked: true, step: 'draft', note: 'LLM unavailable' };

  const pathMatch = draft.match(/^\/\/ (docs\/[\w\-/.]+\.md)/m);
  const docPath   = pathMatch ? pathMatch[1] : `docs/${task.slug}.md`;
  const content   = draft.replace(/^\/\/ docs\/[\w\-/.]+\.md\n/, '');
  run(`mkdir -p $(dirname ${docPath})`, cwd, log);
  run(`cat > ${docPath} << 'CRUX_EOF'\n${content}\nCRUX_EOF`, cwd, log);
  log(`  [write] ${docPath}`);

  log('\n[step 3/4] commit + push');
  stepCommit(ctx, `docs(${task.slug}): draft`, [docPath]);
  stepPush(ctx);

  log('\n[step 4/4] mark done');
  updateTaskStatus(db, proj.id, task.slug, 'done');
  logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.done', detail: 'writing workflow completed', actor: 'crux-auto' });

  return { completed: true, blocked: false, step: 'done' };
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW: research
// Steps: branch → LLM research summary → write ADR → commit → push → done
// ══════════════════════════════════════════════════════════════════════════════

async function researchWorkflow(ctx: StepContext): Promise<WorkflowResult> {
  const { task, proj, db, log, llm, cwd } = ctx;
  const sys = baseSystemPrompt(task, proj, db, cwd, task.status === 'in-progress');

  log('\n[step 1/3] create branch');
  if (!stepBranch(ctx)) return { completed: false, blocked: true, step: 'branch', note: 'git branch failed' };

  log('\n[step 2/3] LLM: research + decision');
  const resPrompt = `Research and write an Architecture Decision Record (ADR) for:
Task: ${task.slug} — ${task.title}
Description: ${task.description ?? ''}
Output JSON only:
{"title":"...","context":"...","decision":"...","consequences":"..."}`;

  const adrJson = await llmCall(resPrompt, sys, llm, log);
  if (!adrJson) return { completed: false, blocked: true, step: 'research', note: 'LLM unavailable' };

  const docPath = `docs/adr/${task.slug}.md`;
  run(`mkdir -p docs/adr`, cwd, log);
  run(`cat > ${docPath} << 'CRUX_EOF'\n# ADR: ${task.title}\n\n${adrJson}\nCRUX_EOF`, cwd, log);

  log('\n[step 3/3] commit + push + done');
  stepCommit(ctx, `research(${task.slug}): ADR draft`, [docPath]);
  stepPush(ctx);
  updateTaskStatus(db, proj.id, task.slug, 'done');
  logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.done', detail: 'research workflow completed', actor: 'crux-auto' });

  return { completed: true, blocked: false, step: 'done' };
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW: verification
// Steps: run tests → check coverage → V-model gate → mark done/blocked
// ══════════════════════════════════════════════════════════════════════════════

async function verificationWorkflow(ctx: StepContext): Promise<WorkflowResult> {
  const { task, proj, db, log } = ctx;

  log('\n[step 1/2] run tests');
  const { ok, output } = stepRunTests(ctx);

  if (!ok) {
    updateTaskStatus(db, proj.id, task.slug, 'blocked');
    logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.blocked', detail: `tests failed:\n${output.slice(0, 300)}`, actor: 'crux-auto' });
    return { completed: false, blocked: true, step: 'tests', note: output.slice(0, 300) };
  }

  log('\n[step 2/2] mark done');
  updateTaskStatus(db, proj.id, task.slug, 'done');
  logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.done', detail: 'verification passed', actor: 'crux-auto' });
  return { completed: true, blocked: false, step: 'done' };
}

// ══════════════════════════════════════════════════════════════════════════════
// Router
// ══════════════════════════════════════════════════════════════════════════════

export async function runWorkflow(
  db: DatabaseSync,
  proj: Project,
  task: Task,
  opts: { ctxTokens?: number } = {},
): Promise<WorkflowResult> {
  const config   = loadConfig();
  const endpoint = config.llm?.endpoint ?? 'http://localhost:8080/v1/chat/completions';
  const model    = (config.llm?.model && config.llm.model !== 'llama3.2' && config.llm.model !== 'local')
    ? config.llm.model
    : 'bartowski/Qwen_Qwen3.5-35B-A3B-GGUF:Q4_K_M';

  const log = (s: string) => process.stderr.write(s + '\n');
  const branch = `feat/${task.slug}`;

  const sess = activeSession(db, proj.id);
  const containerName = sess?.container_name ?? null;

  const resuming = task.status === 'in-progress';
  const executor = task.executor ?? 'auto';

  // Isolate this task's checkout in a sibling git worktree so it never collides
  // with another in-flight task's uncommitted state in the primary checkout —
  // reuse an existing worktree when resuming, create one for new non-human tasks,
  // fall back to the primary checkout (old in-place behavior) if that fails.
  const repoRoot = proj.repo_path ?? findRepoRoot() ?? process.cwd();
  let cwd = repoRoot;
  let usingWorktree = false;

  if (executor !== 'human') {
    if (task.worktree_path && existsSync(task.worktree_path)) {
      cwd = task.worktree_path;
      usingWorktree = true;
    } else if (!resuming) {
      const wt = createTaskWorktree(repoRoot, task.slug);
      if (wt.ok && wt.path) {
        cwd = wt.path;
        usingWorktree = true;
        updateTaskWorktreePath(db, task.id, wt.path);
      } else {
        log(`  [workflow] worktree creation failed (${wt.out}) — falling back to in-place checkout in ${repoRoot}`);
      }
    }
  }

  // Snapshot dirty state BEFORE any step writes anything — everything listed
  // here belongs to someone else, and must not end up in this run's commits.
  const preexistingDirty = dirtyPaths(cwd);

  const ctx: StepContext = {
    db, proj, task, branch, cwd, usingWorktree, log, preexistingDirty,
    llm: { endpoint, model, ctxTokens: opts.ctxTokens ?? 6000 },
    containerName,
  };

  log(`\ncrux workflow → ${task.slug} [${task.task_type}] executor:${executor}${resuming ? ' (RESUMING)' : ''}`);
  log(`branch: ${branch}`);
  log(`cwd:    ${cwd}${usingWorktree ? ' (isolated worktree)' : ''}`);
  if (preexistingDirty.length > 0) {
    log(`dirty:  ${preexistingDirty.length} pre-existing modified path(s) — excluded from this run's commits`);
  }
  log(`model:  ${model}\n`);

  // ── Human tasks: skip entirely, surface in human_queue ────────────────────
  if (executor === 'human') {
    log(`  [workflow] HUMAN TASK — requires manual action`);
    logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.human-queued', detail: task.acceptance_criteria ?? task.title, actor: 'crux-auto' });
    return { completed: false, blocked: false, step: 'human-queued', note: `Requires human action: ${task.title}` };
  }

  if (!resuming) {
    updateTaskStatus(db, proj.id, task.slug, 'in-progress');
    logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.in-progress', detail: `${task.task_type} workflow started`, actor: 'crux-auto' });
  } else {
    logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.in-progress', detail: `${task.task_type} workflow resumed`, actor: 'crux-auto' });
  }

  // ── Hybrid tasks: LLM drafts, then pauses for human review ───────────────
  // Workflow runs normally but the final mark-done step is skipped;
  // task stays in-progress with sub_status 'draft-ready' for human approval.
  const isHybrid = executor === 'hybrid';

  switch (task.task_type) {
    case 'coding':       return tddWorkflow(ctx);
    case 'writing':      return writingWorkflow(ctx);
    case 'research':     return researchWorkflow(ctx);
    case 'verification': return verificationWorkflow(ctx);
    default:
      // accounting, design, other → fall back to free-form agent
      log(`[workflow] no specific workflow for '${task.task_type}' — using free-form agent`);
      const { runAgent } = await import('./agent.ts');
      const result = await runAgent(db, proj, task.slug, { ctxTokens: opts.ctxTokens });
      return {
        completed: result.completed,
        blocked:   result.blocked,
        step:      result.completed ? 'done' : 'agent',
        note:      result.finalNote,
      };
  }
}
