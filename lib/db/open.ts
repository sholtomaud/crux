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
  // WAL allows one writer at a time. Under ADR-011's parallel agents that means
  // concurrent writers will collide, and without a timeout the loser fails
  // immediately with SQLITE_BUSY instead of waiting out a millisecond-scale
  // write. Set before any statement runs.
  _db.exec('PRAGMA busy_timeout = 5000;');
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

/**
 * Rebuilds `tasks` so its status CHECK accepts 'todo' instead of 'open', and
 * converts existing rows. Idempotent: a database whose constraint already
 * mentions 'todo' is left alone.
 *
 * Unlike every other migration here this cannot be an ALTER: the value lives
 * inside a CHECK constraint, and SQLite has no way to modify a constraint in
 * place. That leaves the documented table-rebuild procedure.
 *
 * The new table definition is lifted out of SCHEMA_SQL rather than retyped —
 * two copies of a 25-column table would drift, and the copy that silently wins
 * is whichever one a rebuild happens to use. Columns are copied by name, never
 * with SELECT *: a database that grew a column through one of the ALTERs above
 * has it appended at the end, so its column *order* no longer matches
 * schema.sql even though the set does.
 */
function renameOpenStatusToTodo(db: DatabaseSync): void {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
  ).get() as { sql: string } | undefined;
  if (!existing || existing.sql.includes("'todo'")) return;

  const body = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS tasks \(([\s\S]*?)\n\);/);
  if (!body) throw new Error('cannot rebuild tasks: no CREATE TABLE tasks in schema.sql');

  const nameOf = (rows: unknown[]) => (rows as Array<{ name: string }>).map(r => r.name);
  const oldCols = new Set(nameOf(db.prepare('PRAGMA table_info(tasks)').all()));

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`CREATE TABLE tasks_new (${body[1]}\n);`);
    const cols = nameOf(db.prepare('PRAGMA table_info(tasks_new)').all()).filter(c => oldCols.has(c));
    const list = cols.join(', ');

    // Convert inside the copy, not with an UPDATE afterwards: tasks_new already
    // carries the new CHECK, so an 'open' row would be rejected on the way in
    // and never live long enough to be updated.
    const selectList = cols
      .map(c => (c === 'status' ? "CASE WHEN status = 'open' THEN 'todo' ELSE status END" : c))
      .join(', ');
    db.exec(`INSERT INTO tasks_new (${list}) SELECT ${selectList} FROM tasks;`);
    db.exec('DROP TABLE tasks;');
    db.exec('ALTER TABLE tasks_new RENAME TO tasks;');
    // Indexes belonged to the dropped table and went with it.
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(project_id, status);');

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error(`tasks rebuild left ${violations.length} FK violations`);

    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
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
  if (!taskCols.includes('worktree_path')) {
    db.exec('ALTER TABLE tasks ADD COLUMN worktree_path TEXT;');
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

  // 'open' -> 'todo'. Runs last, after the ALTERs above have brought every
  // column into existence, so the rebuild copies a complete table.
  renameOpenStatusToTodo(db);

  // global_config table (idempotent — CREATE IF NOT EXISTS handles it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
