/**
 * lib/db/test-runs.ts — test run recording and retrieval
 */

import { DatabaseSync } from 'node:sqlite';

import type { TestRun, TestPhase } from './types.ts';

export function insertTestRun(
  db: DatabaseSync,
  opts: {
    project_id: string;
    phase: TestPhase;
    status: 'pass' | 'fail';
    task_slug?: string;
    coverage?: number;
    output?: string;
    commit_sha?: string;
  }
): TestRun {
  const result = db.prepare(`
    INSERT INTO test_runs (project_id, task_slug, phase, status, coverage, output, commit_sha)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.project_id,
    opts.task_slug ?? null,
    opts.phase,
    opts.status,
    opts.coverage ?? null,
    opts.output ?? null,
    opts.commit_sha ?? null,
  );
  return db.prepare('SELECT * FROM test_runs WHERE id = ?').get(result.lastInsertRowid) as unknown as TestRun;
}

export function getLatestTestRun(db: DatabaseSync, projectId: string): TestRun | null {
  return (db.prepare(
    'SELECT * FROM test_runs WHERE project_id = ? ORDER BY run_at DESC LIMIT 1'
  ).get(projectId) as unknown as TestRun) ?? null;
}
