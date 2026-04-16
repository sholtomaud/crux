/**
 * lib/db/status.ts — project status rollup (task counts, next unblocked)
 */

import { DatabaseSync } from 'node:sqlite';

import type { TaskStatus } from './types.ts';
import { tasksByProject } from './tasks.ts';
import { dependenciesByProject } from './dependencies.ts';

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
  const nextUnblocked = open.filter(t => !blockedByDep.has(t.id));

  return {
    project_id:     projectId,
    total:          tasks.length,
    open:           open.length,
    in_progress:    inProgress.length,
    blocked:        blocked.length,
    done:           done.length,
    next_unblocked: nextUnblocked.slice(0, 10).map(t => ({ slug: t.slug, title: t.title, phase: t.phase })),
    blockers:       blocked.map(t => ({ slug: t.slug, title: t.title })),
  };
}
