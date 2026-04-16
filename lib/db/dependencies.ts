/**
 * lib/db/dependencies.ts — task dependency edges
 */

import { DatabaseSync } from 'node:sqlite';

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
