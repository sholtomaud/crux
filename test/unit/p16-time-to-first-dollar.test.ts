import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstRevenueAt } from '../../lib/db.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const schemaPath = join(process.cwd(), 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  return db;
}

// ── firstRevenueAt ─────────────────────────────────────────────────────────────

describe('firstRevenueAt', () => {
  test('returns null when no revenue records exist', () => {
    const db = makeDb();
    const projectId = 'test-project-1';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(projectId, 'Test Project', 'startup', 'active');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns null when only non-revenue records exist', () => {
    const db = makeDb();
    const projectId = 'test-project-2';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(projectId, 'Test Project', 'startup', 'active');

    // Insert non-revenue ROI records
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'cost', 100, '2024-01-01');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'investment', 500, '2024-01-02');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns null when revenue records have amount <= 0', () => {
    const db = makeDb();
    const projectId = 'test-project-3';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(projectId, 'Test Project', 'startup', 'active');

    // Insert revenue records with non-positive amounts
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 0, '2024-01-01');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', -50, '2024-01-02');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns the earliest revenue date when positive revenue exists', () => {
    const db = makeDb();
    const projectId = 'test-project-4';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(projectId, 'Test Project', 'startup', 'active');

    // Insert revenue records with positive amounts
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 100, '2024-03-15');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 200, '2024-01-10');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 150, '2024-02-20');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, '2024-01-10');
  });

  test('returns null for non-existent project', () => {
    const db = makeDb();
    const nonExistentId = 'non-existent-project-id';

    const result = firstRevenueAt(db, nonExistentId);
    assert.equal(result, null);
  });

  test('handles mixed kinds with revenue being the earliest positive', () => {
    const db = makeDb();
    const projectId = 'test-project-5';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(projectId, 'Test Project', 'startup', 'active');

    // Insert mixed records
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'cost', 50, '2024-01-05');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 300, '2024-01-01');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'investment', 1000, '2024-01-03');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 250, '2024-01-10');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, '2024-01-01');
  });
});
