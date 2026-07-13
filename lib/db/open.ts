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
  const taskCols    = (db.prepare('PRAGMA table_info(tasks)').all()    as Array<{ name: string }>).map(r => r.name);
  const projCols    = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(r => r.name);
  const sessionCols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(r => r.name);

  // tasks migrations
  if (!taskCols.includes('value_score')) {
    db.exec('ALTER TABLE tasks ADD COLUMN value_score REAL;');
  }
  if (!taskCols.includes('task_type')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'coding'
             CHECK(task_type IN ('coding','writing','research','accounting','verification','design','other'));`);
  }
  if (!taskCols.includes('acceptance_criteria')) {
    db.exec('ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;');
  }
  if (!taskCols.includes('files_affected')) {
    db.exec('ALTER TABLE tasks ADD COLUMN files_affected TEXT;');
  }
  if (!taskCols.includes('executor')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN executor TEXT NOT NULL DEFAULT 'auto'
             CHECK(executor IN ('llm','human','hybrid','auto'));`);
  }
  if (!taskCols.includes('files_to_create')) {
    db.exec('ALTER TABLE tasks ADD COLUMN files_to_create TEXT;');
  }
  if (!taskCols.includes('actual_days')) {
    db.exec('ALTER TABLE tasks ADD COLUMN actual_days REAL;');
  }
  if (!taskCols.includes('estimated_by')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN estimated_by TEXT NOT NULL DEFAULT 'human'
             CHECK(estimated_by IN ('human','claude','auto'));`);
  }

  // projects migrations
  if (!projCols.includes('project_number')) {
    db.exec('ALTER TABLE projects ADD COLUMN project_number INTEGER;');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_number ON projects(project_number);');
    db.exec(`
      UPDATE projects
      SET project_number = (
        SELECT COUNT(*) FROM projects p2 WHERE p2.rowid <= projects.rowid
      );
    `);
  }
  if (!projCols.includes('run_env')) {
    db.exec(`ALTER TABLE projects ADD COLUMN run_env TEXT NOT NULL DEFAULT 'shell'
             CHECK(run_env IN ('shell','container'));`);
  }
  if (!projCols.includes('verify_cmd')) {
    db.exec('ALTER TABLE projects ADD COLUMN verify_cmd TEXT;');
  }
  if (!projCols.includes('test_cmd')) {
    db.exec('ALTER TABLE projects ADD COLUMN test_cmd TEXT;');
  }
  if (!projCols.includes('container_image')) {
    db.exec('ALTER TABLE projects ADD COLUMN container_image TEXT;');
  }
  if (!projCols.includes('daily_cost')) {
    db.exec('ALTER TABLE projects ADD COLUMN daily_cost REAL;');
  }
  if (!projCols.includes('repo_path')) {
    db.exec('ALTER TABLE projects ADD COLUMN repo_path TEXT;');
  }

  // sessions migrations
  if (!sessionCols.includes('container_name')) {
    db.exec('ALTER TABLE sessions ADD COLUMN container_name TEXT;');
  }

  // global_config table (idempotent — CREATE IF NOT EXISTS handles it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
