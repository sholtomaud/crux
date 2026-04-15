import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { firstRevenueAt } from '../../lib/db.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, '../schema.sql'), 'utf-8');

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

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
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'cost', 100, '2024-01-01T00:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'investment', 500, '2024-01-02T00:00:00Z');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns null when revenue records have amount <= 0', () => {
    const db = makeDb();
    const projectId = 'test-project-3';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(projectId, 'Test Project', 'startup', 'active');
    
    // Insert revenue records with amount <= 0
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 0, '2024-01-01T00:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', -100, '2024-01-02T00:00:00Z');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, null);
  });

  test('returns the earliest revenue date when revenue records exist', () => {
    const db = makeDb();
    const projectId = 'test-project-4';
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(projectId, 'Test Project', 'startup', 'active');
    
    // Insert revenue records with different dates
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 1000, '2024-03-15T10:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 500, '2024-01-20T08:30:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId, 'revenue', 2000, '2024-02-10T14:45:00Z');

    const result = firstRevenueAt(db, projectId);
    assert.equal(result, '2024-01-20T08:30:00Z');
  });

  test('returns null for non-existent project', () => {
    const db = makeDb();
    const nonExistentId = 'non-existent-project-id';

    const result = firstRevenueAt(db, nonExistentId);
    assert.equal(result, null);
  });

  test('handles multiple projects correctly', () => {
    const db = makeDb();
    
    const projectId1 = 'project-1';
    const projectId2 = 'project-2';
    
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(projectId1, 'Project 1', 'startup', 'active');
    db.prepare('INSERT INTO projects (id, name, type, status, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(projectId2, 'Project 2', 'startup', 'active');
    
    // Project 1 has revenue
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId1, 'revenue', 100, '2024-05-01T00:00:00Z');
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId1, 'revenue', 200, '2024-04-15T00:00:00Z');
    
    // Project 2 has no revenue
    db.prepare('INSERT INTO roi_records (project_id, kind, amount, recorded_at) VALUES (?, ?, ?, ?)').run(projectId2, 'cost', 50, '2024-04-01T00:00:00Z');

    const result1 = firstRevenueAt(db, projectId1);
    assert.equal(result1, '2024-04-15T00:00:00Z');

    const result2 = firstRevenueAt(db, projectId2);
    assert.equal(result2, null);
  });
});
