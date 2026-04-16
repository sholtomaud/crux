/**
 * lib/db/open.ts — database initialisation and migrations
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { SCHEMA_SQL } from '../schema-sql.ts';

export const CRUX_DIR = join(homedir(), '.crux');
export const DB_PATH  = join(CRUX_DIR, 'crux.db');

let _db: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(CRUX_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  applySchema(_db);
  applyMigrations(_db);
  return _db;
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}

function applySchema(db: DatabaseSync): void {
  for (const stmt of SCHEMA_SQL.split(';').map((s: string) => s.trim()).filter(Boolean)) {
    db.exec(stmt + ';');
  }
}

export function applyMigrations(db: DatabaseSync): void {
  const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(r => r.name);
  if (!cols.includes('value_score')) {
    db.exec('ALTER TABLE tasks ADD COLUMN value_score REAL;');
  }
  if (!cols.includes('task_type')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'coding'
             CHECK(task_type IN ('coding','writing','research','accounting','verification','design','other'));`);
  }
  if (!cols.includes('acceptance_criteria')) {
    db.exec('ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;');
  }
  if (!cols.includes('files_affected')) {
    db.exec('ALTER TABLE tasks ADD COLUMN files_affected TEXT;');
  }
}
