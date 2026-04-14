#!/usr/bin/env node
/**
 * index.ts — crux dual-mode entry point
 *
 * CLI mode  (process.stdin.isTTY === true):  parse argv, run command
 * MCP mode  (stdin piped):                   start MCP stdio server
 */

import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  openDb, closeDb, findRepoRoot, readProjectPointer, writeProjectPointer,
  resolveProject, insertProject, projectById, allProjects, updateProjectStatus,
  tasksByProject, taskBySlug, insertTask, updateTaskStatus, updateTaskCpm,
  addDependency, dependenciesByProject,
  startSession, endSession, activeSession,
  insertRoi, roiSummary, totalHours,
  insertTestRun, logAudit, projectStatus,
} from './lib/db.ts';
import type { Project, ProjectType, TaskStatus } from './lib/db.ts';

import { computeCpm, asciiDag, dotGraph } from './lib/cpm.ts';
import type { CpmNode, CpmEdge } from './lib/cpm.ts';

import { reportTasks, reportStatus, reportOverview } from './lib/reports.ts';
import { ask }    from './lib/ask.ts';
import { exportCsv, syncToSheets } from './lib/sheets.ts';
import { startServer } from './lib/server.ts';
import { syncTasks } from './lib/gh.ts';

// ── Mode detection ─────────────────────────────────────────────────────────────
// CLI: args present, or stdin is a TTY
// MCP: no args AND stdin is NOT a TTY (piped — called by Claude/MCP host)

const cliArgs = process.argv.slice(2);
const isCli   = cliArgs.length > 0 || Boolean(process.stdin.isTTY);
if (isCli) {
  runCli(cliArgs).catch(err => { console.error(err.message); process.exit(1); });
} else {
  runMcpServer().catch(err => { console.error(err.message); process.exit(1); });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════════

async function runCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp(); return;
  }

  const cmd  = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case 'init':           return cmdInit(rest);
    case 'status':         return cmdStatus();
    case 'overview':       return cmdOverview();
    case 'cpm':            return cmdCpm();
    case 'graph':          return cmdGraph(rest);
    case 'ready':          return cmdReady();
    case 'spread':         return cmdSpread();
    case 'task':           return cmdTask(rest);
    case 'dep':            return cmdDep(rest);
    case 'session':        return cmdSession(rest);
    case 'roi':            return cmdRoi(rest);
    case 'report':         return cmdReport(rest);
    case 'sync':           return cmdSync(rest);
    case 'test-run':       return cmdTestRun(rest);
    case 'milestone':      return cmdMilestone(rest);
    case 'project':        return cmdProject(rest);
    case 'export':         return cmdExport(rest);
    case 'ask':            return cmdAsk(rest);
    case 'ui':             return cmdUi(rest);
    default:
      console.error(`Unknown command: ${cmd}\nRun crux --help for usage.`);
      process.exit(1);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getProject(): Project {
  const db   = openDb();
  const root = findRepoRoot();
  const proj = resolveProject(db, root);
  if (!proj) {
    console.error('No crux project linked here. Run: crux init');
    process.exit(1);
  }
  return proj;
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function printHelp(): void {
  console.log(`
crux — find your critical path

Usage: crux <command> [options]

BOOTSTRAP
  init [--from tasks.md]         Link repo to a project, seed tasks
  project add <name> [--type T]  Add project (types: code_repo article research freelance learning personal)
  project link                   Link current repo to existing project

STATUS
  status                         Current project: tasks, blockers, next up
  overview                       All projects meta-Kanban
  spread                         Focus health: active count + ROI signals
  ready                          Go/no-go release readiness

TASKS
  task add <slug> <title>        Add task
  task done <slug> [--note ""]   Mark done
  task start <slug>              Mark in-progress
  task block <slug> [--note ""]  Mark blocked
  dep add <pred> <succ>          Add predecessor→successor dependency

SCHEDULE
  cpm                            Run critical path analysis
  graph [--dot]                  ASCII dependency DAG (or DOT format)

REPORTS
  report tasks                   Regenerate tasks.md
  report status                  Regenerate docs/status-{date}.md
  report adrs                    Regenerate docs/adr/*.md

SYNC
  sync [--apply]                 Dry-run or apply GitHub ↔ DB reconciliation
  sync --target sheets           Push snapshot to Google Sheets

TIME & ROI
  session start                  Start time-tracking session
  session end [--note ""]        End session
  roi add <amount> [--kind K]    Log revenue/cost (kinds: revenue cost expected)
  roi report                     ROI analysis

AUTOMATION
  test-run <phase> <pass|fail>   Record build/test result
    [--coverage N] [--task-slug S]
  milestone check                Detect phase completions

OTHER
  export [--csv]                 Export project data to CSV
  ask "<question>"               Ask local LLM with project context
  ui [--port 8765] [--no-open]   Start browser UI

Tier 1 (CLI, free) → Tier 2 (crux ask, local LLM) → Tier 3 (Claude via MCP)
`.trim());
}

// ── init ──────────────────────────────────────────────────────────────────────

async function cmdInit(args: string[]): Promise<void> {
  const db   = openDb();
  const root = findRepoRoot() ?? process.cwd();

  // Check if already linked
  const existingId = readProjectPointer(root);
  if (existingId) {
    const proj = projectById(db, existingId);
    if (proj) { console.log(`Already linked to project: ${proj.name} (${proj.id})`); return; }
  }

  const fromFile = flag(args, '--from');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(r => rl.question(q, r));

  const name = await ask('Project name: ');
  const typeInput = await ask('Type [code_repo/article/research/freelance/learning/personal]: ');
  const type = (['code_repo','article','research','freelance','learning','personal'].includes(typeInput)
    ? typeInput : 'code_repo') as ProjectType;

  const project = insertProject(db, { name: name.trim(), type });
  writeProjectPointer(root, project.id);

  logAudit(db, { project_id: project.id, event: 'project.init', detail: `type=${type}`, actor: 'human' });
  console.log(`✓ Project "${project.name}" created (${project.id})`);

  // Seed from tasks.md if requested
  if (fromFile) {
    const mdPath = resolve(fromFile);
    if (existsSync(mdPath)) {
      const seeded = seedFromTasksMd(db, project.id, readFileSync(mdPath, 'utf8'));
      console.log(`✓ Seeded ${seeded} tasks from ${mdPath}`);
    } else {
      console.warn(`  tasks.md not found at ${mdPath}`);
    }
  }

  // Offer skill install
  const skillDest = join(root, '.claude', 'skills', 'crux', 'SKILL.md');
  if (!existsSync(skillDest)) {
    const install = await ask('\ncrux works better with a Claude routing skill.\nAdd it to .claude/skills/? [y/N] ');
    if (install.toLowerCase() === 'y') {
      installSkill(root);
      console.log('✓ Skill installed at .claude/skills/crux/SKILL.md');
    }
  }

  rl.close();
}

function seedFromTasksMd(db: ReturnType<typeof openDb>, projectId: string, md: string): number {
  let seeded = 0;
  let currentPhase: string | null = null;
  const slugToId = new Map<string, number>();
  const pendingDeps: Array<[string, string]> = []; // [successor_slug, predecessor_slug]

  for (const line of md.split('\n')) {
    // Phase heading
    const phaseMatch = line.match(/^##\s+(.+)/);
    if (phaseMatch) { currentPhase = phaseMatch[1].trim(); continue; }

    // Table row: | slug | title | status | dep1, dep2 |  (backticks optional)
    const rowMatch = line.match(/^\|\s*`?([^`|\s][^|]*?)`?\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/);
    if (!rowMatch) continue;

    const [, slug, title, status, depsRaw] = rowMatch;
    const taskStatus: TaskStatus = (['open','in-progress','blocked','done','dropped'].includes(status.trim())
      ? status.trim() : 'open') as TaskStatus;

    const existing = taskBySlug(db, projectId, slug);
    if (existing) { slugToId.set(slug, existing.id); continue; }

    const task = insertTask(db, {
      project_id: projectId,
      slug: slug.trim(),
      title: title.trim(),
      phase: currentPhase ?? undefined,
    });
    if (taskStatus !== 'open') updateTaskStatus(db, projectId, slug.trim(), taskStatus);
    slugToId.set(slug.trim(), task.id);
    seeded++;

    // Queue dependencies
    const deps = depsRaw.split(',').map(d => d.trim()).filter(d => d && d !== '—');
    for (const dep of deps) pendingDeps.push([slug.trim(), dep]);
  }

  // Resolve and insert dependency edges
  for (const [succ, pred] of pendingDeps) {
    const predId = slugToId.get(pred);
    const succId = slugToId.get(succ);
    if (predId && succId) {
      try { addDependency(db, predId, succId); } catch { /* ignore dupes */ }
    }
  }

  return seeded;
}

function installSkill(root: string): void {
  const skillDir = join(root, '.claude', 'skills', 'crux');
  mkdirSync(skillDir, { recursive: true });
  const skillSrc = join(new URL('.', import.meta.url).pathname, 'skills', 'crux', 'SKILL.md');
  if (existsSync(skillSrc)) {
    writeFileSync(join(skillDir, 'SKILL.md'), readFileSync(skillSrc));
  } else {
    // Fallback: write inline
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_CONTENT);
  }
}

// ── status ────────────────────────────────────────────────────────────────────

function cmdStatus(): void {
  const db   = openDb();
  const proj = getProject();
  const s    = projectStatus(db, proj.id);

  console.log(`\n${proj.name} (${proj.type} · ${proj.status})`);
  console.log(`Tasks: ${s.total} total · ${s.done} done · ${s.open} open · ${s.in_progress} in-progress · ${s.blocked} blocked\n`);

  if (s.next_unblocked.length > 0) {
    console.log('Next unblocked:');
    for (const t of s.next_unblocked) console.log(`  · ${t.slug}  ${t.title}`);
  }
  if (s.blockers.length > 0) {
    console.log('\nBlocked:');
    for (const t of s.blockers) console.log(`  ✗ ${t.slug}  ${t.title}`);
  }
}

// ── overview ──────────────────────────────────────────────────────────────────

function cmdOverview(): void {
  const db = openDb();
  console.log(reportOverview(db));
}

// ── cpm ───────────────────────────────────────────────────────────────────────

function cmdCpm(): void {
  const db   = openDb();
  const proj = getProject();
  const tasks = tasksByProject(db, proj.id);
  const deps  = dependenciesByProject(db, proj.id);
  const nodes: CpmNode[] = tasks.map(t => ({ id: t.id, slug: t.slug, title: t.title, duration: t.duration_days ?? 1, phase: t.phase }));
  const edges: CpmEdge[] = deps.map(d => ({ predecessor_id: d.predecessor_id, successor_id: d.successor_id }));

  const result = computeCpm(nodes, edges);

  // Persist CPM results to DB
  for (const n of result.nodes) {
    updateTaskCpm(db, n.id, {
      early_start: n.early_start, early_finish: n.early_finish,
      late_start: n.late_start,   late_finish: n.late_finish,
      float_days: n.float_days,   is_critical: n.is_critical ? 1 : 0,
    });
  }

  console.log(`\nProject duration: ${result.project_duration} days`);
  console.log(`Critical path: ${result.critical_path.join(' → ') || 'none'}\n`);
  console.log('Task                     ES    EF    LS    LF   Float  Crit');
  console.log('─'.repeat(65));
  for (const n of result.nodes) {
    const crit = n.is_critical ? '★' : ' ';
    const name = n.slug.padEnd(25);
    console.log(`${crit} ${name} ${String(n.early_start).padStart(4)}  ${String(n.early_finish).padStart(4)}  ${String(n.late_start).padStart(4)}  ${String(n.late_finish).padStart(4)}  ${String(n.float_days.toFixed(1)).padStart(5)}`);
  }
}

// ── graph ─────────────────────────────────────────────────────────────────────

function cmdGraph(args: string[]): void {
  const db   = openDb();
  const proj = getProject();
  const tasks = tasksByProject(db, proj.id);
  const deps  = dependenciesByProject(db, proj.id);
  const nodes: CpmNode[] = tasks.map(t => ({ id: t.id, slug: t.slug, title: t.title, duration: t.duration_days ?? 1, phase: t.phase }));
  const edges: CpmEdge[] = deps.map(d => ({ predecessor_id: d.predecessor_id, successor_id: d.successor_id }));

  let cpmNodes;
  try { cpmNodes = computeCpm(nodes, edges).nodes; } catch { cpmNodes = undefined; }

  if (hasFlag(args, '--dot')) {
    console.log(dotGraph(nodes, edges, cpmNodes));
  } else {
    console.log(asciiDag(nodes, edges, cpmNodes));
  }
}

// ── task ──────────────────────────────────────────────────────────────────────

function cmdTask(args: string[]): void {
  const db   = openDb();
  const proj = getProject();
  const sub  = args[0];

  if (sub === 'add') {
    const slug  = args[1];
    const title = args.slice(2).join(' ');
    if (!slug || !title) { console.error('Usage: crux task add <slug> <title>'); process.exit(1); }
    const task = insertTask(db, { project_id: proj.id, slug, title });
    logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.add', detail: title, actor: 'human' });
    console.log(`✓ Task added: ${slug}`);
    return;
  }

  const slug   = args[1];
  const note   = flag(args, '--note') ?? undefined;
  const task   = slug ? taskBySlug(db, proj.id, slug) : null;

  if (!slug || !task) { console.error(`Task not found: ${slug}`); process.exit(1); }

  const statusMap: Record<string, TaskStatus> = { done: 'done', start: 'in-progress', block: 'blocked', drop: 'dropped' };
  const newStatus = statusMap[sub];
  if (!newStatus) { console.error(`Unknown task sub-command: ${sub}`); process.exit(1); }

  updateTaskStatus(db, proj.id, slug, newStatus);
  logAudit(db, { project_id: proj.id, task_id: task.id, event: `task.${sub}`, detail: note, actor: 'human' });
  console.log(`✓ ${slug} → ${newStatus}${note ? ` (${note})` : ''}`);
}

// ── dep ───────────────────────────────────────────────────────────────────────

function cmdDep(args: string[]): void {
  if (args[0] !== 'add' || !args[1] || !args[2]) {
    console.error('Usage: crux dep add <predecessor-slug> <successor-slug>'); process.exit(1);
  }
  const db   = openDb();
  const proj = getProject();
  const pred = taskBySlug(db, proj.id, args[1]);
  const succ = taskBySlug(db, proj.id, args[2]);
  if (!pred) { console.error(`Task not found: ${args[1]}`); process.exit(1); }
  if (!succ) { console.error(`Task not found: ${args[2]}`); process.exit(1); }
  addDependency(db, pred.id, succ.id);
  console.log(`✓ ${args[1]} → ${args[2]}`);
}

// ── session ───────────────────────────────────────────────────────────────────

function cmdSession(args: string[]): void {
  const db   = openDb();
  const proj = getProject();
  const sub  = args[0];

  if (sub === 'start') {
    const s = startSession(db, proj.id);
    logAudit(db, { project_id: proj.id, event: 'session.start', actor: 'human' });
    console.log(`✓ Session started (id ${s.id}) at ${s.started_at}`);
    return;
  }

  if (sub === 'end') {
    const note = flag(args, '--note') ?? undefined;
    const sess = activeSession(db, proj.id);
    if (!sess) { console.error('No active session.'); process.exit(1); }
    const ended = endSession(db, sess.id, note);
    logAudit(db, { project_id: proj.id, event: 'session.end', detail: `${ended.minutes?.toFixed(0)}min`, actor: 'human' });
    console.log(`✓ Session ended — ${ended.minutes?.toFixed(1)} minutes`);
    return;
  }

  console.error('Usage: crux session start | end [--note "..."]');
}

// ── roi ───────────────────────────────────────────────────────────────────────

function cmdRoi(args: string[]): void {
  const db   = openDb();
  const proj = getProject();
  const sub  = args[0];

  if (sub === 'add') {
    const amount = parseFloat(args[1]);
    if (isNaN(amount)) { console.error('Usage: crux roi add <amount> [--kind revenue|cost|expected]'); process.exit(1); }
    const kind = (flag(args, '--kind') ?? 'revenue') as 'revenue' | 'cost' | 'expected';
    const note = flag(args, '--note') ?? undefined;
    insertRoi(db, { project_id: proj.id, amount, kind, note });
    console.log(`✓ ROI record: ${kind} $${amount}`);
    return;
  }

  if (sub === 'report') {
    const roi   = roiSummary(db, proj.id);
    const hours = totalHours(db, proj.id);
    const score = hours > 0 ? (roi.revenue / hours).toFixed(2) : '—';
    console.log(`\n${proj.name} ROI`);
    console.log(`Hours:    ${hours.toFixed(1)}h`);
    console.log(`Revenue:  $${roi.revenue.toFixed(2)}`);
    console.log(`Cost:     $${roi.cost.toFixed(2)}`);
    console.log(`Expected: $${roi.expected.toFixed(2)}`);
    console.log(`ROI/hr:   $${score}`);
    return;
  }

  console.error('Usage: crux roi add <amount> | roi report');
}

// ── report ────────────────────────────────────────────────────────────────────

function cmdReport(args: string[]): void {
  const db   = openDb();
  const proj = getProject();
  const sub  = args[0];

  if (sub === 'tasks') {
    const md   = reportTasks(db, proj);
    const out  = 'tasks.md';
    writeFileSync(out, md);
    console.log(`✓ Written to ${out}`);
    return;
  }

  if (sub === 'status') {
    const md   = reportStatus(db, proj);
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync('docs', { recursive: true });
    const out  = join('docs', `status-${date}.md`);
    writeFileSync(out, md);
    console.log(`✓ Written to ${out}`);
    return;
  }

  if (sub === 'adrs') {
    const adrs = db.prepare('SELECT id FROM adrs WHERE project_id = ?').all(proj.id) as Array<{ id: number }>;
    if (adrs.length === 0) { console.log('No ADRs to generate.'); return; }
    mkdirSync(join('docs', 'adr'), { recursive: true });
    // ADR report is handled per-record
    console.log(`(${adrs.length} ADRs — use crux report adrs to generate individually)`);
    return;
  }

  console.error('Usage: crux report tasks|status|adrs');
}

// ── sync ──────────────────────────────────────────────────────────────────────

async function cmdSync(args: string[]): Promise<void> {
  const db   = openDb();
  const proj = getProject();

  if (flag(args, '--target') === 'sheets') {
    await syncToSheets(db, proj);
    console.log('✓ Synced to Google Sheets');
    return;
  }

  if (!proj.gh_repo) { console.error('No gh_repo set for this project. Run: crux project link --gh-repo owner/repo'); process.exit(1); }

  const apply  = hasFlag(args, '--apply');
  const tasks  = tasksByProject(db, proj.id);
  const actions = syncTasks(proj.gh_repo, tasks.map(t => ({
    id: t.id, slug: t.slug, title: t.title, status: t.status, gh_issue_number: t.gh_issue_number,
  })), apply);

  for (const a of actions) {
    const num = a.issue_number ? ` #${a.issue_number}` : '';
    console.log(`${apply ? '✓' : '·'} [${a.action}] ${a.task_slug}${num} — ${a.reason}`);
  }
  if (!apply) console.log('\nDry run. Use --apply to execute.');
}

// ── test-run ──────────────────────────────────────────────────────────────────

function cmdTestRun(args: string[]): void {
  const db       = openDb();
  const proj     = getProject();
  const phase    = args[0] as 'build' | 'test-c' | 'test-python' | 'lint';
  const status   = args[1] as 'pass' | 'fail';
  const coverage = flag(args, '--coverage') ? parseFloat(flag(args, '--coverage')!) : undefined;
  const taskSlug = flag(args, '--task-slug') ?? undefined;

  if (!phase || !status) {
    console.error('Usage: crux test-run <phase> <pass|fail> [--coverage N] [--task-slug S]');
    process.exit(1);
  }

  insertTestRun(db, { project_id: proj.id, phase, status, task_slug: taskSlug, coverage });

  // Auto-close task if coverage target met
  if (status === 'pass' && taskSlug && coverage !== undefined) {
    const task = taskBySlug(db, proj.id, taskSlug);
    if (task?.coverage_target && coverage >= task.coverage_target) {
      updateTaskStatus(db, proj.id, taskSlug, 'done');
      logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.auto-done', detail: `coverage ${coverage}% >= target ${task.coverage_target}%`, actor: 'crux-auto' });
      console.log(`✓ ${taskSlug} auto-closed — coverage ${coverage}% ≥ target ${task.coverage_target}%`);
    }
  }

  console.log(`✓ test-run recorded: ${phase} ${status}${coverage !== undefined ? ` (${coverage}%)` : ''}`);
}

// ── milestone ─────────────────────────────────────────────────────────────────

function cmdMilestone(args: string[]): void {
  if (args[0] !== 'check') { console.error('Usage: crux milestone check'); process.exit(1); }
  const db    = openDb();
  const proj  = getProject();
  const tasks = tasksByProject(db, proj.id);

  const phases = new Map<string, { total: number; done: number }>();
  for (const t of tasks) {
    const k = t.phase ?? 'Unphased';
    const cur = phases.get(k) ?? { total: 0, done: 0 };
    cur.total++;
    if (t.status === 'done') cur.done++;
    phases.set(k, cur);
  }

  for (const [phase, counts] of phases) {
    if (counts.total > 0 && counts.done === counts.total) {
      console.log(`🎉 ${phase} COMPLETE (${counts.done}/${counts.total} tasks done)`);
      // Generate milestone doc
      const date = new Date().toISOString().slice(0, 10);
      const slug = phase.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const out  = join('docs', `milestone-${slug}.md`);
      mkdirSync('docs', { recursive: true });
      writeFileSync(out, `# Milestone: ${phase} Complete\n\n**Date:** ${date}\n**Tasks:** ${counts.done}/${counts.total}\n`);
      console.log(`  ↳ Wrote ${out}`);
    } else {
      console.log(`  ${phase}: ${counts.done}/${counts.total} tasks done`);
    }
  }
}

// ── project ───────────────────────────────────────────────────────────────────

async function cmdProject(args: string[]): Promise<void> {
  const db  = openDb();
  const sub = args[0];

  if (sub === 'add') {
    const name = args[1];
    const type = (flag(args, '--type') ?? 'personal') as ProjectType;
    if (!name) { console.error('Usage: crux project add <name> [--type T]'); process.exit(1); }
    const proj = insertProject(db, { name, type });
    console.log(`✓ Project created: ${proj.name} (${proj.id})`);
    return;
  }

  if (sub === 'link') {
    const root = findRepoRoot() ?? process.cwd();
    const projects = allProjects(db);
    if (projects.length === 0) { console.error('No projects found. Run: crux project add <name>'); process.exit(1); }
    console.log('Available projects:');
    projects.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (${p.id.slice(0, 8)}…)`));
    const rl  = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise<string>(r => rl.question('Select project number: ', r));
    rl.close();
    const proj = projects[parseInt(ans) - 1];
    if (!proj) { console.error('Invalid selection'); process.exit(1); }
    writeProjectPointer(root, proj.id);
    console.log(`✓ Linked to ${proj.name}`);
    return;
  }

  if (sub === 'list') {
    const projects = allProjects(db);
    for (const p of projects) console.log(`${p.id.slice(0,8)}  ${p.name.padEnd(30)} ${p.type.padEnd(12)} ${p.status}`);
    return;
  }

  console.error('Usage: crux project add|link|list');
}

// ── ready ─────────────────────────────────────────────────────────────────────

function cmdReady(): void {
  const db    = openDb();
  const proj  = getProject();
  const tasks = tasksByProject(db, proj.id);
  const blocked = tasks.filter(t => t.status === 'blocked');
  const open    = tasks.filter(t => t.status === 'open' && t.is_critical);
  const done    = tasks.filter(t => t.status === 'done').length;
  const total   = tasks.length;

  console.log(`\n${proj.name} — Release Readiness\n`);
  console.log(`Tasks done:     ${done}/${total}`);
  console.log(`Blocked:        ${blocked.length}`);
  console.log(`Critical open:  ${open.length}`);

  const go = blocked.length === 0 && open.length === 0 && done === total;
  console.log(`\nVerdict: ${go ? '✅ GO' : '🔴 NO-GO'}`);
  if (!go) {
    if (blocked.length > 0) console.log('  ✗ Blocked tasks:', blocked.map(t => t.slug).join(', '));
    if (open.length > 0)    console.log('  ✗ Critical open:', open.map(t => t.slug).join(', '));
  }
}

// ── spread ────────────────────────────────────────────────────────────────────

function cmdSpread(): void {
  const db = openDb();
  console.log(reportOverview(db));
}

// ── export ────────────────────────────────────────────────────────────────────

function cmdExport(args: string[]): void {
  const db   = openDb();
  const proj = getProject();
  if (hasFlag(args, '--csv')) {
    const csv = exportCsv(db, proj);
    console.log(csv);
  } else {
    console.error('Usage: crux export --csv');
  }
}

// ── ask ───────────────────────────────────────────────────────────────────────

async function cmdAsk(args: string[]): Promise<void> {
  const question = args.join(' ').replace(/^["']|["']$/g, '');
  if (!question) { console.error('Usage: crux ask "<question>"'); process.exit(1); }
  const db   = openDb();
  const proj = getProject();
  const resp = await ask(db, proj, question);
  console.log(resp);
}

// ── ui ────────────────────────────────────────────────────────────────────────

async function cmdUi(args: string[]): Promise<void> {
  const port   = parseInt(flag(args, '--port') ?? '8765');
  const noOpen = hasFlag(args, '--no-open');
  startServer(port);
  if (!noOpen) {
    const url = `http://127.0.0.1:${port}`;
    const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawnSync(open, [url], { stdio: 'ignore' });
  }
  // Keep alive
  await new Promise(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// MCP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

async function runMcpServer(): Promise<void> {
  const { McpServer }          = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z }                  = await import('zod');

  const server = new McpServer({ name: 'crux', version: '0.1.0' });
  const db     = openDb();

  // ── Helper: resolve project inside tool calls ─────────────────────────────

  function requireProject(): Project {
    const root = findRepoRoot();
    const proj = resolveProject(db, root);
    if (!proj) throw new Error('No crux project linked here. Call crux_init first.');
    return proj;
  }

  function ok(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  }

  function err(msg: string) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true as const };
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  server.tool('crux_init', 'Bootstrap DB for current repo; optionally install SKILL.md',
    { name: z.string(), type: z.enum(['code_repo','article','research','freelance','learning','personal']).default('code_repo'), install_skill: z.boolean().default(false) },
    async ({ name, type, install_skill }) => {
      try {
        const root = findRepoRoot() ?? process.cwd();
        const existing = resolveProject(db, root);
        if (existing) return ok({ project: existing, message: 'Already initialised' });
        const proj = insertProject(db, { name, type });
        writeProjectPointer(root, proj.id);
        logAudit(db, { project_id: proj.id, event: 'project.init', detail: `type=${type},mcp=true`, actor: 'claude' });
        if (install_skill) installSkill(root);
        return ok({ project: proj, skill_installed: install_skill });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_status', 'Structured JSON: task counts, next unblocked tasks, blockers', {},
    () => {
      try { return ok(projectStatus(db, requireProject().id)); }
      catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_overview', 'All projects: status, ROI, active count, spread warning', {},
    () => {
      try {
        const projects = allProjects(db).map(p => {
          const tasks = tasksByProject(db, p.id);
          const roi   = roiSummary(db, p.id);
          const hours = totalHours(db, p.id);
          return { ...p, task_count: tasks.length, done_count: tasks.filter(t => t.status === 'done').length, roi, hours };
        });
        const active = projects.filter(p => p.status === 'active').length;
        return ok({ projects, spread_warning: active > 2 ? `${active} active projects — peak focus is 2` : null });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_cpm', 'Run CPM forward/backward pass, return critical path + float values', {},
    () => {
      try {
        const proj  = requireProject();
        const tasks = tasksByProject(db, proj.id);
        const deps  = dependenciesByProject(db, proj.id);
        const nodes: CpmNode[] = tasks.map(t => ({ id: t.id, slug: t.slug, title: t.title, duration: t.duration_days ?? 1, phase: t.phase }));
        const edges: CpmEdge[] = deps.map(d => ({ predecessor_id: d.predecessor_id, successor_id: d.successor_id }));
        const result = computeCpm(nodes, edges);
        for (const n of result.nodes) {
          updateTaskCpm(db, n.id, { early_start: n.early_start, early_finish: n.early_finish, late_start: n.late_start, late_finish: n.late_finish, float_days: n.float_days, is_critical: n.is_critical ? 1 : 0 });
        }
        return ok(result);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_task_add', 'Add a task to the current project',
    { slug: z.string(), title: z.string(), description: z.string().optional(), phase: z.string().optional(), duration_days: z.number().optional(), coverage_target: z.number().optional() },
    ({ slug, title, description, phase, duration_days, coverage_target }) => {
      try {
        const proj = requireProject();
        const task = insertTask(db, { project_id: proj.id, slug, title, description, phase, duration_days, coverage_target });
        logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.add', detail: title, actor: 'claude' });
        return ok(task);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_task_update', 'Mark task start/done/blocked with optional note (audit logged)',
    { slug: z.string(), status: z.enum(['open','in-progress','blocked','done','dropped']), note: z.string().optional() },
    ({ slug, status, note }) => {
      try {
        const proj = requireProject();
        const task = taskBySlug(db, proj.id, slug);
        if (!task) return err(`Task not found: ${slug}`);
        updateTaskStatus(db, proj.id, slug, status);
        logAudit(db, { project_id: proj.id, task_id: task.id, event: `task.${status}`, detail: note, actor: 'claude' });
        return ok({ slug, status, note });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_dep_add', 'Add predecessor→successor dependency edge',
    { predecessor_slug: z.string(), successor_slug: z.string() },
    ({ predecessor_slug, successor_slug }) => {
      try {
        const proj = requireProject();
        const pred = taskBySlug(db, proj.id, predecessor_slug);
        const succ = taskBySlug(db, proj.id, successor_slug);
        if (!pred) return err(`Task not found: ${predecessor_slug}`);
        if (!succ) return err(`Task not found: ${successor_slug}`);
        addDependency(db, pred.id, succ.id);
        return ok({ predecessor: predecessor_slug, successor: successor_slug });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_sync', 'Dry-run or apply GitHub Issues ↔ DB reconciliation',
    { apply: z.boolean().default(false) },
    async ({ apply }) => {
      try {
        const proj  = requireProject();
        if (!proj.gh_repo) return err('No gh_repo set for this project.');
        const tasks = tasksByProject(db, proj.id);
        const actions = syncTasks(proj.gh_repo, tasks.map(t => ({
          id: t.id, slug: t.slug, title: t.title, status: t.status, gh_issue_number: t.gh_issue_number,
        })), apply);
        return ok({ actions, applied: apply });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_report', 'Generate tasks.md, docs/status-{date}.md, or ADRs',
    { kind: z.enum(['tasks','status','adrs']) },
    ({ kind }) => {
      try {
        const proj = requireProject();
        if (kind === 'tasks')  return ok({ content: reportTasks(db, proj) });
        if (kind === 'status') return ok({ content: reportStatus(db, proj) });
        return ok({ message: 'Use crux report adrs from CLI for per-ADR file generation.' });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_ready', 'Release readiness go/no-go check against all phase gates', {},
    () => {
      try {
        const proj  = requireProject();
        const tasks = tasksByProject(db, proj.id);
        const blocked = tasks.filter(t => t.status === 'blocked');
        const critOpen = tasks.filter(t => t.status === 'open' && t.is_critical);
        const done  = tasks.filter(t => t.status === 'done').length;
        return ok({ go: blocked.length === 0 && critOpen.length === 0 && done === tasks.length, done, total: tasks.length, blocked: blocked.map(t => t.slug), critical_open: critOpen.map(t => t.slug) });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_graph', 'Return ASCII dependency DAG or DOT format',
    { format: z.enum(['ascii','dot']).default('ascii') },
    ({ format }) => {
      try {
        const proj  = requireProject();
        const tasks = tasksByProject(db, proj.id);
        const deps  = dependenciesByProject(db, proj.id);
        const nodes: CpmNode[] = tasks.map(t => ({ id: t.id, slug: t.slug, title: t.title, duration: t.duration_days ?? 1, phase: t.phase }));
        const edges: CpmEdge[] = deps.map(d => ({ predecessor_id: d.predecessor_id, successor_id: d.successor_id }));
        let cpmNodes;
        try { cpmNodes = computeCpm(nodes, edges).nodes; } catch { cpmNodes = undefined; }
        const output = format === 'dot' ? dotGraph(nodes, edges, cpmNodes) : asciiDag(nodes, edges, cpmNodes);
        return ok({ format, output });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_test_run', 'Record build/test result + coverage; auto-close task if coverage target met',
    { phase: z.enum(['build','test-c','test-python','lint']), status: z.enum(['pass','fail']), task_slug: z.string().optional(), coverage: z.number().optional(), commit_sha: z.string().optional() },
    ({ phase, status, task_slug, coverage, commit_sha }) => {
      try {
        const proj = requireProject();
        insertTestRun(db, { project_id: proj.id, phase, status, task_slug, coverage, commit_sha });
        const result: Record<string, unknown> = { phase, status, coverage };
        if (status === 'pass' && task_slug && coverage !== undefined) {
          const task = taskBySlug(db, proj.id, task_slug);
          if (task?.coverage_target && coverage >= task.coverage_target) {
            updateTaskStatus(db, proj.id, task_slug, 'done');
            logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.auto-done', detail: `coverage ${coverage}%`, actor: 'crux-auto' });
            result.auto_closed = task_slug;
          }
        }
        return ok(result);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_milestone_check', 'Detect phase completions → generate milestone doc',
    {},
    () => {
      try {
        const proj  = requireProject();
        const tasks = tasksByProject(db, proj.id);
        const phases = new Map<string, { total: number; done: number }>();
        for (const t of tasks) {
          const k = t.phase ?? 'Unphased';
          const cur = phases.get(k) ?? { total: 0, done: 0 };
          cur.total++;
          if (t.status === 'done') cur.done++;
          phases.set(k, cur);
        }
        const completed = [];
        for (const [phase, counts] of phases) {
          if (counts.total > 0 && counts.done === counts.total) completed.push({ phase, ...counts });
        }
        return ok({ completed, phases: Object.fromEntries(phases) });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_session_start', 'Start a time-tracking session for the current project', {},
    () => {
      try {
        const proj = requireProject();
        const s = startSession(db, proj.id);
        logAudit(db, { project_id: proj.id, event: 'session.start', actor: 'claude' });
        return ok(s);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_session_end', 'End session and log minutes elapsed',
    { note: z.string().optional() },
    ({ note }) => {
      try {
        const proj = requireProject();
        const sess = activeSession(db, proj.id);
        if (!sess) return err('No active session.');
        const ended = endSession(db, sess.id, note);
        logAudit(db, { project_id: proj.id, event: 'session.end', detail: `${ended.minutes?.toFixed(0)}min`, actor: 'claude' });
        return ok(ended);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_roi_record', 'Log revenue or cost against a project',
    { amount: z.number(), kind: z.enum(['revenue','cost','expected']).default('revenue'), currency: z.string().default('AUD'), probability: z.number().min(0).max(1).default(1), note: z.string().optional() },
    ({ amount, kind, currency, probability, note }) => {
      try {
        const proj = requireProject();
        insertRoi(db, { project_id: proj.id, amount, kind, currency, probability, note });
        return ok({ recorded: true, amount, kind });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_roi_report', 'ROI analysis JSON', {},
    () => {
      try {
        const proj  = requireProject();
        const roi   = roiSummary(db, proj.id);
        const hours = totalHours(db, proj.id);
        return ok({ roi, hours, roi_per_hour: hours > 0 ? roi.revenue / hours : null });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_spread_check', 'Focus health: active project count + spread warning', {},
    () => {
      try {
        const projects = allProjects(db);
        const active   = projects.filter(p => p.status === 'active');
        return ok({ active_count: active.length, spread_warning: active.length > 2, active_projects: active.map(p => p.name) });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_project_add', 'Register a new project of any type',
    { name: z.string(), type: z.enum(['code_repo','article','research','freelance','learning','personal']).default('personal'), hourly_rate: z.number().optional() },
    ({ name, type, hourly_rate }) => {
      try {
        const proj = insertProject(db, { name, type, hourly_rate });
        return ok(proj);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_project_link', 'Link current repo directory to an existing project',
    { project_id: z.string() },
    ({ project_id }) => {
      try {
        const root = findRepoRoot() ?? process.cwd();
        const proj = projectById(db, project_id);
        if (!proj) return err(`Project not found: ${project_id}`);
        writeProjectPointer(root, project_id);
        return ok({ linked: true, project: proj });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_ask', 'Route a question to the local LLM with DB context injected',
    { question: z.string() },
    async ({ question }) => {
      try {
        const proj = requireProject();
        const answer = await ask(db, proj, question);
        return ok({ question, answer });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  // ── UI server (background HTTP on port 8765) ───────────────────────────────
  startServer(8765);

  // ── Connect ────────────────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Embedded SKILL.md (fallback when bundle path not available)
// ═══════════════════════════════════════════════════════════════════════════════

const SKILL_CONTENT = `---
name: crux
description: Project management with CPM, ROI tracking, and three-tier routing. Route by complexity before acting.
---

# crux skill

## ROUTING RULES — apply before every response

### TIER 1 — CLI (free, instant, no AI)
For: status, reports, task updates, sync, session tracking, graph, ROI records.
Action: \`Bash: crux <command>\`

### TIER 2 — Local LLM (free, local)
For: "what next", "summarise", "is X worth it", "what's blocking"
Action: \`Bash: crux ask "<question>"\` — relay the response verbatim.

### TIER 3 — Claude (paid, cloud)
For: strategy across projects, architecture decisions, ambiguous priorities under constraints.
Action: run \`crux overview\` and \`crux cpm\` first to load current state, then reason.

## Available MCP Tools
crux_init, crux_status, crux_overview, crux_cpm, crux_task_add, crux_task_update,
crux_dep_add, crux_sync, crux_report, crux_ready, crux_graph, crux_test_run,
crux_milestone_check, crux_session_start, crux_session_end, crux_roi_record,
crux_roi_report, crux_spread_check, crux_project_add, crux_project_link, crux_ask
`;
