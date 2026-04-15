/**
 * lib/db.ts — SQLite layer using node:sqlite (Node 25 stdlib)
 * Single global DB at ~/.crux/crux.db
 * Per-repo scoping via .crux/project.json
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { SCHEMA_SQL } from './schema-sql.ts';

const DEFAULT_DB_PATH = join(homedir(), '.crux', 'crux.db');

function openDb(path: string = DEFAULT_DB_PATH): DatabaseSync {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return new DatabaseSync(path);
}

function closeDb(db: DatabaseSync): void {
  db.close();
}

function applyMigrations(db: DatabaseSync): void {
  // Add first_revenue_at column to projects table if not exists
  try {
    db.prepare('ALTER TABLE projects ADD COLUMN first_revenue_at TEXT').run();
  } catch (e: any) {
    if (!e.message.includes('duplicate column')) {
      throw e;
    }
  }
}


