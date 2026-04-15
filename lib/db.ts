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

const DB_PATH = join(homedir(), '.crux', 'crux.db');

function openDb(): DatabaseSync {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA_SQL);
  return db;
}

function closeDb(db: DatabaseSync): void {
  db.close();
}

function findRepoRoot(): string | null {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

function readProjectPointer(): string | null {
  const projectPath = join(homedir(), '.crux', 'project.json');
  if (!existsSync(projectPath)) return null;
  const data = readFileSync(projectPath, 'utf-8');
  const parsed = JSON.parse(data);
  return parsed.projectId || null;
}

function writeProjectPointer(projectId: string): void {
  const dir = join(homedir(), '.crux');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const data = JSON.stringify({ projectId }, null, 2);
  writeFileSync(join(dir, 'project.json'), data);
}

function resolveProject(): string | null {
  const pointer = readProjectPointer();
  if (pointer) return pointer;
  const repoRoot = findRepoRoot();
  if (!repoRoot) return null;
  const projectPath = join(repoRoot, '.crux', 'project.json');
  if (!existsSync(projectPath)) return null;
  const data = readFileSync(projectPath, 'utf-8');
  const parsed = JSON.parse(data);
  return parsed.projectId || null;
}

function insertProject(db: DatabaseSync, name: string, type: 'startup' | 'side-project' | 'enterprise' = 'startup'): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO projects (id, name, type, status, created_at)
    VALUES (?, ?, ?, 'active', datetime('now'))
  `).run(id, name, type);
  return id;
}

function projectById(db: DatabaseSync, id: string): { id: string; name: string; type: string; status: string; created_at: string } | null {
  const row = db.prepare(`SELECT id, name, type, status, created_at FROM projects WHERE id = ?`).get(id);
  return row || null;
}

function allProjects(db: DatabaseSync): Array<{ id: string; name: string; type: string; status: string; created_at: string }> {
  return db.prepare(`SELECT id, name, type, status, created_at FROM projects`).all();
}

function updateProjectStatus(db: DatabaseSync, id: string, status: string): void {
  db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(status, id);
}

function updateProjectGhRepo(db: DatabaseSync, id: string, repo: string): void {
  db.prepare(`UPDATE projects SET gh_repo = ? WHERE id = ?`).run(repo, id);
}

function updateTaskGhIssue(db: DatabaseSync, taskId: string, issue: string): void {
  db.prepare(`UPDATE tasks SET gh_issue = ? WHERE id = ?`).run(issue, taskId);
}

function updateTaskValueScore(db: DatabaseSync, taskId: string, score: number): void {
  db.prepare(`UPDATE tasks SET value_score = ? WHERE id = ?`).run(score, taskId);
}

function tasksByProject(db: DatabaseSync, projectId: string): Array<{ id: string; slug: string; title: string; status: string; type: string; estimated_hours: number; actual_hours: number; value_score: number | null; gh_issue: string | null; created_at: string }> {
  return db.prepare(`SELECT id, slug, title, status, type, estimated_hours, actual_hours, value_score, gh_issue, created_at FROM tasks WHERE project_id = ?`).all(projectId);
}

function taskBySlug(db: DatabaseSync, projectId: string, slug: string): { id: string; slug: string; title: string; status: string; type: string; estimated_hours: number; actual_hours: number; value_score: number | null; gh_issue: string | null; created_at: string } | null {
  const row = db.prepare(`SELECT id, slug, title, status, type, estimated_hours, actual_hours, value_score, gh_issue, created_at FROM tasks WHERE project_id = ? AND slug = ?`).get(projectId, slug);
  return row || null;
}

function insertTask(db: DatabaseSync, projectId: string, slug: string, title: string, type: 'feature' | 'bug' | 'research' | 'maintenance' = 'feature', estimatedHours: number = 0): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO tasks (id, project_id, slug, title, type, status, estimated_hours, actual_hours, value_score, gh_issue, created_at)
    VALUES (?, ?, ?, ?, ?, 'todo', ?, 0, NULL, NULL, datetime('now'))
  `).run(id, projectId, slug, title, type, estimatedHours);
  return id;
}

function updateTaskStatus(db: DatabaseSync, taskId: string, status: string): void {
  db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, taskId);
}

function updateTaskCpm(db: DatabaseSync, taskId: string, cpm: number): void {
  db.prepare(`UPDATE tasks SET cpm = ? WHERE id = ?`).run(cpm, taskId);
}

function addDependency(db: DatabaseSync, projectId: string, taskId: string, dependsOnId: string): void {
  db.prepare(`INSERT INTO task_dependencies (project_id, task_id, depends_on_id) VALUES (?, ?, ?)`).run(projectId, taskId, dependsOnId);
}

function dependenciesByProject(db: DatabaseSync, projectId: string): Array<{ task_id: string; depends_on_id: string }> {
  return db.prepare(`SELECT task_id, depends_on_id FROM task_dependencies WHERE project_id = ?`).all(projectId);
}

function startSession(db: DatabaseSync, taskId: string): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO sessions (id, task_id, started_at)
    VALUES (?, ?, datetime('now'))
  `).run(id, taskId);
  return id;
}

function endSession(db: DatabaseSync, sessionId: string): void {
  db.prepare(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`).run(sessionId);
}

function activeSession(db: DatabaseSync, taskId: string): { id: string; task_id: string; started_at: string; ended_at: string | null } | null {
  const row = db.prepare(`SELECT id, task_id, started_at, ended_at FROM sessions WHERE task_id = ? AND ended_at IS NULL`).get(taskId);
  return row || null;
}

function insertRoi(db: DatabaseSync, projectId: string, kind: 'revenue' | 'cost' | 'value', amount: number, recordedAt: string): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO roi_records (id, project_id, kind, amount, recorded_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, projectId, kind, amount, recordedAt);
  return id;
}

function roiSummary(db: DatabaseSync, projectId: string): { totalRevenue: number; totalCost: number; netValue: number } {
  const row = db.prepare(`
    SELECT 
      COALESCE(SUM(CASE WHEN kind = 'revenue' THEN amount ELSE 0 END), 0) as totalRevenue,
      COALESCE(SUM(CASE WHEN kind = 'cost' THEN amount ELSE 0 END), 0) as totalCost
    FROM roi_records WHERE project_id = ?
  `).get(projectId);
  return {
    totalRevenue: row?.totalRevenue || 0,
    totalCost: row?.totalCost || 0,
    netValue: (row?.totalRevenue || 0) - (row?.totalCost || 0)
  };
}
