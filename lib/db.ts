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

const DEFAULT_DB_PATH = join(homedir(), '.crux', 'crux.db');

let _db: DatabaseSync | null = null;

export function openDb(path: string = DEFAULT_DB_PATH): DatabaseSync {
  if (_db) return _db;
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  _db = new DatabaseSync(path);
  _db.exec(SCHEMA_SQL);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function findRepoRoot(): string | null {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

export function readProjectPointer(): string | null {
  const root = findRepoRoot();
  if (!root) return null;
  const pointerPath = join(root, '.crux', 'project.json');
  if (!existsSync(pointerPath)) return null;
  const content = readFileSync(pointerPath, 'utf-8');
  const data = JSON.parse(content);
  return data.projectId || null;
}

export function writeProjectPointer(projectId: string): void {
  const root = findRepoRoot();
  if (!root) throw new Error('No repo root found');
  const dir = join(root, '.crux');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const pointerPath = join(dir, 'project.json');
  writeFileSync(pointerPath, JSON.stringify({ projectId }, null, 2));
}

export function resolveProject(): string {
  const pointer = readProjectPointer();
  if (pointer) return pointer;
  throw new Error('No project pointer found. Run `crux init` first.');
}

export function insertProject(name: string, type: ProjectType = 'startup'): string {
  const db = _db || openDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO projects (id, name, type, status, created_at)
    VALUES (?, ?, ?, 'active', datetime('now'))
  `).run(id, name, type);
  return id;
}

export function projectById(id: string): Project | null {
  const db = _db || openDb();
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  return row || null;
}

export function allProjects(): Project[] {
  const db = _db || openDb();
  return db.prepare('SELECT * FROM projects').all() as Project[];
}

export function updateProjectStatus(id: string, status: ProjectStatus): void {
  const db = _db || openDb();
  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, id);
}

export function updateProjectGhRepo(id: string, repo: string): void {
  const db = _db || openDb();
  db.prepare('UPDATE projects SET gh_repo = ? WHERE id = ?').run(repo, id);
}

export function updateTaskGhIssue(taskId: string, issue: string): void {
  const db = _db || openDb();
  db.prepare('UPDATE tasks SET gh_issue = ? WHERE id = ?').run(issue, taskId);
}

export function updateTaskValueScore(taskId: string, score: number): void {
  const db = _db || openDb();
  db.prepare('UPDATE tasks SET value_score = ? WHERE id = ?').run(score, taskId);
}

export function tasksByProject(projectId: string): Task[] {
  const db = _db || openDb();
  return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at').all(projectId) as Task[];
}

export function taskBySlug(projectId: string, slug: string): Task | null {
  const db = _db || openDb();
  const row = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, slug) as Task | undefined;
  return row || null;
}

export function insertTask(projectId: string, slug: string, title: string, type: TaskType = 'feature'): string {
  const db = _db || openDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO tasks (id, project_id, slug, title, type, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'todo', datetime('now'))
  `).run(id, projectId, slug, title, type);
  return id;
}

export function updateTaskStatus(taskId: string, status: TaskStatus): void {
  const db = _db || openDb();
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
}

export function updateTaskCpm(taskId: string, cpm: number): void {
  const db = _db || openDb();
  db.prepare('UPDATE tasks SET cpm = ? WHERE id = ?').run(cpm, taskId);
}

export function addDependency(taskId: string, dependsOnId: string): void {
  const db = _db || openDb();
  db.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId);
}

export function dependenciesByProject(projectId: string): { task_id: string, depends_on_id: string }[] {
  const db = _db || openDb();
  return db.prepare(`
    SELECT td.task_id, td.depends_on_id
    FROM task_dependencies td
    JOIN tasks t ON td.task_id = t.id
    WHERE t.project_id = ?
  `).all(projectId) as { task_id: string, depends_on_id: string }[];
}

export function startSession(projectId: string): string {
  const db = _db || openDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO sessions (id, project_id, started_at)
    VALUES (?, ?, datetime('now'))
  `).run(id, projectId);
  return id;
}

export function endSession(sessionId: string): void {
  const db = _db || openDb();
  db.prepare('UPDATE sessions SET ended_at = datetime(\'now\') WHERE id = ?').run(sessionId);
}

export function activeSession(projectId: string): string | null {
  const db = _db || openDb();
  const row = db.prepare(`
    SELECT id FROM sessions
    WHERE project_id = ? AND ended_at IS NULL
  `).get(projectId) as { id: string } | undefined;
  return row ? row.id : null;
}

export function insertRoi(projectId: string, kind: RoiKind, amount: number, recorded_at: string): string {
  const db = _db || openDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO roi_records (id, project_id, kind, amount, recorded_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, projectId, kind, amount, recorded_at);
  return id;
}

export function roiSummary(projectId: string): { total: number, count: number } {
  const db = _db || openDb();
  const row = db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as count
    FROM roi_records
    WHERE project_id = ?
  `).get(projectId) as { total: number | null, count: number } | undefined;
  return { total: row?.total || 0, count: row?.count || 0 };
}

export function totalHours(projectId: string): number {
  const db = _db || openDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(duration_minutes), 0) as total_minutes
    FROM sessions
    WHERE project_id = ?
  `).get(projectId) as { total_minutes: number } | undefined;
  return (row?.total_minutes || 0) / 60;
}

export function firstRevenueAt(db: DatabaseSync, projectId: string): string | null {
  const row = db.prepare(`
