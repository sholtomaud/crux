/**
 * test/unit/db.test.ts
 * Uses an in-memory DB to avoid touching ~/.crux/crux.db
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SCHEMA     = join(__dirname, '../../schema.sql');

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const sql = readFileSync(SCHEMA, 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    db.exec(stmt + ';');
  }
  return db;
}

function seedProject(db: DatabaseSync, name = 'test-proj', type = 'code_repo'): string {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, name, type);
  return id;
}

function seedTask(db: DatabaseSync, projectId: string, slug: string, title = 'A task'): number {
  db.prepare('INSERT INTO tasks (project_id, slug, title) VALUES (?, ?, ?)').run(projectId, slug, title);
  const row = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, slug) as { id: number };
  return row.id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('schema', () => {
  test('applies cleanly on in-memory DB', () => {
    const db = makeDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    assert.ok(names.includes('projects'));
    assert.ok(names.includes('tasks'));
    assert.ok(names.includes('dependencies'));
    assert.ok(names.includes('sessions'));
    assert.ok(names.includes('roi_records'));
    assert.ok(names.includes('test_runs'));
    assert.ok(names.includes('audit'));
    assert.ok(names.includes('adrs'));
    assert.ok(names.includes('task_adrs'));
    db.close();
  });

  test('applies schema twice without error (IF NOT EXISTS)', () => {
    const db = makeDb();
    const sql = readFileSync(SCHEMA, 'utf8');
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      db.exec(stmt + ';');
    }
    db.close();
  });
});

describe('projects', () => {
  test('insert and retrieve project', () => {
    const db = makeDb();
    const id = seedProject(db, 'my-blog', 'article');
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as { name: string; type: string; status: string };
    assert.equal(row.name, 'my-blog');
    assert.equal(row.type, 'article');
    assert.equal(row.status, 'active');
    db.close();
  });

  test('invalid project type is rejected', () => {
    const db = makeDb();
    assert.throws(() => {
      db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(randomUUID(), 'x', 'invalid_type');
    });
    db.close();
  });

  test('invalid project status is rejected', () => {
    const db = makeDb();
    assert.throws(() => {
      db.prepare("INSERT INTO projects (id, name, type, status) VALUES (?, ?, ?, ?)").run(randomUUID(), 'x', 'article', 'bad');
    });
    db.close();
  });
});

describe('tasks', () => {
  test('insert task and retrieve by slug', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const tid = seedTask(db, pid, 'setup', 'Setup project');
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(tid) as { slug: string; status: string; is_critical: number };
    assert.equal(row.slug, 'setup');
    assert.equal(row.status, 'open');
    assert.equal(row.is_critical, 0);
    db.close();
  });

  test('slug is unique per project', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'dup');
    assert.throws(() => seedTask(db, pid, 'dup'));
    db.close();
  });

  test('same slug allowed in different projects', () => {
    const db = makeDb();
    const p1 = seedProject(db, 'proj-a');
    const p2 = seedProject(db, 'proj-b');
    assert.doesNotThrow(() => {
      seedTask(db, p1, 'init');
      seedTask(db, p2, 'init');
    });
    db.close();
  });

  test('invalid task status is rejected', () => {
    const db = makeDb();
    const pid = seedProject(db);
    assert.throws(() => {
      db.prepare('INSERT INTO tasks (project_id, slug, title, status) VALUES (?, ?, ?, ?)').run(pid, 'bad', 'Bad', 'invalid');
    });
    db.close();
  });

  test('update task status', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 't1');
    db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = ? AND slug = ?").run(pid, 't1');
    const row = db.prepare('SELECT status FROM tasks WHERE project_id = ? AND slug = ?').get(pid, 't1') as { status: string };
    assert.equal(row.status, 'done');
    db.close();
  });
});

describe('dependencies', () => {
  test('add predecessor→successor edge', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const a = seedTask(db, pid, 'a');
    const b = seedTask(db, pid, 'b');
    db.prepare('INSERT INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(a, b);
    const rows = db.prepare('SELECT * FROM dependencies').all();
    assert.equal(rows.length, 1);
    db.close();
  });

  test('self-dependency is rejected', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const a = seedTask(db, pid, 'a');
    assert.throws(() => {
      db.prepare('INSERT INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(a, a);
    });
    db.close();
  });

  test('duplicate edge is ignored (INSERT OR IGNORE)', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const a = seedTask(db, pid, 'a');
    const b = seedTask(db, pid, 'b');
    db.prepare('INSERT OR IGNORE INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(a, b);
    db.prepare('INSERT OR IGNORE INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(a, b);
    const rows = db.prepare('SELECT * FROM dependencies').all();
    assert.equal(rows.length, 1);
    db.close();
  });
});

describe('sessions', () => {
  test('start and end a session', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const res = db.prepare('INSERT INTO sessions (project_id) VALUES (?)').run(pid);
    const id = res.lastInsertRowid;
    db.prepare(`
      UPDATE sessions SET ended_at = datetime('now'), minutes = 30 WHERE id = ?
    `).run(id);
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as { ended_at: string; minutes: number };
    assert.ok(row.ended_at);
    assert.equal(row.minutes, 30);
    db.close();
  });
});

describe('roi_records', () => {
  test('insert revenue record', () => {
    const db = makeDb();
    const pid = seedProject(db);
    db.prepare('INSERT INTO roi_records (project_id, amount, kind) VALUES (?, ?, ?)').run(pid, 500, 'revenue');
    const row = db.prepare('SELECT * FROM roi_records WHERE project_id = ?').get(pid) as { amount: number; kind: string };
    assert.equal(row.amount, 500);
    assert.equal(row.kind, 'revenue');
    db.close();
  });

  test('invalid roi kind is rejected', () => {
    const db = makeDb();
    const pid = seedProject(db);
    assert.throws(() => {
      db.prepare('INSERT INTO roi_records (project_id, amount, kind) VALUES (?, ?, ?)').run(pid, 100, 'bad');
    });
    db.close();
  });

  test('probability must be between 0 and 1', () => {
    const db = makeDb();
    const pid = seedProject(db);
    assert.throws(() => {
      db.prepare('INSERT INTO roi_records (project_id, amount, kind, probability) VALUES (?, ?, ?, ?)').run(pid, 100, 'expected', 1.5);
    });
    db.close();
  });
});

describe('audit', () => {
  test('log an audit entry', () => {
    const db = makeDb();
    const pid = seedProject(db);
    db.prepare('INSERT INTO audit (project_id, event, actor) VALUES (?, ?, ?)').run(pid, 'task.done', 'human');
    const row = db.prepare('SELECT * FROM audit WHERE project_id = ?').get(pid) as { event: string; actor: string };
    assert.equal(row.event, 'task.done');
    assert.equal(row.actor, 'human');
    db.close();
  });

  test('invalid actor is rejected', () => {
    const db = makeDb();
    const pid = seedProject(db);
    assert.throws(() => {
      db.prepare('INSERT INTO audit (project_id, event, actor) VALUES (?, ?, ?)').run(pid, 'x', 'robot');
    });
    db.close();
  });
});
