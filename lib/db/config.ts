/**
 * lib/db/config.ts — global key/value config (active project, defaults)
 */

import { DatabaseSync } from 'node:sqlite';

export function getConfig(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM global_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setConfig(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO global_config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

export function getActiveProjectId(db: DatabaseSync): string | null {
  return getConfig(db, 'active_project_id');
}

export function setActiveProjectId(db: DatabaseSync, projectId: string): void {
  setConfig(db, 'active_project_id', projectId);
}
