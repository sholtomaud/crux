/**
 * lib/db/sessions.ts — time-tracking sessions
 */

import { DatabaseSync } from 'node:sqlite';

import type { Session } from './types.ts';

export function startSession(db: DatabaseSync, projectId: string, note?: string): Session {
  const result = db.prepare(`
    INSERT INTO sessions (project_id, note) VALUES (?, ?)
  `).run(projectId, note ?? null);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid) as unknown as Session;
}

export function endSession(db: DatabaseSync, sessionId: number, note?: string): Session {
  db.prepare(`
    UPDATE sessions
    SET ended_at = datetime('now'),
        minutes  = (julianday('now') - julianday(started_at)) * 1440,
        note     = COALESCE(?, note)
    WHERE id = ?
  `).run(note ?? null, sessionId);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as unknown as Session;
}

export function activeSession(db: DatabaseSync, projectId: string): Session | null {
  return (db.prepare(
    'SELECT * FROM sessions WHERE project_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(projectId) as unknown as Session) ?? null;
}

export function updateSessionContainerName(db: DatabaseSync, sessionId: number, containerName: string): void {
  db.prepare('UPDATE sessions SET container_name = ? WHERE id = ?').run(containerName, sessionId);
}

export function totalHours(db: DatabaseSync, projectId: string): number {
  const row = db.prepare(
    'SELECT SUM(minutes) as total FROM sessions WHERE project_id = ? AND ended_at IS NOT NULL'
  ).get(projectId) as { total: number | null };
  return (row.total ?? 0) / 60;
}
