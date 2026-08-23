/**
 * test/unit/status-rename-migration.test.ts
 *
 * 'open' → 'todo' is the first migration in crux that rebuilds a table rather
 * than adding a column, and it runs against databases holding real work. A
 * mistake here does not throw — it silently drops rows, loses a column, or
 * orphans the dependency edges that the CPM graph is drawn from.
 *
 * So this seeds a database with the OLD schema, migrates it, and checks what
 * survived rather than only checking that the constraint changed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import { applyMigrations } from '../../lib/db/open.ts';
import { TASK_STATUSES } from '../../lib/db/types.ts';

/** The tasks table as it existed before the rename, CHECK constraint and all. */
const OLD_SCHEMA = `
CREATE TABLE projects (
    id TEXT PRIMARY KEY, project_number INTEGER UNIQUE, name TEXT NOT NULL,
    type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', gh_repo TEXT,
    gh_sync INTEGER NOT NULL DEFAULT 0, sheets_id TEXT, hourly_rate REAL,
    daily_cost REAL, run_env TEXT NOT NULL DEFAULT 'shell', verify_cmd TEXT,
    test_cmd TEXT, container_image TEXT, repo_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug TEXT NOT NULL, title TEXT NOT NULL, description TEXT, phase TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in-progress','blocked','done','dropped')),
    priority INTEGER NOT NULL DEFAULT 0, duration_days REAL, actual_days REAL,
    estimated_by TEXT NOT NULL DEFAULT 'human',
    early_start REAL, early_finish REAL, late_start REAL, late_finish REAL,
    float_days REAL, is_critical INTEGER NOT NULL DEFAULT 0,
    gh_issue_number INTEGER, worktree_path TEXT, coverage_target REAL, value_score REAL,
    task_type TEXT NOT NULL DEFAULT 'coding', executor TEXT NOT NULL DEFAULT 'auto',
    acceptance_criteria TEXT, files_affected TEXT, files_to_create TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, slug)
);
CREATE TABLE dependencies (
    predecessor_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    successor_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (predecessor_id, successor_id)
);
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT,
    note TEXT, minutes REAL
);
CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, task_id INTEGER,
    event TEXT NOT NULL, detail TEXT, actor TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function oldDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(OLD_SCHEMA);
  const pid = randomUUID();
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(pid, 'p', 'code_repo');

  const add = (slug: string, status: string, extra: Partial<{ value_score: number; float_days: number; acceptance_criteria: string }> = {}) =>
    db.prepare(`
      INSERT INTO tasks (project_id, slug, title, status, priority, duration_days,
                         value_score, float_days, is_critical, acceptance_criteria, task_type, executor)
      VALUES (?, ?, ?, ?, 42, 1.5, ?, ?, 1, ?, 'writing', 'llm')
    `).run(pid, slug, `Title ${slug}`, status,
           extra.value_score ?? 77, extra.float_days ?? 3, extra.acceptance_criteria ?? 'must pass');

  add('a', 'open');
  add('b', 'open');
  add('c', 'in-progress');
  add('d', 'done');
  add('e', 'dropped');
  add('f', 'blocked');

  const idOf = (slug: string) =>
    (db.prepare('SELECT id FROM tasks WHERE slug = ?').get(slug) as { id: number }).id;
  db.prepare('INSERT INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(idOf('a'), idOf('c'));
  db.prepare('INSERT INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(idOf('c'), idOf('d'));

  return { db, pid };
}

const rows = (db: DatabaseSync) =>
  db.prepare('SELECT * FROM tasks ORDER BY slug').all() as unknown as Array<Record<string, unknown>>;

describe("migrating 'open' to 'todo'", () => {
  test('converts open rows and leaves every other status alone', () => {
    const { db } = oldDb();
    const before = rows(db);
    applyMigrations(db);
    const after = rows(db);

    assert.equal(after.length, before.length, 'no row may be lost in the rebuild');
    assert.deepEqual(after.map(r => r.status), ['todo', 'todo', 'in-progress', 'done', 'dropped', 'blocked']);
    db.close();
  });

  test('every column survives with its value intact', () => {
    const { db } = oldDb();
    const before = rows(db).find(r => r.slug === 'a')!;
    applyMigrations(db);
    const after = rows(db).find(r => r.slug === 'a')!;

    for (const [k, v] of Object.entries(before)) {
      if (k === 'status') continue; // the one column this migration exists to change
      assert.deepEqual(after[k], v, `column ${k} changed during the rebuild`);
    }
    db.close();
  });

  test('the new constraint accepts todo and still rejects nonsense', () => {
    const { db } = oldDb();
    applyMigrations(db);

    db.exec("UPDATE tasks SET status = 'todo' WHERE slug = 'd'");
    assert.throws(() => db.exec("UPDATE tasks SET status = 'open' WHERE slug = 'd'"),
      /CHECK|constraint/i, "'open' must no longer be a legal value");
    assert.throws(() => db.exec("UPDATE tasks SET status = 'nonsense' WHERE slug = 'd'"), /CHECK|constraint/i);
    db.close();
  });

  test('dependency edges still resolve after the table is swapped', () => {
    // The rebuild drops and recreates `tasks`, so its foreign keys are the part
    // most likely to be silently broken — and a broken edge means a wrong graph,
    // not an error.
    const { db } = oldDb();
    applyMigrations(db);

    const edges = db.prepare(`
      SELECT p.slug AS pred, s.slug AS succ
      FROM dependencies d
      JOIN tasks p ON p.id = d.predecessor_id
      JOIN tasks s ON s.id = d.successor_id
      ORDER BY pred
    `).all() as unknown as Array<{ pred: string; succ: string }>;

    // node:sqlite hands back null-prototype rows, which deepEqual distinguishes
    // from object literals — copy the fields so the assertion is about the data.
    assert.deepEqual(
      edges.map(e => ({ pred: e.pred, succ: e.succ })),
      [{ pred: 'a', succ: 'c' }, { pred: 'c', succ: 'd' }],
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  });

  test('the indexes the rebuild dropped are put back', () => {
    const { db } = oldDb();
    applyMigrations(db);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'").all() as Array<{ name: string }>)
      .map(r => r.name);
    assert.ok(idx.includes('idx_tasks_project'), 'idx_tasks_project missing after rebuild');
    assert.ok(idx.includes('idx_tasks_status'),  'idx_tasks_status missing after rebuild');
    db.close();
  });

  test('running it twice is a no-op', () => {
    const { db } = oldDb();
    applyMigrations(db);
    const once = rows(db);
    applyMigrations(db);
    assert.deepEqual(rows(db), once);
    db.close();
  });

  test('AUTOINCREMENT ids are preserved, so audit rows still point at their task', () => {
    const { db, pid } = oldDb();
    const idBefore = (db.prepare("SELECT id FROM tasks WHERE slug = 'c'").get() as { id: number }).id;
    db.prepare('INSERT INTO audit (project_id, task_id, event) VALUES (?, ?, ?)').run(pid, idBefore, 'task.start');

    applyMigrations(db);

    const idAfter = (db.prepare("SELECT id FROM tasks WHERE slug = 'c'").get() as { id: number }).id;
    assert.equal(idAfter, idBefore, 'renumbering would orphan every audit row and agent_run');
    db.close();
  });

  test('TASK_STATUSES is the set the migrated constraint enforces', () => {
    const { db } = oldDb();
    applyMigrations(db);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tasks'").get() as { sql: string }).sql;
    for (const s of TASK_STATUSES) assert.ok(sql.includes(`'${s}'`), `${s} missing from the rebuilt CHECK`);
    db.close();
  });
});
