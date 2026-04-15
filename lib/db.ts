/**
 * lib/db.ts — SQLite layer using node:sqlite (Node 25 stdlib)
 * Single global DB at ~/.crux/crux.db
 * Per-repo scoping via .crux/project.json
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { SCHEMA_SQL } from './schema-sql.ts';

// ── Paths ─────────────────────────────────────────────────────────────────────

export const CRUX_DIR  = join(homedir(), '.crux');
export const DB_PATH   = join(CRUX_DIR, 'crux.db');

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProjectType   = 'code_repo' | 'article' | 'research' | 'freelance' | 'learning' | 'personal';
export type ProjectStatus = 'active' | 'stalled' | 'paused' | 'done' | 'dropped';
export type TaskStatus    = 'open' | 'in-progress' | 'blocked' | 'done' | 'dropped';
export type AuditActor    = 'human' | 'crux-auto' | 'claude';
export type TestPhase     = 'build' | 'test-c' | 'test-python' | 'lint';
export type RoiKind       = 'revenue' | 'cost' | 'expected';

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  gh_repo: string | null;
  gh_sync: number;
  sheets_id: string | null;
  hourly_rate: number | null;
  created_at: string;
}

export interface Task {
  id: number;
  project_id: string;
  slug: string;
  title: string;
  description: string | null;
  phase: string | null;
  status: TaskStatus;
  priority: number;
  duration_days: number | null;
  early_start: number | null;
  early_finish: number | null;
  late_start: number | null;
  late_finish: number | null;
  float_days: number | null;
  is_critical: number;
  gh_issue_number: number | null;
  coverage_target: number | null;
  value_score: number | null;
  created_at: string;
}

export interface Session {
  id: number;
  project_id: string;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  minutes: number | null;
}

export interface RoiRecord {
  id: number;
  project_id: string;
  recorded_at: string;
  amount: number;
  currency: string;
  kind: RoiKind;
  probability: number;
  note: string | null;
}

export interface TestRun {
  id: number;
  project_id: string;
  task_slug: string | null;
  run_at: string;
  phase: TestPhase | null;
  status: 'pass' | 'fail';
  coverage: number | null;
  output: string | null;
  commit_sha: string | null;
}

export interface AuditEntry {
  id: number;
  project_id: string | null;
  task_id: number | null;
  event: string;
  detail: string | null;
  actor: AuditActor;
  created_at: string;
}

// ── Open / migrate ─────────────────────────────────────────────────────────────

let _db: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(CRUX_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  applySchema(_db);
  applyMigrations(_db);
  return _db;
}

function applySchema(db: DatabaseSync): void {
  for (const stmt of SCHEMA_SQL.split(';').map((s: string) => s.trim()).filter(Boolean)) {
    db.exec(stmt + ';');
  }
}

function applyMigrations(db: DatabaseSync): void {
  const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(r => r.name);
  if (!cols.includes('value_score')) {
    db.exec('ALTER TABLE tasks ADD COLUMN value_score REAL;');
  }
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}

// ── Repo scoping ───────────────────────────────────────────────────────────────

export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.crux'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readProjectPointer(repoRoot: string): string | null {
  const ptr = join(repoRoot, '.crux', 'project.json');
  if (!existsSync(ptr)) return null;
  try {
    const data = JSON.parse(readFileSync(ptr, 'utf8')) as { project_id?: string };
    return data.project_id ?? null;
  } catch { return null; }
}

export function writeProjectPointer(repoRoot: string, projectId: string): void {
  const dir = join(repoRoot, '.crux');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ project_id: projectId }, null, 2));
}

/** Resolve active project: from pointer file, or single active project, or null */
export function resolveProject(db: DatabaseSync, repoRoot: string | null = findRepoRoot()): Project | null {
  if (repoRoot) {
    const id = readProjectPointer(repoRoot);
    if (id) return projectById(db, id);
  }
  return null;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export function projectById(db: DatabaseSync, id: string): Project | null {
  const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
  return (stmt.get(id) as Project) ?? null;
}

export function allProjects(db: DatabaseSync): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[];
}

export function insertProject(
  db: DatabaseSync,
  opts: { name: string; type: ProjectType; gh_repo?: string; hourly_rate?: number }
): Project {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO projects (id, name, type, gh_repo, hourly_rate)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, opts.name, opts.type, opts.gh_repo ?? null, opts.hourly_rate ?? null);
  return projectById(db, id)!;
}

export function updateProjectStatus(db: DatabaseSync, id: string, status: ProjectStatus): void {
  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, id);
}

export function updateProjectGhRepo(db: DatabaseSync, id: string, ghRepo: string): void {
  db.prepare('UPDATE projects SET gh_repo = ? WHERE id = ?').run(ghRepo, id);
}

// ── Tasks ──────────────────────────────────────────────────────────────────────

export function tasksByProject(db: DatabaseSync, projectId: string): Task[] {
  return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(projectId) as Task[];
}

export function taskBySlug(db: DatabaseSync, projectId: string, slug: string): Task | null {
  return (db.prepare('SELECT * FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, slug) as Task) ?? null;
}

export function insertTask(
  db: DatabaseSync,
  opts: {
    project_id: string;
    slug: string;
    title: string;
    description?: string;
    phase?: string;
    priority?: number;
    duration_days?: number;
    coverage_target?: number;
    value_score?: number;
  }
): Task {
  db.prepare(`
    INSERT INTO tasks (project_id, slug, title, description, phase, priority, duration_days, coverage_target, value_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.project_id,
    opts.slug,
    opts.title,
    opts.description ?? null,
    opts.phase ?? null,
    opts.priority ?? 0,
    opts.duration_days ?? null,
    opts.coverage_target ?? null,
    opts.value_score ?? null,
  );
  return taskBySlug(db, opts.project_id, opts.slug)!;
}

export function updateTaskValueScore(db: DatabaseSync, taskId: number, valueScore: number): void {
  db.prepare('UPDATE tasks SET value_score = ? WHERE id = ?').run(valueScore, taskId);
}

export function updateTaskStatus(
  db: DatabaseSync,
  projectId: string,
  slug: string,
  status: TaskStatus,
): void {
  db.prepare('UPDATE tasks SET status = ? WHERE project_id = ? AND slug = ?').run(status, projectId, slug);
}

export function updateTaskGhIssue(db: DatabaseSync, taskId: number, ghIssueNumber: number): void {
  db.prepare('UPDATE tasks SET gh_issue_number = ? WHERE id = ?').run(ghIssueNumber, taskId);
}

export function updateTaskCpm(
  db: DatabaseSync,
  taskId: number,
  fields: {
    early_start: number;
    early_finish: number;
    late_start: number;
    late_finish: number;
    float_days: number;
    is_critical: number;
  }
): void {
  db.prepare(`
    UPDATE tasks SET
      early_start  = ?,
      early_finish = ?,
      late_start   = ?,
      late_finish  = ?,
      float_days   = ?,
      is_critical  = ?
    WHERE id = ?
  `).run(
    fields.early_start,
    fields.early_finish,
    fields.late_start,
    fields.late_finish,
    fields.float_days,
    fields.is_critical,
    taskId,
  );
}

// ── Dependencies ──────────────────────────────────────────────────────────────

export function addDependency(db: DatabaseSync, predecessorId: number, successorId: number): void {
  db.prepare('INSERT OR IGNORE INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)')
    .run(predecessorId, successorId);
}

export function dependenciesByProject(db: DatabaseSync, projectId: string): Array<{ predecessor_id: number; successor_id: number }> {
  return db.prepare(`
    SELECT d.predecessor_id, d.successor_id
    FROM dependencies d
    JOIN tasks t ON t.id = d.predecessor_id
    WHERE t.project_id = ?
  `).all(projectId) as Array<{ predecessor_id: number; successor_id: number }>;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export function startSession(db: DatabaseSync, projectId: string, note?: string): Session {
  const result = db.prepare(`
    INSERT INTO sessions (project_id, note) VALUES (?, ?)
  `).run(projectId, note ?? null);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid) as Session;
}

export function endSession(db: DatabaseSync, sessionId: number, note?: string): Session {
  db.prepare(`
    UPDATE sessions
    SET ended_at = datetime('now'),
        minutes  = (julianday('now') - julianday(started_at)) * 1440,
        note     = COALESCE(?, note)
    WHERE id = ?
  `).run(note ?? null, sessionId);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session;
}

export function activeSession(db: DatabaseSync, projectId: string): Session | null {
  return (db.prepare('SELECT * FROM sessions WHERE project_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(projectId) as Session) ?? null;
}

export function totalHours(db: DatabaseSync, projectId: string): number {
  const row = db.prepare('SELECT SUM(minutes) as total FROM sessions WHERE project_id = ? AND ended_at IS NOT NULL').get(projectId) as { total: number | null };
  return (row.total ?? 0) / 60;
}

// ── ROI ───────────────────────────────────────────────────────────────────────

export function insertRoi(
  db: DatabaseSync,
  opts: { project_id: string; amount: number; kind: RoiKind; currency?: string; probability?: number; note?: string }
): void {
  db.prepare(`
    INSERT INTO roi_records (project_id, amount, kind, currency, probability, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.project_id,
    opts.amount,
    opts.kind,
    opts.currency ?? 'AUD',
    opts.probability ?? 1.0,
    opts.note ?? null,
  );
}

export function roiSummary(db: DatabaseSync, projectId: string): { revenue: number; cost: number; expected: number } {
  const rows = db.prepare(`
    SELECT kind, SUM(amount * probability) as total
    FROM roi_records WHERE project_id = ?
    GROUP BY kind
  `).all(projectId) as Array<{ kind: string; total: number }>;
  const out = { revenue: 0, cost: 0, expected: 0 };
  for (const r of rows) out[r.kind as RoiKind] = r.total;
  return out;
}

// ── Test runs ─────────────────────────────────────────────────────────────────

export function insertTestRun(
  db: DatabaseSync,
  opts: {
    project_id: string;
    phase: TestPhase;
    status: 'pass' | 'fail';
    task_slug?: string;
    coverage?: number;
    output?: string;
    commit_sha?: string;
  }
): TestRun {
  const result = db.prepare(`
    INSERT INTO test_runs (project_id, task_slug, phase, status, coverage, output, commit_sha)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.project_id,
    opts.task_slug ?? null,
    opts.phase,
    opts.status,
    opts.coverage ?? null,
    opts.output ?? null,
    opts.commit_sha ?? null,
  );
  return db.prepare('SELECT * FROM test_runs WHERE id = ?').get(result.lastInsertRowid) as TestRun;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export function logAudit(
  db: DatabaseSync,
  opts: { project_id?: string; task_id?: number; event: string; detail?: string; actor?: AuditActor }
): void {
  db.prepare(`
    INSERT INTO audit (project_id, task_id, event, detail, actor)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    opts.project_id ?? null,
    opts.task_id ?? null,
    opts.event,
    opts.detail ?? null,
    opts.actor ?? 'human',
  );
}

export function recentAudit(db: DatabaseSync, projectId: string, limit = 20): AuditEntry[] {
  return db.prepare('SELECT * FROM audit WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as AuditEntry[];
}

// ── ADRs ──────────────────────────────────────────────────────────────────────

export interface Adr {
  id: number;
  project_id: string;
  number: number;
  title: string;
  status: 'proposed' | 'accepted' | 'deprecated' | 'superseded';
  context: string | null;
  decision: string | null;
  consequences: string | null;
  created_at: string;
}

export function insertAdr(
  db: DatabaseSync,
  opts: { project_id: string; title: string; context?: string; decision?: string; consequences?: string; status?: Adr['status'] }
): Adr {
  const next = (db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM adrs WHERE project_id = ?').get(opts.project_id) as { n: number }).n;
  db.prepare(`
    INSERT INTO adrs (project_id, number, title, status, context, decision, consequences)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.project_id,
    next,
    opts.title,
    opts.status ?? 'accepted',
    opts.context ?? null,
    opts.decision ?? null,
    opts.consequences ?? null,
  );
  return db.prepare('SELECT * FROM adrs WHERE project_id = ? AND number = ?').get(opts.project_id, next) as Adr;
}

export function listAdrs(db: DatabaseSync, projectId: string): Adr[] {
  return db.prepare('SELECT * FROM adrs WHERE project_id = ? ORDER BY number').all(projectId) as Adr[];
}

// ── Status query (for crux status / crux_status) ──────────────────────────────

export function projectStatus(db: DatabaseSync, projectId: string) {
  const tasks = tasksByProject(db, projectId);
  const byStatus = (s: TaskStatus) => tasks.filter(t => t.status === s);

  const open       = byStatus('open');
  const inProgress = byStatus('in-progress');
  const blocked    = byStatus('blocked');
  const done       = byStatus('done');

  // Next unblocked: open tasks whose predecessors are all done
  const doneIds = new Set(done.map(t => t.id));
  const deps = dependenciesByProject(db, projectId);
  const blockedByDep = new Set(
    deps.filter(d => !doneIds.has(d.predecessor_id)).map(d => d.successor_id)
  );
  const nextUnblocked = open.filter(t => !blockedByDep.has(t.id));

  return {
    project_id:    projectId,
    total:         tasks.length,
    open:          open.length,
    in_progress:   inProgress.length,
    blocked:       blocked.length,
    done:          done.length,
    next_unblocked: nextUnblocked.slice(0, 10).map(t => ({ slug: t.slug, title: t.title, phase: t.phase })),
    blockers:      blocked.map(t => ({ slug: t.slug, title: t.title })),
  };
}
