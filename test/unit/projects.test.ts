/**
 * test/unit/projects.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { applyMigrations } from '../../lib/db/open.ts';
import { insertProject, allProjects, projectById, updateProjectDailyCost, setDefaultDailyCost, resolveDailyCost, updateProjectRepoPath } from '../../lib/db/projects.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SCHEMA     = join(__dirname, '../../schema.sql');

function makeDb(): DatabaseSync {
  const db  = new DatabaseSync(':memory:');
  const sql = readFileSync(SCHEMA, 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    db.exec(stmt + ';');
  }
  applyMigrations(db);
  return db;
}

describe('project_number', () => {
  test('assigned sequentially starting at 1', () => {
    const db = makeDb();
    const p1 = insertProject(db, { name: 'Alpha', type: 'personal' });
    const p2 = insertProject(db, { name: 'Beta',  type: 'code_repo' });
    const p3 = insertProject(db, { name: 'Gamma', type: 'research' });
    assert.equal(p1.project_number, 1);
    assert.equal(p2.project_number, 2);
    assert.equal(p3.project_number, 3);
  });

  test('allProjects returns in project_number ASC order', () => {
    const db = makeDb();
    insertProject(db, { name: 'Alpha', type: 'personal' });
    insertProject(db, { name: 'Beta',  type: 'code_repo' });
    insertProject(db, { name: 'Gamma', type: 'research' });
    const all = allProjects(db);
    assert.equal(all.length, 3);
    assert.equal(all[0].name, 'Alpha');
    assert.equal(all[1].name, 'Beta');
    assert.equal(all[2].name, 'Gamma');
  });

  test('switch number matching resolves correct project', () => {
    const db = makeDb();
    insertProject(db, { name: 'Alpha', type: 'personal' });
    const p2 = insertProject(db, { name: 'Beta', type: 'code_repo' });
    const all = allProjects(db);
    const match = all.find(p =>
      p.id === '2' ||
      String(p.project_number) === '2' ||
      p.name.toLowerCase().includes('2')
    );
    assert.ok(match, 'should find project by number string "2"');
    assert.equal(match!.id, p2.id);
  });

  test('applyMigrations backfills project_number on existing rows', () => {
    // Build a DB with schema but forcibly remove project_number to simulate pre-migration state
    const db  = new DatabaseSync(':memory:');
    const sql = readFileSync(SCHEMA, 'utf8');
    // Apply schema without project_number column by recreating projects table without it
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'personal', status TEXT NOT NULL DEFAULT 'active',
        gh_repo TEXT, gh_sync INTEGER NOT NULL DEFAULT 0, sheets_id TEXT,
        hourly_rate REAL, run_env TEXT NOT NULL DEFAULT 'shell',
        verify_cmd TEXT, test_cmd TEXT, container_image TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS global_config (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, slug TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', priority INTEGER NOT NULL DEFAULT 0,
        task_type TEXT NOT NULL DEFAULT 'coding', executor TEXT NOT NULL DEFAULT 'auto',
        is_critical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, slug)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT, note TEXT,
        minutes REAL, container_name TEXT
      );
    `);
    const id1 = randomUUID();
    const id2 = randomUUID();
    db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id1, 'Old1', 'personal');
    db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id2, 'Old2', 'personal');
    applyMigrations(db);
    const p1 = projectById(db, id1)!;
    const p2 = projectById(db, id2)!;
    assert.ok(p1.project_number >= 1, 'p1 should have a project_number');
    assert.ok(p2.project_number >= 1, 'p2 should have a project_number');
    assert.notEqual(p1.project_number, p2.project_number, 'numbers must be unique');
  });
});

describe('repo_path', () => {
  test('null by default, set via updateProjectRepoPath', () => {
    const db = makeDb();
    const p  = insertProject(db, { name: 'Alpha', type: 'code_repo' });
    assert.equal(p.repo_path, null);
    updateProjectRepoPath(db, p.id, '/Users/sholtomaud/Development/crux');
    const updated = projectById(db, p.id)!;
    assert.equal(updated.repo_path, '/Users/sholtomaud/Development/crux');
  });

  test('applyMigrations adds repo_path column to a legacy DB missing it', () => {
    const db  = new DatabaseSync(':memory:');
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'personal', status TEXT NOT NULL DEFAULT 'active',
        gh_repo TEXT, gh_sync INTEGER NOT NULL DEFAULT 0, sheets_id TEXT,
        hourly_rate REAL, run_env TEXT NOT NULL DEFAULT 'shell',
        verify_cmd TEXT, test_cmd TEXT, container_image TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS global_config (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, slug TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', priority INTEGER NOT NULL DEFAULT 0,
        task_type TEXT NOT NULL DEFAULT 'coding', executor TEXT NOT NULL DEFAULT 'auto',
        is_critical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, slug)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT, note TEXT,
        minutes REAL, container_name TEXT
      );
    `);
    const id = randomUUID();
    db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, 'Legacy', 'code_repo');
    applyMigrations(db);
    updateProjectRepoPath(db, id, '/tmp/legacy-repo');
    const proj = projectById(db, id)!;
    assert.equal(proj.repo_path, '/tmp/legacy-repo');
  });
});

describe('daily_cost', () => {
  test('null by default when no override or global default is set', () => {
    const db = makeDb();
    const p  = insertProject(db, { name: 'Alpha', type: 'personal' });
    assert.equal(resolveDailyCost(db, p), null);
  });

  test('falls back to global default_daily_cost when project has no override', () => {
    const db = makeDb();
    const p  = insertProject(db, { name: 'Alpha', type: 'personal' });
    setDefaultDailyCost(db, 120);
    assert.equal(resolveDailyCost(db, p), 120);
  });

  test('per-project override wins over the global default', () => {
    const db = makeDb();
    const p  = insertProject(db, { name: 'Alpha', type: 'personal' });
    setDefaultDailyCost(db, 120);
    updateProjectDailyCost(db, p.id, 200);
    const updated = projectById(db, p.id)!;
    assert.equal(resolveDailyCost(db, updated), 200);
  });
});
