import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { firstRevenueAt } from '../../lib/db.ts';
import { SCHEMA_SQL } from '../../lib/schema-sql.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

// ── firstRevenueAt ──────────────────────────────────────────────────────────────

describe('firstRevenueAt', () => {
  test('returns null when no revenue records exist', () => {
    const db = makeDb();
    const projectId = 'test-project-1';
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)')
      .run(projectId, 'Test Project', 'active');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns null when only non-positive revenue records exist', () => {
    const db = makeDb();
    const projectId = 'test-project-2';
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)')
      .run(projectId, 'Test Project 2', 'active');

    // Insert revenue records with amount <= 0
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 0, '2024-01-01T10:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', -100, '2024-01-02T10:00:00Z');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns the earliest recorded_at when revenue records with amount > 0 exist', () => {
    const db = makeDb();
    const projectId = 'test-project-3';
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)')
      .run(projectId, 'Test Project 3', 'active');

    // Insert revenue records with amount > 0 at different times
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 500, '2024-03-15T14:30:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 1000, '2024-01-10T09:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'revenue', 250, '2024-02-20T16:45:00Z');

    const result = firstRevenueAt(db, projectId);
    // Should return the earliest date: 2024-01-10T09:00:00Z
    assert.equal(result, '2024-01-10T09:00:00Z');
  });

  test('returns null when project has no roi_records at all', () => {
    const db = makeDb();
    const projectId = 'test-project-4';
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)')
      .run(projectId, 'Test Project 4', 'active');

    // Insert non-revenue records
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId, 'cost', 200, '2024-01-05T12:00:00Z');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns null for non-existent project', () => {
    const db = makeDb();
    const nonExistentId = 'non-existent-project';

    const result = firstRevenueAt(db, nonExistentId);
    assert.equal(result, null);
  });

  test('handles multiple projects correctly', () => {
    const db = makeDb();
    
    const projectId1 = 'project-a';
    const projectId2 = 'project-b';
    
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)')
      .run(projectId1, 'Project A', 'active');
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)')
      .run(projectId2, 'Project B', 'active');

    // Project A has revenue
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId1, 'revenue', 100, '2024-05-01T08:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId1, 'revenue', 200, '2024-04-15T10:00:00Z');

    // Project B has no revenue
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)')
      .run(projectId2, 'cost', 50, '2024-06-01T12:00:00Z');

    const resultA = firstRevenueAt(db, projectId1);
    assert.equal(resultA, '2024-04-15T10:00:00Z');

    const resultB = firstRevenueAt(db, projectId2);
    assert.equal(resultB, null);
  });
});
