/**
 * test/unit/guards.test.ts — transition guards (ADR-011)
 *
 * The governing property: turning guards on must not change what crux *does*.
 * Default policy is 'warn', so every transition that succeeded before still
 * succeeds — it just now says why it looked wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { evaluateTransition, guardPolicy, GUARD_POLICY_KEY } from '../../lib/guards.ts';
import { applyTaskStatus } from '../../lib/task-transition.ts';
import { taskBySlug, addDependency, insertTestRun, setConfig, recentAudit } from '../../lib/db.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA    = join(__dirname, '../../schema.sql');

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const sql = readFileSync(SCHEMA, 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) db.exec(stmt + ';');
  return db;
}

function seedProject(db: DatabaseSync, opts: { test_cmd?: string } = {}): string {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, type, test_cmd) VALUES (?, ?, ?, ?)')
    .run(id, 'p', 'code_repo', opts.test_cmd ?? null);
  return id;
}

function seedTask(
  db: DatabaseSync, pid: string, slug: string,
  opts: { status?: string; duration_days?: number | null; actual_days?: number | null } = {},
): number {
  db.prepare('INSERT INTO tasks (project_id, slug, title, status, duration_days, actual_days) VALUES (?, ?, ?, ?, ?, ?)')
    .run(pid, slug, slug, opts.status ?? 'todo', opts.duration_days ?? null, opts.actual_days ?? null);
  return taskBySlug(db, pid, slug)!.id;
}

const codes = (db: DatabaseSync, pid: string, slug: string, to: string) =>
  evaluateTransition(db, taskBySlug(db, pid, slug)!, to as never).map(f => f.code);

// ── Individual guards ─────────────────────────────────────────────────────────

describe('predecessor guard', () => {
  test('objects when a predecessor is still open', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const a = seedTask(db, pid, 'a');
    const b = seedTask(db, pid, 'b');
    addDependency(db, a, b);
    assert.deepEqual(codes(db, pid, 'b', 'in-progress'), ['predecessors-incomplete']);
  });

  test('is satisfied by a done predecessor', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const a = seedTask(db, pid, 'a', { status: 'done' });
    const b = seedTask(db, pid, 'b');
    addDependency(db, a, b);
    assert.deepEqual(codes(db, pid, 'b', 'in-progress'), []);
  });

  test('a dropped predecessor is not a blocker — the work is off the table', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const a = seedTask(db, pid, 'a', { status: 'dropped' });
    const b = seedTask(db, pid, 'b');
    addDependency(db, a, b);
    assert.deepEqual(codes(db, pid, 'b', 'in-progress'), []);
  });

  test('does not fire on transitions that are not starting or finishing work', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const a = seedTask(db, pid, 'a');
    const b = seedTask(db, pid, 'b');
    addDependency(db, a, b);
    assert.deepEqual(codes(db, pid, 'b', 'blocked'), []);
    assert.deepEqual(codes(db, pid, 'b', 'dropped'), []);
  });
});

describe('tests guard', () => {
  test('stays quiet for a project with no test_cmd — there is no CI to be green', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a');
    assert.deepEqual(codes(db, pid, 'a', 'done'), []);
  });

  test('never objects to a missing run — absence measures bookkeeping, not code health', () => {
    const db = makeDb();
    const pid = seedProject(db, { test_cmd: 'npm test' });
    seedTask(db, pid, 'a');
    assert.deepEqual(codes(db, pid, 'a', 'done'), []);

    // Even where the project does record runs for other tasks.
    insertTestRun(db, { project_id: pid, task_slug: 'other', phase: 'test-c', status: 'pass' });
    assert.deepEqual(codes(db, pid, 'a', 'done'), []);
  });

  test('objects when the latest run failed', () => {
    const db = makeDb();
    const pid = seedProject(db, { test_cmd: 'npm test' });
    seedTask(db, pid, 'a');
    insertTestRun(db, { project_id: pid, task_slug: 'a', phase: 'test-c', status: 'fail' });
    assert.deepEqual(codes(db, pid, 'a', 'done'), ['tests-not-green']);
  });

  test('a passing run clears it', () => {
    const db = makeDb();
    const pid = seedProject(db, { test_cmd: 'npm test' });
    seedTask(db, pid, 'a');
    insertTestRun(db, { project_id: pid, task_slug: 'a', phase: 'test-c', status: 'pass' });
    assert.deepEqual(codes(db, pid, 'a', 'done'), []);
  });

});

describe('actuals guard', () => {
  test('objects when closing an estimated task with no actual', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a', { duration_days: 3 });
    assert.deepEqual(codes(db, pid, 'a', 'done'), ['actuals-missing']);
  });

  test('is satisfied once actual_days is recorded', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a', { duration_days: 3, actual_days: 4 });
    assert.deepEqual(codes(db, pid, 'a', 'done'), []);
  });

  test('stays quiet on an unestimated task — there is nothing to calibrate', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a');
    assert.deepEqual(codes(db, pid, 'a', 'done'), []);
  });
});

test('a no-op transition is never guarded', () => {
  const db = makeDb();
  const pid = seedProject(db, { test_cmd: 'npm test' });
  seedTask(db, pid, 'a', { status: 'done', duration_days: 2 });
  assert.deepEqual(codes(db, pid, 'a', 'done'), []);
});

test('guards compose — several can object at once', () => {
  const db = makeDb();
  const pid = seedProject(db, { test_cmd: 'npm test' });
  const a = seedTask(db, pid, 'a');
  const b = seedTask(db, pid, 'b', { duration_days: 2 });
  addDependency(db, a, b);
  insertTestRun(db, { project_id: pid, task_slug: 'b', phase: 'test-c', status: 'fail' });
  assert.deepEqual(
    codes(db, pid, 'b', 'done').sort(),
    ['actuals-missing', 'predecessors-incomplete', 'tests-not-green'],
  );
});

// ── Policy ────────────────────────────────────────────────────────────────────

describe('guard policy', () => {
  test('defaults to warn when unset or garbage', () => {
    const db = makeDb();
    assert.equal(guardPolicy(db), 'warn');
    setConfig(db, GUARD_POLICY_KEY, 'nonsense');
    assert.equal(guardPolicy(db), 'warn');
  });

  test('warn applies the transition anyway and reports why', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a', { duration_days: 3 });

    const res = applyTaskStatus(db, pid, 'a', 'done');
    assert.equal(res.applied, true);
    assert.deepEqual(res.warnings.map(w => w.code), ['actuals-missing']);
    assert.equal(taskBySlug(db, pid, 'a')!.status, 'done');
  });

  test('warned-through transitions leave an audit trail', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a', { duration_days: 3 });
    applyTaskStatus(db, pid, 'a', 'done');

    const entry = recentAudit(db, pid, 10).find(e => e.event === 'task.guard-warning');
    assert.ok(entry, 'expected a task.guard-warning audit row');
    assert.match(entry!.detail!, /todo → done: actuals-missing/);
  });

  test('a clean transition writes no warning row', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a', { duration_days: 3, actual_days: 3 });
    applyTaskStatus(db, pid, 'a', 'done');
    assert.equal(recentAudit(db, pid, 10).filter(e => e.event === 'task.guard-warning').length, 0);
  });

  test('enforce refuses and leaves the status untouched', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a', { duration_days: 3 });
    setConfig(db, GUARD_POLICY_KEY, 'enforce');

    const res = applyTaskStatus(db, pid, 'a', 'done');
    assert.equal(res.applied, false);
    assert.match(res.blocked!, /actuals-missing/);
    assert.equal(taskBySlug(db, pid, 'a')!.status, 'todo');
  });

  test('enforce still allows a clean transition', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a', { duration_days: 3, actual_days: 3 });
    setConfig(db, GUARD_POLICY_KEY, 'enforce');
    assert.equal(applyTaskStatus(db, pid, 'a', 'done').applied, true);
  });

  test('off skips the checks entirely', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'a', { duration_days: 3 });
    setConfig(db, GUARD_POLICY_KEY, 'off');

    const res = applyTaskStatus(db, pid, 'a', 'done');
    assert.equal(res.applied, true);
    assert.deepEqual(res.warnings, []);
    assert.equal(taskBySlug(db, pid, 'a')!.status, 'done');
  });

  test('a missing task is reported, not thrown, and rolls back cleanly', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const res = applyTaskStatus(db, pid, 'ghost', 'done');
    assert.equal(res.applied, false);
    assert.match(res.blocked!, /task not found/);
    // The transaction must be closed, or every later write fails.
    seedTask(db, pid, 'real');
    assert.equal(applyTaskStatus(db, pid, 'real', 'in-progress').applied, true);
  });
});
