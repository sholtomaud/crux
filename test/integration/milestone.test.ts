/**
 * test/integration/milestone.test.ts
 * Tests phase completion detection and milestone issue creation.
 * All created resources labelled `pm-test` for easy teardown.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureLabel, listIssues, getIssue, teardownTestIssues, createMilestoneIssue } from '../../lib/gh.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SCHEMA     = join(__dirname, '../../schema.sql');
const REPO       = 'sholtomaud/crux-test';

// ── DB helpers ────────────────────────────────────────────────────────────────

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const sql = readFileSync(SCHEMA, 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    db.exec(stmt + ';');
  }
  return db;
}

function seedProject(db: DatabaseSync, name = 'test-proj'): string {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, name, 'code_repo');
  return id;
}

function seedTask(db: DatabaseSync, projectId: string, slug: string, phase: string, status = 'open'): void {
  db.prepare(
    'INSERT INTO tasks (project_id, slug, title, phase, status) VALUES (?, ?, ?, ?, ?)'
  ).run(projectId, slug, `Task ${slug}`, phase, status);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(() => {
  ensureLabel(REPO, 'pm-test',   'e4e669', 'Created by crux integration tests');
  ensureLabel(REPO, 'milestone', 'd93f0b', 'Phase milestone');
});

after(() => {
  teardownTestIssues(REPO);
});

// ── Milestone detection logic ─────────────────────────────────────────────────

describe('milestone detection', () => {
  test('phase is complete when all tasks in phase are done', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'p0-a', 'Phase 0', 'done');
    seedTask(db, pid, 'p0-b', 'Phase 0', 'done');

    const incomplete = db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks
      WHERE project_id = ? AND phase = 'Phase 0' AND status != 'done'
    `).get(pid) as { cnt: number };

    assert.equal(incomplete.cnt, 0, 'all tasks in phase should be done');
    db.close();
  });

  test('phase is not complete when some tasks remain open', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'p1-a', 'Phase 1', 'done');
    seedTask(db, pid, 'p1-b', 'Phase 1', 'open');

    const incomplete = db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks
      WHERE project_id = ? AND phase = 'Phase 1' AND status != 'done'
    `).get(pid) as { cnt: number };

    assert.ok(incomplete.cnt > 0, 'phase should not be complete with open tasks');
    db.close();
  });
});

// ── Milestone GH issue ────────────────────────────────────────────────────────

describe('milestone issue creation', () => {
  let milestoneIssueNumber: number;

  test('creates a milestone issue with correct labels', () => {
    const issue = createMilestoneIssue(
      REPO,
      '[pm-test] Phase 0',
      'All Phase 0 tasks complete.\n\n_Created by crux integration test._',
    );
    assert.ok(issue.number > 0, 'milestone issue should have a number');
    assert.ok(issue.title.includes('Milestone'), 'title should contain "Milestone"');
    milestoneIssueNumber = issue.number;
  });

  test('created milestone issue is retrievable by number', () => {
    assert.ok(milestoneIssueNumber > 0, 'previous test must have created an issue');
    const issue = getIssue(REPO, milestoneIssueNumber);
    assert.ok(issue.number === milestoneIssueNumber, 'should retrieve the same issue');
    assert.ok(issue.title.includes('Milestone'), 'title should contain "Milestone"');
  });
});

// ── Phase summary ─────────────────────────────────────────────────────────────

describe('phase summary', () => {
  test('correctly summarises task counts per phase', () => {
    const db = makeDb();
    const pid = seedProject(db);
    seedTask(db, pid, 'p2-a', 'Phase 2', 'done');
    seedTask(db, pid, 'p2-b', 'Phase 2', 'done');
    seedTask(db, pid, 'p2-c', 'Phase 2', 'open');

    const rows = db.prepare(`
      SELECT status, COUNT(*) as cnt FROM tasks
      WHERE project_id = ? AND phase = 'Phase 2'
      GROUP BY status
    `).all(pid) as Array<{ status: string; cnt: number }>;

    const byStatus = Object.fromEntries(rows.map(r => [r.status, r.cnt]));
    assert.equal(byStatus['done'], 2);
    assert.equal(byStatus['open'], 1);
    db.close();
  });
});
