/**
 * test/unit/tasks.test.ts — task field updates (phase / description / duration_days)
 * and the before→after audit trail they write.
 * Uses an in-memory DB to avoid touching ~/.crux/crux.db
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { insertTask, taskBySlug, updateTaskFields } from '../../lib/db/tasks.ts';
import { logFieldChange, auditByTask } from '../../lib/db/audit.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA    = join(__dirname, '../../schema.sql');

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const sql = readFileSync(SCHEMA, 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) db.exec(stmt + ';');
  return db;
}

function seedProject(db: DatabaseSync): string {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, 'test-proj', 'code_repo');
  return id;
}

function seedTask(db: DatabaseSync, projectId: string) {
  return insertTask(db, {
    project_id: projectId,
    slug: 'p1-thing',
    title: 'Do the thing',
    description: 'original description',
    phase: 'original phase',
    duration_days: 2,
  });
}

describe('updateTaskFields', () => {
  test('updates phase only, leaving description and duration_days untouched', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const task = seedTask(db, pid);

    updateTaskFields(db, task.id, { phase: 'MCP correctness' });

    const row = taskBySlug(db, pid, 'p1-thing')!;
    assert.equal(row.phase, 'MCP correctness');
    assert.equal(row.description, 'original description');
    assert.equal(row.duration_days, 2);
    db.close();
  });

  test('updates description only, leaving phase and duration_days untouched', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const task = seedTask(db, pid);

    updateTaskFields(db, task.id, { description: 'rewritten description' });

    const row = taskBySlug(db, pid, 'p1-thing')!;
    assert.equal(row.description, 'rewritten description');
    assert.equal(row.phase, 'original phase');
    assert.equal(row.duration_days, 2);
    db.close();
  });

  test('updates duration_days only, leaving phase and description untouched', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const task = seedTask(db, pid);

    updateTaskFields(db, task.id, { duration_days: 0.5 });

    const row = taskBySlug(db, pid, 'p1-thing')!;
    assert.equal(row.duration_days, 0.5);
    assert.equal(row.phase, 'original phase');
    assert.equal(row.description, 'original description');
    db.close();
  });

  test('updates all three fields in one call', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const task = seedTask(db, pid);

    updateTaskFields(db, task.id, {
      phase: 'MCP correctness',
      description: 'rewritten description',
      duration_days: 1.5,
    });

    const row = taskBySlug(db, pid, 'p1-thing')!;
    assert.equal(row.phase, 'MCP correctness');
    assert.equal(row.description, 'rewritten description');
    assert.equal(row.duration_days, 1.5);
    db.close();
  });

  test('an empty patch touches nothing', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const task = seedTask(db, pid);

    updateTaskFields(db, task.id, {});

    const row = taskBySlug(db, pid, 'p1-thing')!;
    assert.equal(row.phase, 'original phase');
    assert.equal(row.description, 'original description');
    assert.equal(row.duration_days, 2);
    db.close();
  });

  test('clears a field when passed an empty string', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const task = seedTask(db, pid);

    updateTaskFields(db, task.id, { phase: '' });

    assert.equal(taskBySlug(db, pid, 'p1-thing')!.phase, '');
    db.close();
  });
});

describe('logFieldChange', () => {
  test('records the field name with its before → after values', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const task = seedTask(db, pid);

    logFieldChange(db, {
      project_id: pid, task_id: task.id,
      field: 'phase', before: task.phase, after: 'MCP correctness', actor: 'claude',
    });

    const [entry] = auditByTask(db, task.id);
    assert.equal(entry!.event, 'task.update');
    assert.equal(entry!.detail, 'phase: original phase → MCP correctness');
    assert.equal(entry!.actor, 'claude');
    db.close();
  });

  test('renders an unset before value rather than "null"', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const task = seedTask(db, pid);

    logFieldChange(db, { project_id: pid, task_id: task.id, field: 'duration_days', before: null, after: 0.5 });

    assert.equal(auditByTask(db, task.id)[0]!.detail, 'duration_days: ∅ → 0.5');
    db.close();
  });

  test('truncates long values so a description rewrite does not bloat the audit log', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const task = seedTask(db, pid);
    const long = 'x'.repeat(500);

    logFieldChange(db, { project_id: pid, task_id: task.id, field: 'description', before: long, after: long });

    const detail = auditByTask(db, task.id)[0]!.detail!;
    assert.ok(detail.length < 200, `audit detail should stay short, got ${detail.length} chars`);
    assert.ok(detail.includes('…'), 'truncated values should be elided');
    db.close();
  });
});
