/**
 * test/unit/server-task-patch.test.ts
 *
 * PATCH /api/task/:projectId/:slug is the first write endpoint that can touch
 * more than one column, which makes two things worth pinning down: that it
 * cannot be used to write columns it has no business writing (the CPM schedule
 * in particular), and that a rejected status transition does not leave half the
 * form saved.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { updateTaskHandler } from '../../lib/server.ts';
import type { Task } from '../../lib/db/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA    = join(__dirname, '../../schema.sql');

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const sql = readFileSync(SCHEMA, 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) db.exec(stmt + ';');
  return db;
}

function seed(db: DatabaseSync) {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, 'test', 'code_repo');
  db.prepare(`
    INSERT INTO tasks (project_id, slug, title, status, priority, duration_days, phase)
    VALUES (?, 'alpha', 'Original title', 'todo', 10, 2, 'Phase 1')
  `).run(id);
  return id;
}

const taskRow = (db: DatabaseSync, projectId: string): Task =>
  db.prepare('SELECT * FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, 'alpha') as unknown as Task;

const auditRows = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM audit WHERE event = 'task.update'").all() as unknown as Array<{ detail: string }>;

describe('updateTaskHandler', () => {
  test('writes only the fields named in the body', () => {
    const db = makeDb();
    const p  = seed(db);

    const res = updateTaskHandler(db, p, 'alpha', { title: 'New title', priority: 55 });
    assert.equal(res.status, 200);

    const row = taskRow(db, p);
    assert.equal(row.title, 'New title');
    assert.equal(row.priority, 55);
    assert.equal(row.phase, 'Phase 1', 'phase was not in the body and must be untouched');
    assert.equal(row.duration_days, 2);
    assert.equal(row.status, 'todo');
    db.close();
  });

  test('unknown task slug returns 404', () => {
    const db = makeDb();
    const p  = seed(db);
    assert.equal(updateTaskHandler(db, p, 'nope', { title: 'x' }).status, 404);
    db.close();
  });

  test('non-editable keys are ignored, not rejected', () => {
    // The panel PATCHes back a row it fetched, so it will include CPM columns.
    // Erroring on them would make the obvious client code fail.
    const db = makeDb();
    const p  = seed(db);
    db.prepare('UPDATE tasks SET float_days = 3, is_critical = 0 WHERE project_id = ?').run(p);

    const res = updateTaskHandler(db, p, 'alpha', {
      title: 'Edited', id: 999, slug: 'renamed', project_id: 'other',
      float_days: 99, is_critical: 1, early_start: 42, created_at: '1999-01-01',
      worktree_path: '/tmp/evil',
    });
    assert.equal(res.status, 200);

    const row = taskRow(db, p);
    assert.equal(row.title, 'Edited');
    assert.equal(row.slug, 'alpha');
    assert.equal(row.project_id, p);
    assert.equal(row.float_days, 3, 'CPM float is computed and must not be settable over HTTP');
    assert.equal(row.is_critical, 0);
    assert.equal(row.early_start, null);
    assert.equal(row.worktree_path, null);
    assert.deepEqual((res.body as { changed: string[] }).changed, ['title']);
    db.close();
  });

  test('rejects each invalid value with a 400 naming the field', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ title: '' },              'title'],
      [{ title: '   ' },           'title'],
      [{ title: 42 },              'title'],
      [{ priority: 101 },          'priority'],
      [{ priority: -1 },           'priority'],
      [{ priority: 1.5 },          'priority'],
      [{ value_score: 101 },       'value_score'],
      [{ duration_days: 0 },       'duration_days'],
      [{ duration_days: -3 },      'duration_days'],
      [{ duration_days: NaN },     'duration_days'],
      [{ task_type: 'sculpting' }, 'task_type'],
      [{ executor: 'nobody' },     'executor'],
      [{ status: 'almost-done' },  'status'],
      [{ description: 7 },         'description'],
    ];

    for (const [body, field] of cases) {
      const db = makeDb();
      const p  = seed(db);
      const res = updateTaskHandler(db, p, 'alpha', body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} should be a 400`);
      assert.equal((res.body as { field: string }).field, field);
      assert.equal(taskRow(db, p).title, 'Original title', 'a rejected patch must write nothing');
      db.close();
    }
  });

  test('a validation failure late in the body blocks the valid fields before it', () => {
    const db = makeDb();
    const p  = seed(db);
    const res = updateTaskHandler(db, p, 'alpha', { title: 'Should not persist', priority: 500 });
    assert.equal(res.status, 400);
    assert.equal(taskRow(db, p).title, 'Original title');
    db.close();
  });

  test('null clears the nullable numeric columns but not priority', () => {
    const db = makeDb();
    const p  = seed(db);
    assert.equal(updateTaskHandler(db, p, 'alpha', { duration_days: null, value_score: null }).status, 200);
    const row = taskRow(db, p);
    assert.equal(row.duration_days, null);
    assert.equal(row.value_score, null);

    const res = updateTaskHandler(db, p, 'alpha', { priority: null });
    assert.equal(res.status, 400, 'priority is NOT NULL in the schema');
    assert.equal((res.body as { field: string }).field, 'priority');
    db.close();
  });

  test('empty string clears a nullable column rather than storing ""', () => {
    const db = makeDb();
    const p  = seed(db);
    updateTaskHandler(db, p, 'alpha', { phase: '' });
    assert.equal(taskRow(db, p).phase, null);
    db.close();
  });

  test('status changes go through the guards and are audited', () => {
    const db = makeDb();
    const p  = seed(db);
    const res = updateTaskHandler(db, p, 'alpha', { status: 'in-progress', title: 'Started' });
    assert.equal(res.status, 200);

    const row = taskRow(db, p);
    assert.equal(row.status, 'in-progress');
    assert.equal(row.title, 'Started');
    assert.deepEqual(auditRows(db).map(r => r.detail), ['status, title']);
    db.close();
  });

  test('a blocked transition returns 409 and writes none of the other fields', () => {
    const db = makeDb();
    const p  = seed(db);
    // enforce turns the predecessor guard from a warning into a refusal
    db.prepare("INSERT INTO global_config (key, value) VALUES ('guard_policy', 'enforce')").run();
    db.prepare(`
      INSERT INTO tasks (project_id, slug, title, status, duration_days)
      VALUES (?, 'blocker', 'Blocker', 'todo', 1)
    `).run(p);
    const pred = db.prepare("SELECT id FROM tasks WHERE slug = 'blocker'").get() as { id: number };
    const succ = db.prepare("SELECT id FROM tasks WHERE slug = 'alpha'").get() as { id: number };
    db.prepare('INSERT INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(pred.id, succ.id);

    const res = updateTaskHandler(db, p, 'alpha', { status: 'done', title: 'Snuck through' });
    assert.equal(res.status, 409);

    const row = taskRow(db, p);
    assert.equal(row.status, 'todo');
    assert.equal(row.title, 'Original title', 'the whole PATCH is rejected as one unit');
    assert.equal(auditRows(db).length, 0);
    db.close();
  });

  test('guard warnings ride along with a 200 under the default warn policy', () => {
    const db = makeDb();
    const p  = seed(db);
    db.prepare(`
      INSERT INTO tasks (project_id, slug, title, status, duration_days)
      VALUES (?, 'blocker', 'Blocker', 'todo', 1)
    `).run(p);
    const pred = db.prepare("SELECT id FROM tasks WHERE slug = 'blocker'").get() as { id: number };
    const succ = db.prepare("SELECT id FROM tasks WHERE slug = 'alpha'").get() as { id: number };
    db.prepare('INSERT INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(pred.id, succ.id);

    const res = updateTaskHandler(db, p, 'alpha', { status: 'in-progress' });
    assert.equal(res.status, 200);
    const warnings = (res.body as { guard_warnings?: Array<{ reason: string }> }).guard_warnings;
    assert.ok(warnings && warnings.length > 0, 'the incomplete predecessor should still be reported');
    assert.equal(taskRow(db, p).status, 'in-progress');
    db.close();
  });

  test('a no-op patch writes no audit row', () => {
    const db = makeDb();
    const p  = seed(db);
    const res = updateTaskHandler(db, p, 'alpha', { title: 'Original title', status: 'todo', priority: 10 });
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as { changed: string[] }).changed, []);
    assert.equal(auditRows(db).length, 0);
    db.close();
  });

  test('the response carries the updated row so the client re-renders from server truth', () => {
    const db = makeDb();
    const p  = seed(db);
    const res = updateTaskHandler(db, p, 'alpha', { title: 'Fresh' });
    const returned = (res.body as { task: Task }).task;
    assert.equal(returned.title, 'Fresh');
    assert.equal(returned.slug, 'alpha');
    db.close();
  });

  test('a non-object body is rejected', () => {
    const db = makeDb();
    const p  = seed(db);
    for (const body of [undefined, null, 'string', 42]) {
      assert.equal(updateTaskHandler(db, p, 'alpha', body).status, 400);
    }
    db.close();
  });
});
