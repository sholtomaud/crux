/**
 * test/integration/coverage.test.ts
 * Tests auto-close of tasks when coverage target is met via crux test-run.
 * All created GH resources labelled `pm-test` for teardown.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureLabel, teardownTestIssues } from '../../lib/gh.ts';
import { insertTestRun } from '../../lib/db.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SCHEMA     = join(__dirname, '../../schema.sql');
const REPO       = 'sholtomaud/crux-test';

// ── DB helpers ────────────────────────────────────────────────────────────────

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const sql = readFileSync(SCHEMA, 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    db.exec(stmt + ';');
  }
  return db;
}

function seedProject(db: DatabaseSync): string {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, 'test-proj', 'code_repo');
  return id;
}

function seedTask(db: DatabaseSync, projectId: string, slug: string, coverageTarget: number | null = null): void {
  db.prepare(
    'INSERT INTO tasks (project_id, slug, title, coverage_target) VALUES (?, ?, ?, ?)'
  ).run(projectId, slug, `Task ${slug}`, coverageTarget);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(() => {
  ensureLabel(REPO, 'pm-test', 'e4e669', 'Created by crux integration tests');
});

after(() => {
  teardownTestIssues(REPO);
});

// ── test_runs table ───────────────────────────────────────────────────────────

describe('test_runs', () => {
  test('records a passing test run with coverage', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'p1-db-test', 80);

    insertTestRun(db, { project_id: pid, phase: 'test', status: 'pass', task_slug: 'p1-db-test', coverage: 85.5 });

    const row = db.prepare(
      'SELECT * FROM test_runs WHERE project_id = ? AND task_slug = ?'
    ).get(pid, 'p1-db-test') as { status: string; coverage: number; phase: string };

    assert.equal(row.status, 'pass');
    assert.ok(row.coverage >= 85, 'coverage should be recorded');
    db.close();
  });

  test('records a failing test run without coverage', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'p2-cpm-test');

    insertTestRun(db, { project_id: pid, phase: 'test', status: 'fail', task_slug: 'p2-cpm-test' });

    const row = db.prepare(
      'SELECT * FROM test_runs WHERE project_id = ? AND task_slug = ?'
    ).get(pid, 'p2-cpm-test') as { status: string; coverage: number | null };

    assert.equal(row.status, 'fail');
    assert.equal(row.coverage, null);
    db.close();
  });
});

// ── Coverage target auto-close logic ─────────────────────────────────────────

describe('coverage target', () => {
  test('task should auto-close when coverage meets target', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'needs-coverage', 75);

    insertTestRun(db, { project_id: pid, phase: 'test', status: 'pass', task_slug: 'needs-coverage', coverage: 80 });

    // Check if coverage target met
    const task = db.prepare(
      'SELECT coverage_target FROM tasks WHERE project_id = ? AND slug = ?'
    ).get(pid, 'needs-coverage') as { coverage_target: number };

    const run = db.prepare(
      'SELECT MAX(coverage) as best FROM test_runs WHERE project_id = ? AND task_slug = ? AND status = ?'
    ).get(pid, 'needs-coverage', 'pass') as { best: number };

    assert.ok(run.best >= task.coverage_target, 'coverage should meet or exceed target');
    db.close();
  });

  test('task should not auto-close when coverage is below target', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'low-coverage', 90);

    insertTestRun(db, { project_id: pid, phase: 'test', status: 'pass', task_slug: 'low-coverage', coverage: 70 });

    const task = db.prepare(
      'SELECT coverage_target FROM tasks WHERE project_id = ? AND slug = ?'
    ).get(pid, 'low-coverage') as { coverage_target: number };

    const run = db.prepare(
      'SELECT MAX(coverage) as best FROM test_runs WHERE project_id = ? AND task_slug = ? AND status = ?'
    ).get(pid, 'low-coverage', 'pass') as { best: number };

    assert.ok(run.best < task.coverage_target, 'coverage should be below target — task should stay open');
    db.close();
  });

  test('task with no coverage target is not gated', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'no-target', null);  // no coverage_target

    insertTestRun(db, { project_id: pid, phase: 'test', status: 'pass', task_slug: 'no-target' });

    const task = db.prepare(
      'SELECT coverage_target FROM tasks WHERE project_id = ? AND slug = ?'
    ).get(pid, 'no-target') as { coverage_target: number | null };

    assert.equal(task.coverage_target, null, 'task has no coverage gate — can be closed freely');
    db.close();
  });
});

// ── Multiple test runs ────────────────────────────────────────────────────────

describe('multiple test runs', () => {
  test('tracks history of pass/fail runs', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'flaky-test');

    insertTestRun(db, { project_id: pid, phase: 'test', status: 'fail', task_slug: 'flaky-test' });
    insertTestRun(db, { project_id: pid, phase: 'test', status: 'fail', task_slug: 'flaky-test' });
    insertTestRun(db, { project_id: pid, phase: 'test', status: 'pass', task_slug: 'flaky-test', coverage: 82 });

    const runs = db.prepare(
      'SELECT status FROM test_runs WHERE project_id = ? AND task_slug = ? ORDER BY run_at'
    ).all(pid, 'flaky-test') as Array<{ status: string }>;

    assert.equal(runs.length, 3);
    assert.equal(runs[0].status, 'fail');
    assert.equal(runs[2].status, 'pass');
    db.close();
  });
});
