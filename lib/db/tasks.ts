/**
 * lib/db/tasks.ts — task CRUD and field updates
 */

import { DatabaseSync } from 'node:sqlite';

import type { Task, TaskStatus, TaskType, TaskExecutor } from './types.ts';

export function tasksByProject(db: DatabaseSync, projectId: string): Task[] {
  return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(projectId) as unknown as Task[];
}

export function taskBySlug(db: DatabaseSync, projectId: string, slug: string): Task | null {
  return (db.prepare('SELECT * FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, slug) as unknown as Task) ?? null;
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
    task_type?: TaskType;
    executor?: TaskExecutor;
    acceptance_criteria?: string;
    files_affected?: string[];
    files_to_create?: Array<{ path: string; signature: string; imports?: string }>;
  }
): Task {
  db.prepare(`
    INSERT INTO tasks
      (project_id, slug, title, description, phase, priority, duration_days,
       coverage_target, value_score, task_type, executor, acceptance_criteria,
       files_affected, files_to_create)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    opts.task_type ?? 'coding',
    opts.executor ?? 'auto',
    opts.acceptance_criteria ?? null,
    opts.files_affected ? JSON.stringify(opts.files_affected) : null,
    opts.files_to_create ? JSON.stringify(opts.files_to_create) : null,
  );
  return taskBySlug(db, opts.project_id, opts.slug)!;
}

export function updateTaskStatus(
  db: DatabaseSync,
  projectId: string,
  slug: string,
  status: TaskStatus,
): void {
  db.prepare('UPDATE tasks SET status = ? WHERE project_id = ? AND slug = ?').run(status, projectId, slug);
}

export function updateTaskValueScore(db: DatabaseSync, taskId: number, valueScore: number): void {
  db.prepare('UPDATE tasks SET value_score = ? WHERE id = ?').run(valueScore, taskId);
}

export function updateTaskGhIssue(db: DatabaseSync, taskId: number, ghIssueNumber: number): void {
  db.prepare('UPDATE tasks SET gh_issue_number = ? WHERE id = ?').run(ghIssueNumber, taskId);
}

export function updateTaskType(db: DatabaseSync, taskId: number, taskType: TaskType): void {
  db.prepare('UPDATE tasks SET task_type = ? WHERE id = ?').run(taskType, taskId);
}

export function updateTaskSpec(
  db: DatabaseSync,
  taskId: number,
  opts: { acceptance_criteria?: string; files_affected?: string[] }
): void {
  if (opts.acceptance_criteria !== undefined) {
    db.prepare('UPDATE tasks SET acceptance_criteria = ? WHERE id = ?').run(opts.acceptance_criteria, taskId);
  }
  if (opts.files_affected !== undefined) {
    db.prepare('UPDATE tasks SET files_affected = ? WHERE id = ?').run(JSON.stringify(opts.files_affected), taskId);
  }
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
