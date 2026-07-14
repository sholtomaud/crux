/**
 * test/unit/calibration.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { taskEstimateRatio, calibrationByEstimator } from '../../lib/db/calibration.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SCHEMA     = join(__dirname, '../../schema.sql');

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
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, 'test', 'code_repo');
  return id;
}

function seedTask(
  db: DatabaseSync,
  projectId: string,
  slug: string,
  opts: { duration_days?: number; actual_days?: number; estimated_by?: string } = {}
): void {
  db.prepare(`
    INSERT INTO tasks (project_id, slug, title, duration_days, actual_days, estimated_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    projectId, slug, slug,
    opts.duration_days ?? null,
    opts.actual_days ?? null,
    opts.estimated_by ?? 'human',
  );
}

describe('taskEstimateRatio', () => {
  test('actual_days / duration_days', () => {
    assert.equal(taskEstimateRatio({ actual_days: 2, duration_days: 1 }), 2);
    assert.equal(taskEstimateRatio({ actual_days: 0.5, duration_days: 1 }), 0.5);
  });

  test('null when actual_days is unset', () => {
    assert.equal(taskEstimateRatio({ actual_days: null, duration_days: 1 }), null);
  });

  test('null when duration_days is unset or zero', () => {
    assert.equal(taskEstimateRatio({ actual_days: 1, duration_days: null }), null);
    assert.equal(taskEstimateRatio({ actual_days: 1, duration_days: 0 }), null);
  });
});

describe('calibrationByEstimator', () => {
  test('overall is null when no task has both fields set', () => {
    const db  = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'no-actuals', { duration_days: 1 });
    const cal = calibrationByEstimator(db, pid);
    assert.equal(cal.overall, null);
    assert.deepEqual(cal.by_estimator, []);
  });

  test('groups by estimated_by and averages ratios', () => {
    const db  = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'c1', { duration_days: 1, actual_days: 2,   estimated_by: 'claude' });
    seedTask(db, pid, 'c2', { duration_days: 2, actual_days: 3,   estimated_by: 'claude' });
    seedTask(db, pid, 'h1', { duration_days: 1, actual_days: 0.5, estimated_by: 'human' });

    const cal = calibrationByEstimator(db, pid);

    const claude = cal.by_estimator.find(b => b.estimated_by === 'claude')!;
    assert.equal(claude.count, 2);
    assert.equal(claude.avg_ratio, 1.75); // (2/1 + 3/2) / 2 = (2 + 1.5) / 2
    assert.equal(claude.min_ratio, 1.5);
    assert.equal(claude.max_ratio, 2);

    const human = cal.by_estimator.find(b => b.estimated_by === 'human')!;
    assert.equal(human.count, 1);
    assert.equal(human.avg_ratio, 0.5);

    assert.equal(cal.overall!.count, 3);
  });

  test('excludes tasks missing actual_days or duration_days from their estimator bucket', () => {
    const db  = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'incomplete', { duration_days: 1, estimated_by: 'claude' }); // no actual_days yet
    seedTask(db, pid, 'complete',   { duration_days: 1, actual_days: 1, estimated_by: 'claude' });

    const cal = calibrationByEstimator(db, pid);
    const claude = cal.by_estimator.find(b => b.estimated_by === 'claude')!;
    assert.equal(claude.count, 1);
  });
});
