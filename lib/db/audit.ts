/**
 * lib/db/audit.ts — audit log write and read
 */

import { DatabaseSync } from 'node:sqlite';

import type { AuditEntry, AuditActor } from './types.ts';

export function logAudit(
  db: DatabaseSync,
  opts: { project_id?: string; task_id?: number; event: string; detail?: string; actor?: AuditActor }
): void {
  db.prepare(`
    INSERT INTO audit (project_id, task_id, event, detail, actor)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    opts.project_id ?? null,
    opts.task_id ?? null,
    opts.event,
    opts.detail ?? null,
    opts.actor ?? 'human',
  );
}

export function recentAudit(db: DatabaseSync, projectId: string, limit = 20): AuditEntry[] {
  return db.prepare(
    'SELECT * FROM audit WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(projectId, limit) as unknown as AuditEntry[];
}
