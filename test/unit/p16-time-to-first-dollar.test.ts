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
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
      .run(projectId, 'Test Project', 'startup', 'active');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns null when only non-revenue records exist', () => {
    const db = makeDb();
    const projectId = 'test-project-2';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
      .run(projectId, 'Test Project', 'startup', 'active');

    // Insert non-revenue ROI records
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'cost', 100, '2024-01-01T00:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'investment', 500, '2024-01-02T00:00:00Z');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns null when revenue records have amount <= 0', () => {
    const db = makeDb();
    const projectId = 'test-project-3';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
      .run(projectId, 'Test Project', 'startup', 'active');

    // Insert revenue records with zero or negative amounts
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 0, '2024-01-01T00:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', -100, '2024-01-02T00:00:00Z');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns the earliest revenue date when multiple revenue records exist', () => {
    const db = makeDb();
    const projectId = 'test-project-4';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
      .run(projectId, 'Test Project', 'startup', 'active');

    // Insert revenue records with different dates
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 1000, '2024-03-15T10:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 500, '2024-01-20T08:30:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 2000, '2024-02-10T14:45:00Z');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, '2024-01-20T08:30:00Z');
  });

  test('returns null for non-existent project', () => {
    const db = makeDb();
    const nonExistentId = 'non-existent-project-id';

    const result = firstRevenueAt(db, nonExistentId);
    assert.equal(result, null);
  });

  test('returns correct date when mixed with other ROI types', () => {
    const db = makeDb();
    const projectId = 'test-project-5';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
      .run(projectId, 'Test Project', 'startup', 'active');

    // Insert mixed ROI records
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'cost', 200, '2024-01-05T00:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 1500, '2024-02-14T12:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'investment', 3000, '2024-01-10T00:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 750, '2024-01-25T09:15:00Z');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, '2024-01-25T09:15:00Z');
  });
});
