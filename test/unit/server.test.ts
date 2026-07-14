/**
 * test/unit/server.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { updateTaskStatusHandler, updateProjectStatusHandler, sessionStartHandler, sessionEndHandler } from '../../lib/server.ts';

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

function seedProject(db: DatabaseSync, name = 'test', type = 'code_repo') {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, name, type);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as { id: string; status: string };
}

function seedTask(db: DatabaseSync, projectId: string, slug: string) {
  db.prepare(`
    INSERT INTO tasks (project_id, slug, title, status)
    VALUES (?, ?, ?, 'open')
  `).run(projectId, slug, slug);
  return db.prepare('SELECT * FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, slug) as { id: number; status: string };
}

describe('updateTaskStatusHandler', () => {
  test('valid status transition returns 200 and persists', () => {
    const db = makeDb();
    const p  = seedProject(db);
    seedTask(db, p.id, 'alpha');
    const result = updateTaskStatusHandler(db, p.id, 'alpha', 'done');
    assert.equal(result.status, 200);
    const row = db.prepare('SELECT status FROM tasks WHERE project_id = ? AND slug = ?').get(p.id, 'alpha') as { status: string };
    assert.equal(row.status, 'done');
    db.close();
  });

  test('invalid status string returns 400, row unchanged', () => {
    const db = makeDb();
    const p  = seedProject(db);
    seedTask(db, p.id, 'alpha');
    const result = updateTaskStatusHandler(db, p.id, 'alpha', 'bogus');
    assert.equal(result.status, 400);
    const row = db.prepare('SELECT status FROM tasks WHERE project_id = ? AND slug = ?').get(p.id, 'alpha') as { status: string };
    assert.equal(row.status, 'open');
    db.close();
  });

  test('unknown task slug returns 404', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const result = updateTaskStatusHandler(db, p.id, 'does-not-exist', 'done');
    assert.equal(result.status, 404);
    db.close();
  });

  test('successful call writes an audit row with actor human', () => {
    const db = makeDb();
    const p  = seedProject(db);
    seedTask(db, p.id, 'alpha');
    updateTaskStatusHandler(db, p.id, 'alpha', 'done');
    const audit = db.prepare('SELECT * FROM audit WHERE project_id = ?').get(p.id) as { actor: string; event: string };
    assert.equal(audit.actor, 'human');
    assert.equal(audit.event, 'task.done');
    db.close();
  });
});

describe('sessionStartHandler / sessionEndHandler', () => {
  test('start returns 200 with an open session', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const result = sessionStartHandler(db, p.id);
    assert.equal(result.status, 200);
    const row = db.prepare('SELECT * FROM sessions WHERE project_id = ?').get(p.id) as { ended_at: string | null };
    assert.equal(row.ended_at, null);
    db.close();
  });

  test('start twice while a session is active returns 409, does not create a second row', () => {
    const db = makeDb();
    const p  = seedProject(db);
    sessionStartHandler(db, p.id);
    const result = sessionStartHandler(db, p.id);
    assert.equal(result.status, 409);
    const rows = db.prepare('SELECT * FROM sessions WHERE project_id = ?').all(p.id);
    assert.equal(rows.length, 1);
    db.close();
  });

  test('start on unknown project returns 404', () => {
    const db = makeDb();
    const result = sessionStartHandler(db, randomUUID());
    assert.equal(result.status, 404);
    db.close();
  });

  test('end with no active session returns 409', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const result = sessionEndHandler(db, p.id, undefined);
    assert.equal(result.status, 409);
    db.close();
  });

  test('end closes the active session and records minutes', () => {
    const db = makeDb();
    const p  = seedProject(db);
    sessionStartHandler(db, p.id);
    const result = sessionEndHandler(db, p.id, undefined);
    assert.equal(result.status, 200);
    const row = db.prepare('SELECT * FROM sessions WHERE project_id = ?').get(p.id) as { ended_at: string | null; minutes: number | null };
    assert.ok(row.ended_at !== null);
    assert.ok(row.minutes !== null);
    db.close();
  });

  test('start/end write audit rows with actor human', () => {
    const db = makeDb();
    const p  = seedProject(db);
    sessionStartHandler(db, p.id);
    sessionEndHandler(db, p.id, undefined);
    const events = (db.prepare('SELECT event, actor FROM audit WHERE project_id = ? ORDER BY id').all(p.id)) as Array<{ event: string; actor: string }>;
    assert.deepEqual(events.map(e => e.event), ['session.start', 'session.end']);
    assert.ok(events.every(e => e.actor === 'human'));
    db.close();
  });
});

describe('updateProjectStatusHandler', () => {
  test('valid status transition returns 200 and persists', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const result = updateProjectStatusHandler(db, p.id, 'paused');
    assert.equal(result.status, 200);
    const row = db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id) as { status: string };
    assert.equal(row.status, 'paused');
    db.close();
  });

  test('invalid status string returns 400, row unchanged', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const result = updateProjectStatusHandler(db, p.id, 'bogus');
    assert.equal(result.status, 400);
    const row = db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id) as { status: string };
    assert.equal(row.status, 'active');
    db.close();
  });

  test('unknown project id returns 404', () => {
    const db = makeDb();
    const result = updateProjectStatusHandler(db, randomUUID(), 'paused');
    assert.equal(result.status, 404);
    db.close();
  });

  test('successful call writes an audit row with actor human', () => {
    const db = makeDb();
    const p  = seedProject(db);
    updateProjectStatusHandler(db, p.id, 'paused');
    const audit = db.prepare('SELECT * FROM audit WHERE project_id = ?').get(p.id) as { actor: string; event: string };
    assert.equal(audit.actor, 'human');
    assert.equal(audit.event, 'project.paused');
    db.close();
  });
});
