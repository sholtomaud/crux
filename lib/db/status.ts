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

  const todo       = byStatus('todo');
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
  const nextUnblocked = todo
    .filter(t => !blockedByDep.has(t.id))
    .sort((a, b) => b.priority - a.priority || taskWsjf(b) - taskWsjf(a));

  // Why nothing is ready, not just that nothing is. A finished project and one
  // stalled behind a blocker both produce an empty next_unblocked, and callers
  // that only see the empty list report them identically — the Portfolio said
  // "No open tasks" for a project holding five, every one of them gated.
  //
  // Only populated when nothing is ready, so the field means one thing:
  // non-empty is "this project is stalled". A caller cannot misread it as
  // "some work happens to be gated", which is true of almost every project.
  const slugById = new Map(tasks.map(t => [t.id, t.slug]));
  const gatedIds = new Set(todo.filter(t => blockedByDep.has(t.id)).map(t => t.id));

  const predsOf = new Map<number, number[]>();
  for (const d of deps) {
    if (!predsOf.has(d.successor_id)) predsOf.set(d.successor_id, []);
    predsOf.get(d.successor_id)!.push(d.predecessor_id);
  }

  /**
   * How much unfinished work sits upstream of a task. Used only to order the
   * blockers, so the most upstream one — the thing somebody could actually act
   * on — is named first. Without it a gated chain reads as four slugs where
   * three are only waiting their turn. `seen` guards against a cyclic DAG,
   * which computeCpm rejects but which must not hang a status rollup.
   */
  const depthOf = (id: number, seen = new Set<number>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const ups = (predsOf.get(id) ?? []).filter(p => !doneIds.has(p));
    return ups.length === 0 ? 0 : 1 + Math.max(...ups.map(p => depthOf(p, seen)));
  };

  const blockedBy = nextUnblocked.length > 0 ? [] : [...new Set(
    deps
      .filter(d => !doneIds.has(d.predecessor_id) && gatedIds.has(d.successor_id))
      .map(d => d.predecessor_id)
  )]
    .sort((a, b) => depthOf(a) - depthOf(b) || (slugById.get(a) ?? '').localeCompare(slugById.get(b) ?? ''))
    .map(id => slugById.get(id))
    .filter((s): s is string => s !== undefined);

  return {
    project_id:     projectId,
    total:          tasks.length,
    todo:           todo.length,
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
    /** Incomplete predecessors gating every remaining todo task. Empty when
     *  next_unblocked is non-empty, or when there is simply no todo work left. */
    blocked_by:     blockedBy,
  };
}
