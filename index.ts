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
  resolveProject, insertProject, projectById, allProjects, resolveProjectByQuery, updateProjectStatus, updateProjectGhRepo, updateTaskGhIssue, updateTaskValueScore, updateTaskActualDays, updateTaskPriority,
  tasksByProject, taskBySlug, insertTask, updateTaskStatus, updateTaskProject, updateTaskCpm,
  addDependency, dependenciesByProject,
  startSession, endSession, activeSession, updateSessionContainerName,
  insertRoi, roiSummary, totalHours,
  insertTestRun, logAudit, recentAudit, projectStatus,
  insertAdr, listAdrs,
  updateTaskType,
  updateTaskSpec,
  updateProjectEnv,
  updateProjectEnvFromFlags,
  getActiveProjectId,
  setActiveProjectId,
  PROJECT_TYPES, PROJECT_STATUSES, TASK_STATUSES, TASK_TYPES, TASK_EXECUTORS,
  ESTIMATED_BY_VALUES, RUN_ENVS, ROI_KINDS, TEST_PHASES, TEST_RUN_STATUSES, ADR_STATUSES,
} from './lib/db.ts';
import type { Project, ProjectType, RunEnv, TaskStatus, TaskType, TaskExecutor } from './lib/db.ts';

import { computeCpm, asciiDag, dotGraph } from './lib/cpm.ts';
import type { CpmNode, CpmEdge } from './lib/cpm.ts';

import { reportTasks, reportStatus, reportOverview } from './lib/reports.ts';
import { formatProjectList } from './lib/cli-format.ts';
import { resolveActiveProject } from './lib/project-resolution.ts';
import { ask }    from './lib/ask.ts';
import { exportCsv, syncToSheets } from './lib/sheets.ts';
import { startServer, updateProjectStatusHandler } from './lib/server.ts';
import { readCruxConfig, writeCruxConfig } from './lib/config.ts';
import { agentContext } from './lib/codebase.ts';
import { syncTasks } from './lib/gh.ts';
import { runAgent } from './lib/agent.ts';
import { runWorkflow, gitCommitFiles, gitPushBranch } from './lib/workflow.ts';

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
    case 'context':        return cmdContext();
    case 'agent':          return cmdAgent(rest);
    case 'ui':             return cmdUi(rest);
    case 'config':         return cmdConfig(rest);
    case 'switch':         return cmdSwitch(rest);
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
  project status <status>        Set active|stalled|paused|done|dropped on current project
  switch [name-or-id] [--list]   Switch active project, or list all projects

STATUS
  status                         Current project: tasks, blockers, next up
  overview                       All projects meta-Kanban
  spread                         Focus health: active count + ROI signals
  ready                          Go/no-go release readiness

TASKS
  task add <slug> <title>        Add task [--type coding|writing|research|accounting|verification|design|other]
  task type <slug> <type>        Set task type
  task done <slug> [--note ""]   Mark done
  task start <slug>              Mark in-progress
  task block <slug> [--note ""]  Mark blocked
  task move <slug> <project>     Reassign task to another project (id|number|name)
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
  context                        Full project snapshot as JSON (for agent orientation)
  agent --task <slug>            Run local LLM agent on a single task
    [--dry-run] [--max-iter N]
  agent --run-all                Run agent on all unblocked tasks in WSJF order
    [--phase <phase>] [--dry-run] [--max-iter N]     (resumes in-progress first)
  agent --reset-stalled          Reset all in-progress tasks back to open
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
  const nodes: CpmNode[] = tasks.map(t => ({ id: t.id, slug: t.slug, title: t.title, duration: t.duration_days ?? 1, phase: t.phase, value_score: t.value_score }));
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
  const nodes: CpmNode[] = tasks.map(t => ({ id: t.id, slug: t.slug, title: t.title, duration: t.duration_days ?? 1, phase: t.phase, value_score: t.value_score }));
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

  const TASK_TYPES = ['coding','writing','research','accounting','verification','design','other'];

  if (sub === 'add') {
    const slug     = args[1];
    const typeFlag = flag(args, '--type') as TaskType | null;
    const titleArgs = args.slice(2).filter(a => !a.startsWith('--') && a !== typeFlag);
    const title    = titleArgs.join(' ');
    if (!slug || !title) { console.error('Usage: crux task add <slug> <title> [--type coding|writing|research|accounting|verification|design|other]'); process.exit(1); }
    const task_type = (typeFlag && TASK_TYPES.includes(typeFlag)) ? typeFlag : undefined;
    const task = insertTask(db, { project_id: proj.id, slug, title, task_type });
    logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.add', detail: title, actor: 'human' });
    console.log(`✓ Task added: ${slug} [${task.task_type}]`);
    return;
  }

  const slug   = args[1];
  const note   = flag(args, '--note') ?? undefined;
  const typeFlag = flag(args, '--type') as TaskType | null;
  const task   = slug ? taskBySlug(db, proj.id, slug) : null;

  if (!slug || !task) { console.error(`Task not found: ${slug}`); process.exit(1); }

  // Handle `crux task type <slug> <type>` or `crux task update <slug> --type <type>`
  if (sub === 'type' || (sub === 'update' && typeFlag)) {
    const newType = (sub === 'type' ? args[2] : typeFlag) as TaskType;
    if (!newType || !TASK_TYPES.includes(newType)) {
      console.error(`Valid types: ${TASK_TYPES.join(', ')}`); process.exit(1);
    }
    updateTaskType(db, task.id, newType);
    logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.update', detail: `type → ${newType}`, actor: 'human' });
    console.log(`✓ ${slug} type → ${newType}`);
    return;
  }

  // Handle `crux task move <slug> <project-id|number|name>`
  if (sub === 'move') {
    const projectArg = args[2];
    if (!projectArg) { console.error('Usage: crux task move <slug> <project-id|number|name>'); process.exit(1); }
    const target = resolveProjectByQuery(db, projectArg);
    if (!target) {
      console.error(`No project matching "${projectArg}"\nAvailable:\n${formatProjectList(allProjects(db), getActiveProjectId(db))}`);
      process.exit(1);
    }
    if (target.id === proj.id) { console.error(`${slug} is already in ${target.name}`); process.exit(1); }
    if (taskBySlug(db, target.id, slug)) {
      console.error(`Task slug "${slug}" already exists in ${target.name} — rename before moving`); process.exit(1);
    }
    updateTaskProject(db, task.id, target.id);
    logAudit(db, { project_id: target.id, task_id: task.id, event: 'task.move', detail: `${proj.name} → ${target.name}`, actor: 'human' });
    console.log(`✓ ${slug} moved: ${proj.name} → ${target.name}`);
    return;
  }

  const statusMap: Record<string, TaskStatus> = { done: 'done', start: 'in-progress', block: 'blocked', drop: 'dropped', update: 'open' };
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

// ── Container lifecycle helpers ───────────────────────────────────────────────

function containerImageForProject(proj: Project, projectRoot: string): string {
  const containerfile = join(projectRoot, '.crux', 'Containerfile');
  if (existsSync(containerfile)) {
    const tag = `crux-${proj.id.slice(0, 8)}:dev`;
    const r = spawnSync('container', ['build', '-t', tag, '-f', containerfile, projectRoot], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`Container build failed:\n${r.stderr}`);
    return tag;
  }
  if (proj.container_image) return proj.container_image;
  throw new Error(
    `run_env=container but no .crux/Containerfile found and no container_image set.\n` +
    `Create .crux/Containerfile or run: crux project env --container-image <image>`
  );
}

function containerStart(proj: Project, sessionId: number, projectRoot: string): string {
  const image = containerImageForProject(proj, projectRoot);
  const name  = `crux-session-${sessionId}`;
  const r = spawnSync('container', [
    'run', '-d', '--name', name,
    '-v', `${projectRoot}:/app`, '-w', '/app',
    image, 'sleep', 'infinity',
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Container start failed:\n${r.stderr}`);
  return name;
}

function containerStop(containerName: string): void {
  spawnSync('container', ['stop', containerName], { encoding: 'utf8' });
  spawnSync('container', ['rm',   containerName], { encoding: 'utf8' });
}

// ── session ───────────────────────────────────────────────────────────────────

function cmdSession(args: string[]): void {
  const db   = openDb();
  const proj = getProject();
  const sub  = args[0];

  if (sub === 'start') {
    const s = startSession(db, proj.id);
    if (proj.run_env === 'container') {
      try {
        const root = findRepoRoot() ?? process.cwd();
        const name = containerStart(proj, s.id, root);
        updateSessionContainerName(db, s.id, name);
        console.log(`✓ Session started (id ${s.id}) — container: ${name}`);
      } catch (e) {
        endSession(db, s.id);
        console.error(`Container start failed: ${(e as Error).message}`);
        process.exit(1);
      }
    } else {
      console.log(`✓ Session started (id ${s.id}) at ${s.started_at}`);
    }
    logAudit(db, { project_id: proj.id, event: 'session.start', actor: 'human' });
    return;
  }

  if (sub === 'end') {
    const note = flag(args, '--note') ?? undefined;
    const sess = activeSession(db, proj.id);
    if (!sess) { console.error('No active session.'); process.exit(1); }
    if (sess.container_name) {
      containerStop(sess.container_name);
      console.log(`✓ Container stopped: ${sess.container_name}`);
    }
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
    const adrs = listAdrs(db, proj.id);
    if (adrs.length === 0) { console.log('No ADRs to generate.'); return; }
    mkdirSync(join('docs', 'adr'), { recursive: true });
    for (const adr of adrs) {
      const slug = adr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const filename = `ADR-${String(adr.number).padStart(3, '0')}-${slug}.md`;
      const path = join('docs', 'adr', filename);
      const md = [
        `# ADR-${String(adr.number).padStart(3, '0')}: ${adr.title}`,
        ``,
        `**Status:** ${adr.status}  `,
        `**Date:** ${adr.created_at.slice(0, 10)}`,
        ``,
        `## Context`,
        ``,
        adr.context ?? '_Not recorded._',
        ``,
        `## Decision`,
        ``,
        adr.decision ?? '_Not recorded._',
        ``,
        `## Consequences`,
        ``,
        adr.consequences ?? '_Not recorded._',
      ].join('\n');
      writeFileSync(path, md);
      console.log(`✓ ${path}`);
    }
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

  if (apply) {
    for (const action of actions) {
      if (action.action === 'create' && action.issue_number != null) {
        const task = tasks.find(t => t.slug === action.task_slug);
        if (task) updateTaskGhIssue(db, task.id, action.issue_number);
      }
    }
  }

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
    const root   = findRepoRoot() ?? process.cwd();
    const ghRepo = flag(args, '--gh-repo');
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
    if (ghRepo) updateProjectGhRepo(db, proj.id, ghRepo);
    console.log(`✓ Linked to ${proj.name}${ghRepo ? ` (gh_repo: ${ghRepo})` : ''}`);
    return;
  }

  if (sub === 'list') {
    const projects = allProjects(db);
    for (const p of projects) console.log(`${p.id.slice(0,8)}  ${p.name.padEnd(30)} ${p.type.padEnd(12)} ${p.status}  ${p.run_env}`);
    return;
  }

  if (sub === 'status') {
    const proj   = getProject();
    const status = args[1];
    if (!status) { console.error('Usage: crux project status <active|stalled|paused|done|dropped>'); process.exit(1); }
    const result = updateProjectStatusHandler(db, proj.id, status);
    if (result.status !== 200) { console.error((result.body as { error: string }).error); process.exit(1); }
    console.log(`✓ ${proj.name} → ${status}`);
    return;
  }

  if (sub === 'env') {
    const proj = getProject();
    updateProjectEnvFromFlags(db, proj.id, {
      runEnv:        flag(args, '--run-env') ?? undefined,
      verifyCmd:     flag(args, '--verify-cmd') ?? undefined,
      testCmd:       flag(args, '--test-cmd') ?? undefined,
      containerImage: flag(args, '--container-image') ?? undefined,
    });
    const updated = projectById(db, proj.id)!;
    console.log(`✓ Updated env for ${updated.name}`);
    console.log(`  run_env:         ${updated.run_env}`);
    console.log(`  verify_cmd:      ${updated.verify_cmd ?? '(none)'}`);
    console.log(`  test_cmd:        ${updated.test_cmd ?? '(none)'}`);
    console.log(`  container_image: ${updated.container_image ?? '(none)'}`);
    return;
  }

  console.error('Usage: crux project add|link|list|status|env');
}

// ── switch ────────────────────────────────────────────────────────────────────

function cmdSwitch(args: string[]): void {
  const db    = openDb();
  const query = args[0];
  if (!query || query === '--list') {
    const all = allProjects(db);
    console.log(formatProjectList(all, getActiveProjectId(db)));
    return;
  }
  const all   = allProjects(db);
  const match = resolveProjectByQuery(db, query);
  if (!match) {
    console.error(`No project matching "${query}"\nAvailable:\n${formatProjectList(all, getActiveProjectId(db))}`);
    process.exit(1);
  }
  setActiveProjectId(db, match.id);
  console.log(`✓ Active project → #${match.project_number} ${match.name} (${match.id.slice(0,8)})`);
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

// ── context ───────────────────────────────────────────────────────────────────

function cmdContext(): void {
  const db      = openDb();
  const proj    = getProject();
  const allTasks = tasksByProject(db, proj.id);
  const deps     = dependenciesByProject(db, proj.id);
  const adrs     = listAdrs(db, proj.id);
  const audit    = recentAudit(db, proj.id, 8);
  const status   = projectStatus(db, proj.id);
  const slugById = new Map(allTasks.map(t => [t.id, t.slug]));

  const cpmNodes: CpmNode[] = allTasks.map(t => ({
    id: t.id, slug: t.slug, title: t.title,
    duration: t.duration_days ?? 1, phase: t.phase, value_score: t.value_score,
  }));
  const cpmEdges: CpmEdge[] = deps.map(d => ({
    predecessor_id: d.predecessor_id, successor_id: d.successor_id,
  }));
  let cpmSummary = null;
  try {
    const cpm = computeCpm(cpmNodes, cpmEdges);
    cpmSummary = { project_duration: cpm.project_duration, critical_path: cpm.critical_path, critical_count: cpm.nodes.filter(n => n.is_critical).length };
  } catch { /* cycle */ }

  const activeTasks = allTasks
    .filter(t => t.status === 'open' || t.status === 'in-progress' || t.status === 'blocked')
    .map(t => ({
      id: t.id, slug: t.slug, title: t.title,
      description:   t.description ? t.description.slice(0, 200) : null,
      phase: t.phase, status: t.status, duration_days: t.duration_days,
      value_score: t.value_score, is_critical: t.is_critical === 1,
      predecessors: deps.filter(d => d.successor_id   === t.id).map(d => slugById.get(d.predecessor_id) ?? d.predecessor_id),
      successors:   deps.filter(d => d.predecessor_id === t.id).map(d => slugById.get(d.successor_id)   ?? d.successor_id),
    }));

  const out = {
    project:    { id: proj.id, name: proj.name, type: proj.type, status: proj.status, gh_repo: proj.gh_repo },
    summary:    { total: allTasks.length, open: status.open, in_progress: status.in_progress, blocked: status.blocked, done: allTasks.filter(t => t.status === 'done').length, next_unblocked: status.next_unblocked, cpm: cpmSummary },
    active_tasks: activeTasks,
    adrs:       adrs.map(a => ({ number: a.number, title: a.title, status: a.status, decision: a.decision ? a.decision.slice(0, 300) : null })),
    recent_audit: audit.map(e => ({ event: e.event, detail: e.detail, actor: e.actor, created_at: e.created_at })),
  };
  console.log(JSON.stringify(out, null, 2));
}

// ── agent ─────────────────────────────────────────────────────────────────────

function nextUnblockedTasks(db: ReturnType<typeof openDb>, projId: string, phase?: string) {
  const tasks   = tasksByProject(db, projId);
  const deps    = dependenciesByProject(db, projId);
  const doneIds = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));

  const wsjf = (t: typeof tasks[0]) => (t.value_score ?? 0) / (t.duration_days ?? 1);

  // in-progress tasks come first (resume before starting new ones), excluding human tasks
  const inProgress = tasks
    .filter(t => t.status === 'in-progress' && t.executor !== 'human' && (!phase || t.phase === phase))
    .sort((a, b) => wsjf(b) - wsjf(a));

  const open = tasks
    .filter(t => {
      if (t.status !== 'open') return false;
      if (t.executor === 'human') return false;  // human tasks go in human_queue, not LLM queue
      if (phase && t.phase !== phase) return false;
      const preds = deps.filter(d => d.successor_id === t.id).map(d => d.predecessor_id);
      return preds.every(id => doneIds.has(id));
    })
    .sort((a, b) => wsjf(b) - wsjf(a));

  return [...inProgress, ...open];
}

/** Human tasks whose predecessors are all done — need human action before successors can proceed */
function humanQueue(db: ReturnType<typeof openDb>, projId: string) {
  const tasks   = tasksByProject(db, projId);
  const deps    = dependenciesByProject(db, projId);
  const doneIds = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));

  return tasks.filter(t => {
    if (t.status !== 'open' && t.status !== 'in-progress') return false;
    if (t.executor !== 'human') return false;
    const preds = deps.filter(d => d.successor_id === t.id).map(d => d.predecessor_id);
    return preds.every(id => doneIds.has(id));
  }).map(t => {
    // Count tasks directly blocked because this human task is not done
    const blocksCount = deps.filter(d => d.predecessor_id === t.id).length;
    return {
      slug:                t.slug,
      title:               t.title,
      phase:               t.phase,
      acceptance_criteria: t.acceptance_criteria,
      blocks_downstream:   blocksCount,
      // Future: notify assigned actor when actors table exists
      waiting_on:          'human',
    };
  });
}

function stalledTasks(db: ReturnType<typeof openDb>, projId: string) {
  return tasksByProject(db, projId).filter(t => t.status === 'in-progress');
}

async function cmdAgent(args: string[]): Promise<void> {
  const taskSlug      = flag(args, '--task');
  const runAll        = hasFlag(args, '--run-all');
  const resetStalled  = hasFlag(args, '--reset-stalled');
  const phase         = flag(args, '--phase') ?? undefined;
  const dryRun        = hasFlag(args, '--dry-run');
  const maxIterStr    = flag(args, '--max-iter');
  const ctxStr        = flag(args, '--ctx-tokens');
  const maxIter       = maxIterStr ? parseInt(maxIterStr, 10) : undefined;
  const ctxTokens     = ctxStr    ? parseInt(ctxStr,     10) : undefined;

  if (!taskSlug && !runAll && !resetStalled) {
    console.error([
      'Usage:',
      '  crux agent --task <slug> [--dry-run] [--max-iter N] [--ctx-tokens N]',
      '  crux agent --run-all [--phase <phase>] [--dry-run] [--max-iter N] [--ctx-tokens N]',
      '  crux agent --reset-stalled          Reset all in-progress tasks back to open',
    ].join('\n'));
    process.exit(1);
  }

  const db   = openDb();
  const proj = getProject();

  // ── reset-stalled: move all in-progress back to open ─────────────────────
  if (resetStalled) {
    const stalled = stalledTasks(db, proj.id);
    if (stalled.length === 0) { console.log('No stalled tasks.'); return; }
    for (const t of stalled) {
      updateTaskStatus(db, proj.id, t.slug, 'open');
      logAudit(db, { project_id: proj.id, task_id: t.id, event: 'task.open', detail: 'reset from in-progress by --reset-stalled', actor: 'human' });
      console.log(`↺  ${t.slug} → open`);
    }
    console.log(`\nReset ${stalled.length} task(s). Run crux agent --run-all to resume.`);
    return;
  }

  if (taskSlug) {
    const task = taskBySlug(db, proj.id, taskSlug);
    if (!task) { console.error(`Task not found: ${taskSlug}`); process.exit(1); }
    if (dryRun) {
      console.log(`[dry-run] task: ${task.slug} type: ${task.task_type}`);
      return;
    }
    const result = await runWorkflow(db, proj, task, { ctxTokens });
    if (result.completed) {
      console.log(`✓ done: ${taskSlug}${result.note ? ` — ${result.note}` : ''}`);
    } else if (result.blocked) {
      console.log(`⊘ blocked at step '${result.step}': ${taskSlug}${result.note ? ` — ${result.note}` : ''}`);
      process.exit(2);
    } else {
      console.log(`⚠ stopped at step '${result.step}'`);
      process.exit(1);
    }
    return;
  }

  // --run-all: loop through unblocked tasks in WSJF order
  let completed = 0;
  let blocked   = 0;
  let failed    = 0;

  console.log(`crux agent --run-all${phase ? ` --phase ${phase}` : ''}\n`);

  for (;;) {
    const queue = nextUnblockedTasks(db, proj.id, phase);
    if (queue.length === 0) {
      console.log(`\nNo more unblocked open tasks. Done: ${completed}, Blocked: ${blocked}, Failed: ${failed}`);
      break;
    }

    const task = queue[0];
    console.log(`\n→ next: ${task.slug} [${task.task_type}] (${queue.length} in queue)`);
    if (dryRun) { console.log(`[dry-run] would run ${task.task_type} workflow`); break; }

    const result = await runWorkflow(db, proj, task, { ctxTokens });

    if (result.completed) {
      completed++;
      console.log(`✓ done: ${task.slug}${result.note ? ` — ${result.note}` : ''}`);
    } else if (result.blocked) {
      blocked++;
      console.log(`⊘ blocked at '${result.step}': ${task.slug}${result.note ? ` — ${result.note}` : ''}`);
      // Don't stop — re-evaluate queue and try next unblocked task
    } else {
      failed++;
      console.log(`⚠ stopped at '${result.step}': ${task.slug}`);
      // Stop the queue — something unexpected happened
      break;
    }
  }

  if (blocked > 0 || failed > 0) process.exit(1);
}

// ── ui ────────────────────────────────────────────────────────────────────────

async function cmdUi(args: string[]): Promise<void> {
  const port   = parseInt(flag(args, '--port') ?? String(readCruxConfig().ui_port));
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

// ── config ────────────────────────────────────────────────────────────────────

function cmdConfig(args: string[]): void {
  const [sub, key, value] = args;
  if (sub === 'get' && key) {
    const cfg = readCruxConfig();
    const val = (cfg as unknown as Record<string, unknown>)[key];
    if (val === undefined) { console.error(`Unknown config key: ${key}`); process.exit(1); }
    console.log(val);
  } else if (sub === 'set' && key && value !== undefined) {
    const VALID_KEYS: (keyof ReturnType<typeof readCruxConfig>)[] = ['ui_port', 'llm_endpoint'];
    if (!VALID_KEYS.includes(key as never)) { console.error(`Unknown config key: ${key}. Valid keys: ${VALID_KEYS.join(', ')}`); process.exit(1); }
    const patch: Record<string, unknown> = { [key]: key === 'ui_port' ? parseInt(value) : value };
    const updated = writeCruxConfig(patch as Parameters<typeof writeCruxConfig>[0]);
    console.log(JSON.stringify(updated, null, 2));
  } else {
    console.log(JSON.stringify(readCruxConfig(), null, 2));
  }
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
    // CWD-based .crux/project.json takes precedence — see lib/project-resolution.ts.
    // Global active_project_id (crux_switch) is only a fallback for sessions
    // with no directory link; it must not override another session's own link.
    const proj = resolveActiveProject(db, findRepoRoot());
    if (!proj) throw new Error('No active project. Call crux_switch <name> or crux_init first.');
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
    {
      name:            z.string(),
      type:            z.enum(PROJECT_TYPES).default('code_repo'),
      install_skill:   z.boolean().default(false),
      run_env:         z.enum(RUN_ENVS).default('shell'),
      verify_cmd:      z.string().optional(),
      test_cmd:        z.string().optional(),
      container_image: z.string().optional(),
    },
    async ({ name, type, install_skill, run_env, verify_cmd, test_cmd, container_image }) => {
      try {
        const root = findRepoRoot() ?? process.cwd();
        const existing = resolveProject(db, root);
        if (existing) return ok({ project: existing, message: 'Already initialised' });
        const proj = insertProject(db, { name, type });
        if (run_env !== 'shell' || verify_cmd || test_cmd || container_image) {
          updateProjectEnv(db, proj.id, { run_env, verify_cmd, test_cmd, container_image });
        }
        writeProjectPointer(root, proj.id);
        logAudit(db, { project_id: proj.id, event: 'project.init', detail: `type=${type},run_env=${run_env}`, actor: 'claude' });
        if (install_skill) installSkill(root);
        return ok({ project: { ...proj, run_env, verify_cmd, test_cmd }, skill_installed: install_skill });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_status', 'Structured JSON: task counts, next unblocked tasks, blockers, human action queue', {},
    () => {
      try {
        const proj   = requireProject();
        const status = projectStatus(db, proj.id);
        const hq     = humanQueue(db, proj.id);
        return ok({ ...status, human_queue: hq });
      }
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
          return { number: p.project_number, ...p, task_count: tasks.length, done_count: tasks.filter(t => t.status === 'done').length, roi, hours };
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
        const nodes: CpmNode[] = tasks.map(t => ({ id: t.id, slug: t.slug, title: t.title, duration: t.duration_days ?? 1, phase: t.phase, value_score: t.value_score }));
        const edges: CpmEdge[] = deps.map(d => ({ predecessor_id: d.predecessor_id, successor_id: d.successor_id }));
        const result = computeCpm(nodes, edges);
        for (const n of result.nodes) {
          updateTaskCpm(db, n.id, { early_start: n.early_start, early_finish: n.early_finish, late_start: n.late_start, late_finish: n.late_finish, float_days: n.float_days, is_critical: n.is_critical ? 1 : 0 });
        }
        return ok(result);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool(
    'crux_task_add',
    `Add a task to the current project.

REQUIRED for coding tasks (task_type='coding'):
  - acceptance_criteria: testable done condition written as assertions, e.g.
      "firstRevenueAt(db, projectId) returns ISO string or null; test uses new DatabaseSync(':memory:') + schema.sql; asserts MIN(recorded_at) WHERE kind='revenue' AND amount>0"
  - files_affected: exact file paths that will change, e.g. ["lib/db.ts", "index.ts"]

The agent uses these fields to write correct tests and implementations grounded in the real codebase.
Vague or missing acceptance_criteria causes the agent to invent APIs that don't exist.
REQUIRED for writing tasks: acceptance_criteria describing the document structure/content.
REQUIRED for research tasks: acceptance_criteria describing the decision to be made.`,
    {
      slug: z.string().describe('kebab-case identifier, e.g. p16-time-to-first-dollar'),
      title: z.string().describe('Short imperative title'),
      description: z.string().optional().describe('Full description of what to build and why'),
      phase: z.string().optional(),
      duration_days: z.number().optional(),
      coverage_target: z.number().optional(),
      value_score: z.number().min(0).max(100).optional().describe('Business value 0-100 for WSJF prioritisation'),
      priority: z.number().min(0).max(100).optional().describe('Explicit priority override 0-100 (independent of WSJF)'),
      task_type: z.enum(TASK_TYPES).optional().describe('Selects the workflow: coding=TDD, writing=draft+commit, research=ADR, verification=run tests'),
      acceptance_criteria: z.string().optional().describe('REQUIRED for coding/writing/research. Testable done condition. For coding: name the exact functions/fields to add, what tests must assert, which DB pattern to follow.'),
      files_affected: z.array(z.string()).optional().describe('REQUIRED for coding. Exact file paths that will be modified, e.g. ["lib/db.ts","index.ts","schema.sql"]'),
    },
    ({ slug, title, description, phase, duration_days, coverage_target, value_score, priority, task_type, acceptance_criteria, files_affected }) => {
      try {
        const proj = requireProject();
        const type = task_type ?? 'coding';

        // Enforce spec completeness for agentic task types
        if (['coding','writing','research'].includes(type) && !acceptance_criteria) {
          return err(
            `acceptance_criteria is required for ${type} tasks.\n` +
            `Provide a testable done condition, e.g.:\n` +
            `  coding:   "addFirstRevenueAt(db, projId) in lib/db.ts returns ISO string or null; test uses in-memory DB + schema.sql"\n` +
            `  writing:  "docs/adr/NNN-slug.md exists with context/decision/consequences sections"\n` +
            `  research: "ADR inserted via crux_adr_add with accepted status and concrete decision"`
          );
        }
        if (type === 'coding' && (!files_affected || files_affected.length === 0)) {
          return err(
            `files_affected is required for coding tasks.\n` +
            `Provide the exact file paths that will change, e.g. ["lib/db.ts", "index.ts", "schema.sql"]`
          );
        }

        const task = insertTask(db, { project_id: proj.id, slug, title, description, phase, priority, duration_days, coverage_target, value_score, task_type: type, acceptance_criteria, files_affected });
        logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.add', detail: title, actor: 'claude' });
        return ok(task);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool(
    'crux_task_update',
    `Update task status, type, spec fields, or value score (audit logged).
Use acceptance_criteria and files_affected to add spec to under-specified tasks before running the agent.
The agent reads these fields to write correct tests grounded in the real codebase API.`,
    {
      slug: z.string(),
      status: z.enum(TASK_STATUSES),
      note: z.string().optional(),
      value_score: z.number().min(0).max(100).optional(),
      priority: z.number().min(0).max(100).optional().describe('Explicit priority override 0-100 (independent of WSJF)'),
      task_type: z.enum(TASK_TYPES).optional(),
      acceptance_criteria: z.string().optional().describe('Testable done condition. For coding: name exact functions/fields, what tests assert, which existing pattern to follow (e.g. "see insertRoi() in lib/db.ts").'),
      files_affected: z.array(z.string()).optional().describe('Exact file paths that will be modified'),
      actual_days: z.number().optional().describe('Actual time spent on this task — record when setting status to done'),
      estimated_by: z.enum(ESTIMATED_BY_VALUES).optional().describe('Who produced the original duration_days estimate, for calibration'),
    },
    ({ slug, status, note, value_score, priority, task_type, acceptance_criteria, files_affected, actual_days, estimated_by }) => {
      try {
        const proj = requireProject();
        const task = taskBySlug(db, proj.id, slug);
        if (!task) return err(`Task not found: ${slug}`);
        updateTaskStatus(db, proj.id, slug, status);
        if (value_score != null) updateTaskValueScore(db, task.id, value_score);
        if (priority != null) updateTaskPriority(db, task.id, priority);
        if (task_type != null) updateTaskType(db, task.id, task_type);
        if (acceptance_criteria != null || files_affected != null)
          updateTaskSpec(db, task.id, { acceptance_criteria: acceptance_criteria ?? undefined, files_affected: files_affected ?? undefined });
        if (actual_days != null) updateTaskActualDays(db, task.id, actual_days, estimated_by);
        logAudit(db, { project_id: proj.id, task_id: task.id, event: `task.${status}`, detail: note, actor: 'claude' });
        const calibrationNote = status === 'done' && actual_days == null
          ? 'Consider recording actual_days on this call for estimation calibration.'
          : undefined;
        return ok({ slug, status, note, value_score: value_score ?? task.value_score, priority: priority ?? task.priority, task_type: task_type ?? task.task_type, actual_days: actual_days ?? task.actual_days, calibration_note: calibrationNote });
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
        // Write gh_issue_number back to DB for any newly created issues
        if (apply) {
          for (const action of actions) {
            if (action.action === 'create' && action.issue_number != null) {
              const task = tasks.find(t => t.slug === action.task_slug);
              if (task) updateTaskGhIssue(db, task.id, action.issue_number);
            }
          }
        }
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
        const nodes: CpmNode[] = tasks.map(t => ({ id: t.id, slug: t.slug, title: t.title, duration: t.duration_days ?? 1, phase: t.phase, value_score: t.value_score }));
        const edges: CpmEdge[] = deps.map(d => ({ predecessor_id: d.predecessor_id, successor_id: d.successor_id }));
        let cpmNodes;
        try { cpmNodes = computeCpm(nodes, edges).nodes; } catch { cpmNodes = undefined; }
        const output = format === 'dot' ? dotGraph(nodes, edges, cpmNodes) : asciiDag(nodes, edges, cpmNodes);
        return ok({ format, output });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_test_run', 'Record build/test result + coverage; auto-close task if coverage target met',
    { phase: z.enum(TEST_PHASES), status: z.enum(TEST_RUN_STATUSES), task_slug: z.string().optional(), coverage: z.number().optional(), commit_sha: z.string().optional() },
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

  server.tool('crux_session_start', 'Start a time-tracking session; starts a container if run_env=container', {},
    () => {
      try {
        const proj = requireProject();
        const s    = startSession(db, proj.id);
        if (proj.run_env === 'container') {
          const root = findRepoRoot() ?? process.cwd();
          const name = containerStart(proj, s.id, root);
          updateSessionContainerName(db, s.id, name);
          logAudit(db, { project_id: proj.id, event: 'session.start', detail: `container=${name}`, actor: 'claude' });
          return ok({ ...s, container_name: name });
        }
        logAudit(db, { project_id: proj.id, event: 'session.start', actor: 'claude' });
        return ok(s);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_session_end', 'End session, stop container if running, log minutes elapsed',
    { note: z.string().optional() },
    ({ note }) => {
      try {
        const proj = requireProject();
        const sess = activeSession(db, proj.id);
        if (!sess) return err('No active session.');
        if (sess.container_name) containerStop(sess.container_name);
        const ended = endSession(db, sess.id, note);
        logAudit(db, { project_id: proj.id, event: 'session.end', detail: `${ended.minutes?.toFixed(0)}min`, actor: 'claude' });
        return ok(ended);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_roi_record', 'Log revenue or cost against a project',
    { amount: z.number(), kind: z.enum(ROI_KINDS).default('revenue'), currency: z.string().default('AUD'), probability: z.number().min(0).max(1).default(1), note: z.string().optional() },
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
    { name: z.string(), type: z.enum(PROJECT_TYPES).default('personal'), hourly_rate: z.number().optional() },
    ({ name, type, hourly_rate }) => {
      try {
        const proj = insertProject(db, { name, type, hourly_rate });
        return ok(proj);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_project_link', 'Link a repo directory to an existing project; optionally set gh_repo',
    { project_id: z.string(), repo_path: z.string().optional(), gh_repo: z.string().optional() },
    ({ project_id, repo_path, gh_repo }) => {
      try {
        const root = repo_path ?? findRepoRoot() ?? process.cwd();
        const proj = projectById(db, project_id);
        if (!proj) return err(`Project not found: ${project_id}`);
        writeProjectPointer(root, project_id);
        if (gh_repo) updateProjectGhRepo(db, project_id, gh_repo);
        return ok({ linked: true, project: projectById(db, project_id) });
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

  // ── Project context (agent orientation) ───────────────────────────────────
  server.tool('crux_project_context',
    'Full project snapshot for agent orientation: metadata, open tasks with deps, ADRs, CPM summary, recent audit, and live codebase API signatures. One call gives any LLM everything needed to spec or implement work.',
    {},
    () => {
      try {
        const proj     = requireProject();
        const projRoot = findRepoRoot() ?? process.cwd();
        const allTasks = tasksByProject(db, proj.id);
        const deps     = dependenciesByProject(db, proj.id);
        const adrs     = listAdrs(db, proj.id);
        const audit    = recentAudit(db, proj.id, 8);
        const status   = projectStatus(db, proj.id);

        // Slug lookup maps for dep resolution
        const slugById = new Map(allTasks.map(t => [t.id, t.slug]));

        // CPM summary
        const cpmNodes: CpmNode[] = allTasks.map(t => ({
          id: t.id, slug: t.slug, title: t.title,
          duration: t.duration_days ?? 1, phase: t.phase, value_score: t.value_score,
        }));
        const cpmEdges: CpmEdge[] = deps.map(d => ({
          predecessor_id: d.predecessor_id, successor_id: d.successor_id,
        }));
        let cpmSummary: { project_duration: number; critical_path: string[]; critical_count: number } | null = null;
        try {
          const cpm = computeCpm(cpmNodes, cpmEdges);
          cpmSummary = {
            project_duration: cpm.project_duration,
            critical_path:    cpm.critical_path,
            critical_count:   cpm.nodes.filter(n => n.is_critical).length,
          };
        } catch { /* cycle or empty — skip */ }

        // Open + in-progress tasks with predecessor/successor slugs and truncated description
        const activeTasks = allTasks
          .filter(t => t.status === 'open' || t.status === 'in-progress' || t.status === 'blocked')
          .map(t => ({
            id:            t.id,
            slug:          t.slug,
            title:         t.title,
            description:   t.description ? t.description.slice(0, 200) : null,
            phase:         t.phase,
            status:        t.status,
            duration_days: t.duration_days,
            value_score:   t.value_score,
            is_critical:   t.is_critical === 1,
            predecessors:  deps.filter(d => d.successor_id   === t.id).map(d => slugById.get(d.predecessor_id) ?? d.predecessor_id),
            successors:    deps.filter(d => d.predecessor_id === t.id).map(d => slugById.get(d.successor_id)   ?? d.successor_id),
          }));

        return ok({
          project: {
            id:          proj.id,
            name:        proj.name,
            type:        proj.type,
            status:      proj.status,
            gh_repo:     proj.gh_repo,
          },
          summary: {
            total:           allTasks.length,
            open:            status.open,
            in_progress:     status.in_progress,
            blocked:         status.blocked,
            done:            allTasks.filter(t => t.status === 'done').length,
            next_unblocked:  status.next_unblocked,
            cpm:             cpmSummary,
          },
          active_tasks: activeTasks,
          adrs: adrs.map(a => ({
            number:   a.number,
            title:    a.title,
            status:   a.status,
            decision: a.decision ? a.decision.slice(0, 300) : null,
          })),
          recent_audit: audit.map(e => ({
            event:      e.event,
            detail:     e.detail,
            actor:      e.actor,
            created_at: e.created_at,
          })),
          agent_context: agentContext(projRoot, proj.type),
        });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  // ── Project switch ────────────────────────────────────────────────────────
  server.tool('crux_switch',
    'Switch the active project for all MCP tools. Pass a project name (partial match) or full project ID. All subsequent tool calls operate on this project until switched again.',
    { project: z.string().describe('Project name (partial match) or UUID') },
    ({ project }) => {
      try {
        const all = allProjects(db);
        const match = all.find(p =>
          p.id === project ||
          String(p.project_number) === project ||
          p.name.toLowerCase().includes(project.toLowerCase())
        );
        if (!match) {
          const names = all.map(p => `${p.name} (${p.id.slice(0,8)})`).join(', ');
          return err(`No project matching "${project}". Available: ${names}`);
        }
        setActiveProjectId(db, match.id);
        const projRoot = findRepoRoot() ?? process.cwd();
        return ok({
          switched_to:   match.name,
          id:            match.id,
          type:          match.type,
          run_env:       match.run_env,
          agent_context: agentContext(projRoot, match.type),
        });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  // ── Standalone git tools (interactive work — not the full autonomous workflow) ─
  server.tool('crux_git_commit',
    'Commit files with a message in the current repo. For incremental interactive work — does not run the full branch/test/push/PR pipeline (see crux agent for that).',
    { message: z.string(), files: z.array(z.string()).min(1) },
    ({ message, files }) => {
      try {
        const proj = requireProject();
        const cwd  = findRepoRoot() ?? process.cwd();
        const result = gitCommitFiles(cwd, message, files);
        if (!result.ok) return err(result.out || 'commit failed');
        logAudit(db, { project_id: proj.id, event: 'git.commit', detail: message, actor: 'claude' });
        return ok({ message, files });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_git_push',
    'Push the current branch (or a named one) to origin. For incremental interactive work.',
    { branch: z.string().optional() },
    ({ branch }) => {
      try {
        const proj = requireProject();
        const cwd  = findRepoRoot() ?? process.cwd();
        const result = gitPushBranch(cwd, branch);
        if (!result.ok) return err(result.out || 'push failed');
        logAudit(db, { project_id: proj.id, event: 'git.push', detail: branch, actor: 'claude' });
        return ok({ pushed: true, branch: branch ?? '(current)' });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  // ── ADR tools ─────────────────────────────────────────────────────────────
  server.tool('crux_adr_add', 'Add an Architecture Decision Record to the current project',
    {
      title:        z.string(),
      context:      z.string().optional().describe('The situation and forces that led to this decision'),
      decision:     z.string().optional().describe('The decision made and rationale'),
      consequences: z.string().optional().describe('Resulting context, trade-offs, and follow-up actions'),
      status:       z.enum(ADR_STATUSES).optional(),
    },
    ({ title, context, decision, consequences, status }) => {
      try {
        const proj = requireProject();
        const adr = insertAdr(db, { project_id: proj.id, title, context, decision, consequences, status });
        logAudit(db, { project_id: proj.id, event: 'adr_add', detail: `ADR-${adr.number}: ${title}`, actor: 'claude' });
        return ok(adr);
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  server.tool('crux_adr_list', 'List all ADRs for the current project',
    {},
    () => {
      try {
        const proj = requireProject();
        const adrs = listAdrs(db, proj.id);
        return ok({ count: adrs.length, adrs });
      } catch (e: unknown) { return err((e as Error).message); }
    }
  );

  // ── UI server (background HTTP, port from ~/.crux/crux.json) ─────────────
  startServer();

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
crux_roi_report, crux_spread_check, crux_project_add, crux_project_link, crux_ask,
crux_adr_add, crux_adr_list, crux_project_context, crux_switch, crux_git_commit, crux_git_push
`;
