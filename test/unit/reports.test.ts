/**
 * test/unit/reports.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { reportTasks, reportStatus, reportOverview } from '../../lib/reports.ts';

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
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as { id: string; name: string; type: string; status: string; gh_repo: null; gh_sync: number; sheets_id: null; hourly_rate: null; created_at: string };
}

function seedTask(db: DatabaseSync, projectId: string, slug: string, opts: { title?: string; status?: string; phase?: string; duration_days?: number } = {}) {
  db.prepare(`
    INSERT INTO tasks (project_id, slug, title, status, phase, duration_days)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, slug, opts.title ?? slug, opts.status ?? 'open', opts.phase ?? null, opts.duration_days ?? null);
  return db.prepare('SELECT id FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, slug) as { id: number };
}

describe('reportTasks', () => {
  test('generates GENERATED header', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const md = reportTasks(db, p as any);
    assert.ok(md.includes('<!-- GENERATED'));
    db.close();
  });

  test('includes task slugs', () => {
    const db = makeDb();
    const p  = seedProject(db);
    seedTask(db, p.id, 'setup');
    seedTask(db, p.id, 'build');
    const md = reportTasks(db, p as any);
    assert.ok(md.includes('`setup`'));
    assert.ok(md.includes('`build`'));
    db.close();
  });

  test('groups tasks by phase', () => {
    const db = makeDb();
    const p  = seedProject(db);
    seedTask(db, p.id, 't1', { phase: 'Phase 1' });
    seedTask(db, p.id, 't2', { phase: 'Phase 2' });
    const md = reportTasks(db, p as any);
    assert.ok(md.includes('## Phase 1'));
    assert.ok(md.includes('## Phase 2'));
    db.close();
  });

  test('shows dependency slugs', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const a  = seedTask(db, p.id, 'alpha');
    const b  = seedTask(db, p.id, 'beta');
    db.prepare('INSERT INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(a.id, b.id);
    const md = reportTasks(db, p as any);
    assert.ok(md.includes('alpha'));
    db.close();
  });

  test('status counts in summary', () => {
    const db = makeDb();
    const p  = seedProject(db);
    seedTask(db, p.id, 't1', { status: 'done' });
    seedTask(db, p.id, 't2', { status: 'open' });
    seedTask(db, p.id, 't3', { status: 'blocked' });
    const md = reportTasks(db, p as any);
    assert.ok(md.includes('Done:** 1'));
    assert.ok(md.includes('Open:** 1'));
    assert.ok(md.includes('Blocked:** 1'));
    db.close();
  });
});

describe('reportStatus', () => {
  test('generates GENERATED header', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const md = reportStatus(db, p as any);
    assert.ok(md.includes('<!-- GENERATED'));
    db.close();
  });

  test('includes progress table', () => {
    const db = makeDb();
    const p  = seedProject(db);
    seedTask(db, p.id, 't1', { status: 'done' });
    const md = reportStatus(db, p as any);
    assert.ok(md.includes('Progress'));
    assert.ok(md.includes('Done'));
    db.close();
  });

  test('includes ROI section', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const md = reportStatus(db, p as any);
    assert.ok(md.includes('ROI'));
    assert.ok(md.includes('Hours invested'));
    db.close();
  });

  test('CPM summary appears for valid DAG', () => {
    const db = makeDb();
    const p  = seedProject(db);
    const a  = seedTask(db, p.id, 'a', { duration_days: 3 });
    const b  = seedTask(db, p.id, 'b', { duration_days: 2 });
    db.prepare('INSERT INTO dependencies (predecessor_id, successor_id) VALUES (?, ?)').run(a.id, b.id);
    const md = reportStatus(db, p as any);
    assert.ok(md.includes('Critical Path'));
    db.close();
  });
});

describe('reportOverview', () => {
  test('generates GENERATED header', () => {
    const db = makeDb();
    const md = reportOverview(db);
    assert.ok(md.includes('<!-- GENERATED'));
    db.close();
  });

  test('lists all projects', () => {
    const db = makeDb();
    seedProject(db, 'project-alpha');
    seedProject(db, 'project-beta');
    const md = reportOverview(db);
    assert.ok(md.includes('project-alpha'));
    assert.ok(md.includes('project-beta'));
    db.close();
  });

  test('spread warning when more than 2 active projects', () => {
    const db = makeDb();
    seedProject(db, 'p1');
    seedProject(db, 'p2');
    seedProject(db, 'p3');
    const md = reportOverview(db);
    assert.ok(md.includes('SPREAD'));
    db.close();
  });

  test('no spread warning for 2 projects', () => {
    const db = makeDb();
    seedProject(db, 'p1');
    seedProject(db, 'p2');
    const md = reportOverview(db);
    assert.ok(!md.includes('SPREAD'));
    db.close();
  });
});
