/**
 * lib/db/status.ts — project status rollup (task counts, next unblocked)
 */

import { DatabaseSync } from 'node:sqlite';

import type { Task, TaskStatus } from './types.ts';
import { tasksByProject } from './tasks.ts';
import { dependenciesByProject } from './dependencies.ts';

/** value_score / duration_days per ADR-004 — 0 when either is unset (can't be computed). */
export function taskWsjf(task: Pick<Task, 'value_score' | 'duration_days'>): number {
  if (task.value_score == null || !task.duration_days) return 0;
  return task.value_score / task.duration_days;
}

export function projectStatus(db: DatabaseSync, projectId: string) {
  const tasks = tasksByProject(db, projectId);
  const byStatus = (s: TaskStatus) => tasks.filter(t => t.status === s);

  const open       = byStatus('open');
  const inProgress = byStatus('in-progress');
  const blocked    = byStatus('blocked');
  const done       = byStatus('done');

  const doneIds = new Set(done.map(t => t.id));
  const deps    = dependenciesByProject(db, projectId);
  const blockedByDep = new Set(
    deps.filter(d => !doneIds.has(d.predecessor_id)).map(d => d.successor_id)
  );
  // Explicit priority (an intentional override) wins; ties broken by WSJF —
  // the common case today is priority=0 on every task (unset), so WSJF is
  // what actually orders the list in practice.
  const nextUnblocked = open
    .filter(t => !blockedByDep.has(t.id))
    .sort((a, b) => b.priority - a.priority || taskWsjf(b) - taskWsjf(a));

  return {
    project_id:     projectId,
    total:          tasks.length,
    open:           open.length,
    in_progress:    inProgress.length,
    blocked:        blocked.length,
    done:           done.length,
    next_unblocked: nextUnblocked.slice(0, 10).map(t => ({
      slug:          t.slug,
      title:         t.title,
      phase:         t.phase,
      executor:      t.executor,
      task_type:     t.task_type,
      priority:      t.priority,
      value_score:   t.value_score,
      duration_days: t.duration_days,
      wsjf:          Math.round(taskWsjf(t) * 10) / 10,
    })),
    blockers:       blocked.map(t => ({ slug: t.slug, title: t.title })),
  };
}
