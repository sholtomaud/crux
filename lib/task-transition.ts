/**
 * lib/task-transition.ts — the guarded way to change a task's status (ADR-011)
 *
 * `updateTaskStatus` stays a bare UPDATE for internal machinery that has
 * already earned the transition (workflow.ts moves a task to done only after
 * real tests passed). This is the path for a status *asserted* by a human or an
 * agent — CLI, MCP, the web UI, the agent's own `crux_task_update` tool.
 *
 * Guards are evaluated inside `BEGIN IMMEDIATE`, not before it. Today crux is
 * single-process and a check-then-write is safe by construction; under ADR-011's
 * worktree fan-out it stops being safe, and the fix has to be an actual write
 * transaction because an in-process lock cannot span processes. Doing it now
 * means the fan-out doesn't have to retrofit every call site.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { TaskStatus } from './db/types.ts';
import { taskBySlug, updateTaskStatus } from './db/tasks.ts';
import { logAudit } from './db/audit.ts';
import { evaluateTransition, guardPolicy, formatFailures } from './guards.ts';
import type { GuardFailure } from './guards.ts';

export interface TransitionResult {
  applied:  boolean;
  /** Guard objections. Present on success too — that is what 'warn' means. */
  warnings: GuardFailure[];
  /** Set when `applied` is false. */
  blocked?: string;
}

export function applyTaskStatus(
  db: DatabaseSync,
  projectId: string,
  slug: string,
  status: TaskStatus,
  opts: { actor?: 'human' | 'crux-auto' | 'claude' } = {},
): TransitionResult {
  const policy = guardPolicy(db);
  if (policy === 'off') {
    updateTaskStatus(db, projectId, slug, status);
    return { applied: true, warnings: [] };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const task = taskBySlug(db, projectId, slug);
    if (!task) {
      db.exec('ROLLBACK');
      return { applied: false, warnings: [], blocked: `task not found: ${slug}` };
    }

    const failures = evaluateTransition(db, task, status);

    if (failures.length > 0 && policy === 'enforce') {
      db.exec('ROLLBACK');
      return { applied: false, warnings: failures, blocked: formatFailures(failures) };
    }

    updateTaskStatus(db, projectId, slug, status);

    // Warned-through transitions are recorded, so "we shipped it anyway" stays
    // auditable rather than living only in a terminal that has scrolled away.
    if (failures.length > 0) {
      logAudit(db, {
        project_id: projectId,
        task_id:    task.id,
        event:      'task.guard-warning',
        detail:     `${task.status} → ${status}: ${formatFailures(failures)}`,
        actor:      opts.actor ?? 'human',
      });
    }

    db.exec('COMMIT');
    return { applied: true, warnings: failures };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}
