/**
 * test/unit/status.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { projectStatus } from '../../lib/db/status.ts';
import { updateTaskPriority } from '../../lib/db/tasks.ts';

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

function seedTask(db: DatabaseSync, projectId: string, slug: string): number {
  db.prepare('INSERT INTO tasks (project_id, slug, title) VALUES (?, ?, ?)').run(projectId, slug, slug);
  const row = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, slug) as { id: number };
  return row.id;
}

describe('projectStatus next_unblocked', () => {
  test('includes priority field', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const tid = seedTask(db, pid, 't1');
    updateTaskPriority(db, tid, 42);
    const status = projectStatus(db, pid);
    assert.equal(status.next_unblocked[0].priority, 42);
  });

  test('sorted by priority descending', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const low  = seedTask(db, pid, 'low');
    const high = seedTask(db, pid, 'high');
    const mid  = seedTask(db, pid, 'mid');
    updateTaskPriority(db, low, 10);
    updateTaskPriority(db, high, 90);
    updateTaskPriority(db, mid, 50);
    const status = projectStatus(db, pid);
    assert.deepEqual(status.next_unblocked.map(t => t.slug), ['high', 'mid', 'low']);
  });
});
