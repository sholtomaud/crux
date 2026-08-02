/**
 * lib/db/dependencies.ts — task dependency edges
 */

import { DatabaseSync } from 'node:sqlite';

import type { Task } from './types.ts';

export function addDependency(db: DatabaseSync, predecessorId: number, successorId: number): void {
  db.prepare('INSERT OR IGNORE INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)')
    .run(predecessorId, successorId);
}

export function dependenciesByProject(
  db: DatabaseSync,
  projectId: string
): Array<{ predecessor_id: number; successor_id: number }> {
  return db.prepare(`
    SELECT d.predecessor_id, d.successor_id
    FROM dependencies d
    JOIN tasks t ON t.id = d.predecessor_id
    WHERE t.project_id = ?
  `).all(projectId) as Array<{ predecessor_id: number; successor_id: number }>;
}

/** Immediate DAG neighbours of one task: what it waits on, what waits on it. */
export function taskNeighbours(
  db: DatabaseSync,
  taskId: number
): { predecessors: Task[]; successors: Task[] } {
  const predecessors = db.prepare(`
    SELECT t.* FROM dependencies d
    JOIN tasks t ON t.id = d.predecessor_id
    WHERE d.successor_id = ?
    ORDER BY t.id
  `).all(taskId) as unknown as Task[];

  const successors = db.prepare(`
    SELECT t.* FROM dependencies d
    JOIN tasks t ON t.id = d.successor_id
    WHERE d.predecessor_id = ?
    ORDER BY t.id
  `).all(taskId) as unknown as Task[];

  return { predecessors, successors };
}
