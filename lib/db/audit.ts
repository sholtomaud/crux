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

const AUDIT_VALUE_MAX = 80;

function auditValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅';
  const s = String(v);
  return s.length > AUDIT_VALUE_MAX ? `${s.slice(0, AUDIT_VALUE_MAX - 1)}…` : s;
}

/** Audit a single-field edit as `field: before → after`, eliding long values. */
export function logFieldChange(
  db: DatabaseSync,
  opts: { project_id?: string; task_id: number; field: string; before: unknown; after: unknown; actor?: AuditActor }
): void {
  logAudit(db, {
    project_id: opts.project_id,
    task_id: opts.task_id,
    event: 'task.update',
    detail: `${opts.field}: ${auditValue(opts.before)} → ${auditValue(opts.after)}`,
    actor: opts.actor,
  });
}

export function recentAudit(db: DatabaseSync, projectId: string, limit = 20): AuditEntry[] {
  return db.prepare(
    'SELECT * FROM audit WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(projectId, limit) as unknown as AuditEntry[];
}

export function auditByTask(db: DatabaseSync, taskId: number, limit = 10): AuditEntry[] {
  return db.prepare(
    'SELECT * FROM audit WHERE task_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(taskId, limit) as unknown as AuditEntry[];
}
