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
    
    // Insert a project
    db.prepare('INSERT INTO projects (id, name, type, status, gh_repo, gh_sync, sheets_id, hourly_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('proj-1', 'Test Project', 'code_repo', 'active', null, 0, null, null, new Date().toISOString());
    
    const result = firstRevenueAt(db, 'proj-1');
    assert.equal(result, null);
  });

  test('returns null when only non-revenue records exist', () => {
    const db = makeDb();
    
    // Insert a project
    db.prepare('INSERT INTO projects (id, name, type, status, gh_repo, gh_sync, sheets_id, hourly_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('proj-1', 'Test Project', 'code_repo', 'active', null, 0, null, null, new Date().toISOString());
    
    // Insert cost records (not revenue)
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-01-01T10:00:00Z', -100, 'cost');
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-01-02T10:00:00Z', -50, 'cost');
    
    const result = firstRevenueAt(db, 'proj-1');
    assert.equal(result, null);
  });

  test('returns null when only zero-amount revenue records exist', () => {
    const db = makeDb();
    
    // Insert a project
    db.prepare('INSERT INTO projects (id, name, type, status, gh_repo, gh_sync, sheets_id, hourly_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('proj-1', 'Test Project', 'code_repo', 'active', null, 0, null, null, new Date().toISOString());
    
    // Insert zero-amount revenue records
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-01-01T10:00:00Z', 0, 'revenue');
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-01-02T10:00:00Z', 0, 'revenue');
    
    const result = firstRevenueAt(db, 'proj-1');
    assert.equal(result, null);
  });

  test('returns the earliest revenue date when positive revenue exists', () => {
    const db = makeDb();
    
    // Insert a project
    db.prepare('INSERT INTO projects (id, name, type, status, gh_repo, gh_sync, sheets_id, hourly_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('proj-1', 'Test Project', 'code_repo', 'active', null, 0, null, null, new Date().toISOString());
    
    // Insert revenue records with different dates
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-03-15T14:30:00Z', 500, 'revenue');
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-01-10T09:00:00Z', 100, 'revenue');
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-02-20T16:45:00Z', 250, 'revenue');
    
    const result = firstRevenueAt(db, 'proj-1');
    assert.equal(result, '2024-01-10T09:00:00Z');
  });

  test('returns null for non-existent project', () => {
    const db = makeDb();
    
    // Insert a revenue record for a project that doesn't exist
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('non-existent-proj', '2024-01-10T09:00:00Z', 100, 'revenue');
    
    const result = firstRevenueAt(db, 'non-existent-proj');
    assert.equal(result, null);
  });

  test('returns null when project has mixed revenue and non-revenue records', () => {
    const db = makeDb();
    
    // Insert a project
    db.prepare('INSERT INTO projects (id, name, type, status, gh_repo, gh_sync, sheets_id, hourly_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('proj-1', 'Test Project', 'code_repo', 'active', null, 0, null, null, new Date().toISOString());
    
    // Insert mixed records: cost, expected, and revenue
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-01-05T08:00:00Z', -200, 'cost');
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-01-08T12:00:00Z', 300, 'expected');
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-01-15T10:00:00Z', 150, 'revenue');
    
    const result = firstRevenueAt(db, 'proj-1');
    assert.equal(result, '2024-01-15T10:00:00Z');
  });

  test('handles multiple projects correctly', () => {
    const db = makeDb();
    
    // Insert two projects
    db.prepare('INSERT INTO projects (id, name, type, status, gh_repo, gh_sync, sheets_id, hourly_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('proj-1', 'Project 1', 'code_repo', 'active', null, 0, null, null, new Date().toISOString());
    db.prepare('INSERT INTO projects (id, name, type, status, gh_repo, gh_sync, sheets_id, hourly_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('proj-2', 'Project 2', 'article', 'active', null, 0, null, null, new Date().toISOString());
    
    // Insert revenue for proj-1
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind) VALUES (?, ?, ?, ?)')
      .run('proj-1', '2024-06-01T00:00:00Z', 1000, 'revenue');
    
    // Insert revenue for proj-2
    db.prepare('INSERT INTO roi_records (project_id, recorded_at, amount, kind)
