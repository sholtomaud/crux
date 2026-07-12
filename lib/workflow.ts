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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './ask.ts';
import { updateTaskStatus, logAudit, listAdrs, dependenciesByProject, tasksByProject, activeSession } from './db.ts';
import type { Project, Task, TaskType } from './db.ts';
import { readDbSignatures, readTestPattern } from './codebase.ts';

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

function baseSystemPrompt(task: Task, proj: Project, db: DatabaseSync, resuming = false): string {
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
  const cwd = process.cwd();

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

  // DB signatures from modular lib/db/*.ts
  const dbSigs = readDbSignatures(cwd);

  return `You are an expert TypeScript/Node.js engineer working on the crux project.

## Project conventions
- DB layer: lib/db/<domain>.ts — one file per domain (roi.ts, tasks.ts, sessions.ts, etc.)
- New DB functions: create a new file lib/db/<domain>.ts, then add its export to lib/db/index.ts
- Do NOT edit lib/db.ts (it is a one-line re-export shim — do not add code there)
- All DB functions take (db: DatabaseSync, ...) as first arg — use openDb() in CLI, pass db in tests
- Tests: node:test + node:assert/strict, in-memory DB via new DatabaseSync(':memory:'), load schema.sql
- Schema changes: schema.sql AND applyMigrations() in lib/db/open.ts (ALTER TABLE pattern)
- MCP tools: index.ts — use process.stderr.write, never console.log
- Verify: make typecheck | Tests: make test | Never run node/npx/tsc directly

## lib/db exports (real API — use these, do not invent):
${dbSigs}

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
  const { branch, log } = ctx;
  const cwd = process.cwd();

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

function stepCommit(ctx: StepContext, message: string, files: string[]): boolean {
  const { log } = ctx;
  const cwd = process.cwd();
  if (files.length === 0) { log('  [commit] nothing to commit'); return true; }
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
  const { log, proj, containerName } = ctx;
  const cmd = proj.test_cmd ?? (proj.run_env === 'shell' ? 'make test-ci 2>&1' : null);
  if (!cmd) {
    if (proj.run_env === 'container') {
      log('  [test] run_env=container but no test_cmd configured — cannot verify, blocking');
      return { ok: false, output: 'run_env=container requires test_cmd (crux project env --test-cmd "...")' };
    }
    log('  [test] no test_cmd — skipped');
    return { ok: true, output: '(skipped: no test_cmd)' };
  }
  log(`  [test] ${cmd}...`);
  const r = runInEnv(cmd, process.cwd(), containerName, log);
  log(`  [test] ${r.ok ? 'PASS' : 'FAIL'}`);
  return { ok: r.ok, output: filterTestOutput(r.out).slice(0, 2000) };
}

// ── Step: tsc check ───────────────────────────────────────────────────────────

function stepTsc(ctx: StepContext): { ok: boolean; output: string } {
  const { log, proj, containerName } = ctx;
  const cmd = proj.verify_cmd ?? (proj.run_env === 'shell' ? 'make typecheck 2>&1' : null);
  if (!cmd) {
    if (proj.run_env === 'container') {
      log('  [tsc] run_env=container but no verify_cmd configured — cannot verify, blocking');
      return { ok: false, output: 'run_env=container requires verify_cmd (crux project env --verify-cmd "...")' };
    }
    log('  [tsc] no verify_cmd — skipped');
    return { ok: true, output: '(skipped: no verify_cmd)' };
  }
  log(`  [tsc] ${cmd}...`);
  const r = runInEnv(cmd, process.cwd(), containerName, log);
  log(`  [tsc] ${r.ok ? 'OK' : 'errors'}`);
  return { ok: r.ok, output: filterTscOutput(r.out).slice(0, 2000) };
}

// ── Step: push branch ─────────────────────────────────────────────────────────

function stepPush(ctx: StepContext): boolean {
  const { branch, log } = ctx;
  const r = git(['push', '-u', 'origin', branch], process.cwd(), log);
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
  const { log, proj } = ctx;
  if (!proj.gh_repo) return { outcome: 'none', output: '(no gh_repo configured)' };

  const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
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
  const { task, proj, db, log, llm } = ctx;
  const resuming = task.status === 'in-progress';
  const sys = baseSystemPrompt(task, proj, db, resuming);

  // 1. Branch
  log('\n[step 1/9] create branch');
  if (!stepBranch(ctx)) return { completed: false, blocked: true, step: 'branch', note: 'git branch failed' };

  // 2. LLM: write tests
  log('\n[step 2/9] LLM: write tests');
  const testPattern = readTestPattern(process.cwd());
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
  run(`mkdir -p $(dirname ${testPath})`, process.cwd(), log);
  run(`cat > ${testPath} << 'CRUX_EOF'\n${testContent}\nCRUX_EOF`, process.cwd(), log);
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
  const cwd = process.cwd();

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
      run(`cat > ${pm[1]} << 'CRUX_EOF'\n${content}\nCRUX_EOF`, process.cwd(), log);
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
      run(`cat > ${pm[1]} << 'CRUX_EOF'\n${content}\nCRUX_EOF`, process.cwd(), log);
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
  const { task, proj, db, log, llm } = ctx;
  const sys = baseSystemPrompt(task, proj, db, task.status === 'in-progress');

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
  run(`mkdir -p $(dirname ${docPath})`, process.cwd(), log);
  run(`cat > ${docPath} << 'CRUX_EOF'\n${content}\nCRUX_EOF`, process.cwd(), log);
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
  const { task, proj, db, log, llm } = ctx;
  const sys = baseSystemPrompt(task, proj, db, task.status === 'in-progress');

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
  run(`mkdir -p docs/adr`, process.cwd(), log);
  run(`cat > ${docPath} << 'CRUX_EOF'\n# ADR: ${task.title}\n\n${adrJson}\nCRUX_EOF`, process.cwd(), log);

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

  const ctx: StepContext = {
    db, proj, task, branch, log,
    llm: { endpoint, model, ctxTokens: opts.ctxTokens ?? 6000 },
    containerName,
  };

  const resuming = task.status === 'in-progress';
  const executor = task.executor ?? 'auto';

  log(`\ncrux workflow → ${task.slug} [${task.task_type}] executor:${executor}${resuming ? ' (RESUMING)' : ''}`);
  log(`branch: ${branch}`);
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
