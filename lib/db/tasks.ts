/**
 * lib/db/tasks.ts — task CRUD and field updates
 */

import { DatabaseSync } from 'node:sqlite';

import type { Task, TaskStatus, TaskType, TaskExecutor, EstimatedBy } from './types.ts';

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

export function updateTaskPriority(db: DatabaseSync, taskId: number, priority: number): void {
  db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(priority, taskId);
}

export function updateTaskActualDays(
  db: DatabaseSync,
  taskId: number,
  actualDays: number,
  estimatedBy?: EstimatedBy,
): void {
  if (estimatedBy !== undefined) {
    db.prepare('UPDATE tasks SET actual_days = ?, estimated_by = ? WHERE id = ?').run(actualDays, estimatedBy, taskId);
  } else {
    db.prepare('UPDATE tasks SET actual_days = ? WHERE id = ?').run(actualDays, taskId);
  }
}

export function updateTaskGhIssue(db: DatabaseSync, taskId: number, ghIssueNumber: number): void {
  db.prepare('UPDATE tasks SET gh_issue_number = ? WHERE id = ?').run(ghIssueNumber, taskId);
}

export function updateTaskWorktreePath(db: DatabaseSync, taskId: number, worktreePath: string): void {
  db.prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run(worktreePath, taskId);
}

export function updateTaskType(db: DatabaseSync, taskId: number, taskType: TaskType): void {
  db.prepare('UPDATE tasks SET task_type = ? WHERE id = ?').run(taskType, taskId);
}

export function updateTaskExecutor(db: DatabaseSync, taskId: number, executor: TaskExecutor): void {
  db.prepare('UPDATE tasks SET executor = ? WHERE id = ?').run(executor, taskId);
}

export function updateTaskProject(db: DatabaseSync, taskId: number, projectId: string): void {
  db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(projectId, taskId);
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

/**
 * Every task column a human may edit directly. The CPM columns are absent on
 * purpose — they are computed by lib/cpm.ts, so letting an edit set them would
 * let the UI write a schedule the graph never derived. id, project_id, slug,
 * created_at and worktree_path are identity/provenance and are not editable.
 *
 * This list is also the SQL injection boundary: column names are interpolated
 * into the UPDATE below, so they must only ever come from this frozen literal —
 * never from a request body. Callers pass values, never column names.
 */
export const UPDATABLE_TASK_FIELDS = [
  'title', 'description', 'phase', 'priority',
  'duration_days', 'value_score', 'task_type', 'executor',
  'acceptance_criteria',
] as const;

export type UpdatableTaskField = typeof UPDATABLE_TASK_FIELDS[number];
export type TaskFieldPatch = Partial<Record<UpdatableTaskField, string | number | null>>;

/**
 * Applies a partial patch in one statement and returns the columns it actually
 * wrote, so callers can audit precisely what changed.
 *
 * `undefined` means "not supplied" and is skipped; `null` means "clear this
 * column" and is written. An empty patch writes nothing at all.
 */
export function updateTaskFields(
  db: DatabaseSync,
  taskId: number,
  opts: TaskFieldPatch,
): UpdatableTaskField[] {
  const cols = UPDATABLE_TASK_FIELDS.filter(c => opts[c] !== undefined);
  if (cols.length === 0) return [];

  db.prepare(`UPDATE tasks SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map(c => opts[c] as string | number | null), taskId);

  return [...cols];
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
