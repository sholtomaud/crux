/**
 * test/unit/task-show.test.ts — `crux task show` / crux_task_show building blocks:
 * the pure formatter plus the two DB reads it depends on.
 * Uses an in-memory DB to avoid touching ~/.crux/crux.db
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { formatTaskDetail } from '../../lib/cli-format.ts';
import { addDependency, taskNeighbours } from '../../lib/db/dependencies.ts';
import { logAudit, auditByTask } from '../../lib/db/audit.ts';
import type { Task } from '../../lib/db.ts';

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

function seedTask(db: DatabaseSync, projectId: string, slug: string): number {
  db.prepare('INSERT INTO tasks (project_id, slug, title) VALUES (?, ?, ?)').run(projectId, slug, `title of ${slug}`);
  return (db.prepare('SELECT id FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, slug) as { id: number }).id;
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1, project_id: 'p', slug: 'p1-thing', title: 'Do the thing',
    description: null, phase: null, status: 'todo', priority: 3,
    duration_days: null, actual_days: null, estimated_by: 'human',
    early_start: null, early_finish: null, late_start: null, late_finish: null,
    float_days: null, is_critical: 0, gh_issue_number: null, worktree_path: null,
    coverage_target: null, value_score: null, task_type: 'coding', executor: 'llm',
    acceptance_criteria: null, files_affected: null, files_to_create: null,
    created_at: '2026-01-01',
    ...overrides,
  };
}

const NO_DEPS = { predecessors: [], successors: [] };

describe('formatTaskDetail', () => {
  test('leads with slug, title, status, type and executor', () => {
    const out = formatTaskDetail(fakeTask({ status: 'in-progress' }), NO_DEPS);
    assert.ok(out.includes('p1-thing — Do the thing'));
    assert.ok(out.includes('[in-progress · coding · llm]'));
  });

  test('marks critical-path tasks', () => {
    assert.ok(formatTaskDetail(fakeTask({ is_critical: 1 }), NO_DEPS).includes('★ critical path'));
    assert.ok(!formatTaskDetail(fakeTask(), NO_DEPS).includes('★'));
  });

  test('renders em-dashes for unset numeric fields rather than null', () => {
    const out = formatTaskDetail(fakeTask(), NO_DEPS);
    assert.ok(out.includes('Duration:  —d est'));
    assert.ok(out.includes('float —'));
    assert.ok(!out.includes('null'));
  });

  test('omits optional sections when their fields are empty', () => {
    const out = formatTaskDetail(fakeTask(), NO_DEPS);
    for (const section of ['Description:', 'Acceptance criteria:', 'Files affected:', 'Files to create:', 'Depends on:', 'Blocks:', 'Recent activity:']) {
      assert.ok(!out.includes(section), `expected no "${section}" section`);
    }
    assert.ok(!out.includes('Coverage:'));
    assert.ok(!out.includes('Issue:'));
    assert.ok(!out.includes('Worktree:'));
  });

  test('includes spec fields when present', () => {
    const out = formatTaskDetail(fakeTask({
      description: 'why this exists',
      acceptance_criteria: 'returns null on empty input',
      coverage_target: 80,
      gh_issue_number: 42,
      worktree_path: '/tmp/wt',
    }), NO_DEPS);
    assert.ok(out.includes('why this exists'));
    assert.ok(out.includes('returns null on empty input'));
    assert.ok(out.includes('80% target'));
    assert.ok(out.includes('#42'));
    assert.ok(out.includes('/tmp/wt'));
  });

  test('lists files_affected strings and files_to_create objects', () => {
    const out = formatTaskDetail(fakeTask({
      files_affected: JSON.stringify(['lib/db.ts', 'index.ts']),
      files_to_create: JSON.stringify([{ path: 'lib/new.ts', signature: 'export function f(): void' }]),
    }), NO_DEPS);
    assert.ok(out.includes('- lib/db.ts'));
    assert.ok(out.includes('- index.ts'));
    assert.ok(out.includes('- lib/new.ts  export function f(): void'));
  });

  test('survives malformed JSON in file columns', () => {
    const out = formatTaskDetail(fakeTask({ files_affected: 'not json', files_to_create: '{"path":"x"}' }), NO_DEPS);
    assert.ok(!out.includes('Files affected:'));
    assert.ok(!out.includes('Files to create:'));
  });

  test('shows dependency neighbours with status marks', () => {
    const out = formatTaskDetail(fakeTask(), {
      predecessors: [{ slug: 'p1-a', title: 'A', status: 'done' }],
      successors:   [{ slug: 'p1-b', title: 'B', status: 'blocked' }],
    });
    assert.ok(out.includes('Depends on:'));
    assert.ok(out.includes('✓ p1-a  A'));
    assert.ok(out.includes('Blocks:'));
    assert.ok(out.includes('✗ p1-b  B'));
  });

  /**
   * A todo predecessor is an unmet blocker; a dropped one is settled. They used
   * to share '·', which made an open dependency read as satisfied next to the
   * '✓' of a done one.
   */
  test('an unmet predecessor is marked differently from a dropped one', () => {
    const out = formatTaskDetail(fakeTask(), {
      predecessors: [
        { slug: 'p1-done',    title: 'Done',    status: 'done' },
        { slug: 'p1-todo',    title: 'Todo',    status: 'todo' },
        { slug: 'p1-dropped', title: 'Dropped', status: 'dropped' },
      ],
      successors: [],
    });
    assert.ok(out.includes('✓ p1-done'));
    assert.ok(out.includes('· p1-todo'));
    assert.ok(out.includes('⊘ p1-dropped'));
  });

  test('renders audit entries when supplied', () => {
    const out = formatTaskDetail(fakeTask(), {
      ...NO_DEPS,
      audit: [{ id: 1, project_id: 'p', task_id: 1, event: 'task.start', detail: null, actor: 'human', created_at: '2026-07-30' }],
    });
    assert.ok(out.includes('Recent activity:'));
    assert.ok(out.includes('2026-07-30  task.start  (human)'));
  });
});

describe('taskNeighbours', () => {
  test('separates predecessors from successors', () => {
    const db = makeDb();
    const proj = seedProject(db);
    const a = seedTask(db, proj, 'a');
    const b = seedTask(db, proj, 'b');
    const c = seedTask(db, proj, 'c');
    addDependency(db, a, b);
    addDependency(db, b, c);

    const n = taskNeighbours(db, b);
    assert.deepEqual(n.predecessors.map(t => t.slug), ['a']);
    assert.deepEqual(n.successors.map(t => t.slug), ['c']);
  });

  test('returns empty arrays for an isolated task', () => {
    const db = makeDb();
    const proj = seedProject(db);
    const n = taskNeighbours(db, seedTask(db, proj, 'lonely'));
    assert.deepEqual(n, { predecessors: [], successors: [] });
  });
});

describe('auditByTask', () => {
  test('returns only this task\'s entries, newest first, capped by limit', () => {
    const db = makeDb();
    const proj = seedProject(db);
    const a = seedTask(db, proj, 'a');
    const b = seedTask(db, proj, 'b');
    logAudit(db, { project_id: proj, task_id: a, event: 'task.add', detail: 'first' });
    logAudit(db, { project_id: proj, task_id: a, event: 'task.start' });
    logAudit(db, { project_id: proj, task_id: b, event: 'task.add', detail: 'other task' });

    const entries = auditByTask(db, a);
    assert.equal(entries.length, 2);
    assert.ok(entries.every(e => e.task_id === a));
    assert.equal(auditByTask(db, a, 1).length, 1);
  });
});
