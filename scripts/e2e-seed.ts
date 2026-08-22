/**
 * scripts/e2e-seed.ts — deterministic fixture data for the e2e tier.
 *
 * Writes into $HOME/.crux/crux.db, and playwright.config.ts points HOME at a
 * throwaway directory before running this. That isolation is the whole point:
 * without it the suite would read the developer's real database, and the
 * screenshots would publish whatever happened to be in it.
 *
 * Seeds through the db layer rather than the CLI because `crux task add` cannot
 * set executor, value_score or duration — a CLI-seeded fixture would render
 * every badge as "auto" with no WSJF chips and no critical path, which is
 * exactly the detail the screenshots exist to show.
 */

import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  openDb, closeDb, insertProject, insertTask, addDependency,
  updateTaskStatus, updateProjectStatus, insertRoi,
} from '../lib/db/index.ts';
import type { TaskExecutor, TaskStatus } from '../lib/db/index.ts';

// This script deletes a crux.db before rebuilding it, so it refuses to run
// unless HOME has been explicitly redirected at a fixture directory. Guessing
// here would mean wiping someone's real project database.
const HOME    = homedir();
const FIXTURE = process.env.CRUX_E2E_HOME;
if (!FIXTURE || FIXTURE !== HOME) {
  throw new Error(
    'refusing to seed: CRUX_E2E_HOME must be set and equal to HOME.\n' +
    `  HOME=${HOME}\n  CRUX_E2E_HOME=${FIXTURE ?? '(unset)'}\n` +
    'Run this through `make test-e2e` / playwright.config.ts, which set both.'
  );
}

// Start from nothing so runs are repeatable rather than cumulative.
const dbPath = join(HOME, '.crux', 'crux.db');
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
}

const db = openDb();

type Spec = {
  slug: string; title: string; phase: string;
  executor: TaskExecutor; status: TaskStatus;
  duration_days: number; value_score: number;
  deps?: string[];
};

/** A chain long enough to produce a real critical path in the graph view. */
const CRUX_TASKS: Spec[] = [
  { slug: 'f0-repo',       title: 'Scaffold repository and tooling', phase: 'Foundation', executor: 'llm',    status: 'done',        duration_days: 1,   value_score: 60 },
  { slug: 'd1-schema',     title: 'Design the database schema',      phase: 'Data',       executor: 'llm',    status: 'done',        duration_days: 1.5, value_score: 80, deps: ['f0-repo'] },
  { slug: 'd1-migrations', title: 'Idempotent migration runner',     phase: 'Data',       executor: 'llm',    status: 'done',        duration_days: 1,   value_score: 70, deps: ['d1-schema'] },
  { slug: 'a2-jwt',        title: 'Token issuing and refresh',       phase: 'Auth',       executor: 'hybrid', status: 'in-progress', duration_days: 2,   value_score: 90, deps: ['d1-migrations'] },
  { slug: 'a2-rbac',       title: 'Role-based access control',       phase: 'Auth',       executor: 'human',  status: 'blocked',     duration_days: 1.5, value_score: 75, deps: ['a2-jwt'] },
  { slug: 'r3-projects',   title: 'Projects REST resource',          phase: 'API',        executor: 'llm',    status: 'todo',        duration_days: 1,   value_score: 65, deps: ['a2-rbac'] },
  { slug: 'r3-tasks',      title: 'Tasks REST resource',             phase: 'API',        executor: 'llm',    status: 'todo',        duration_days: 1.5, value_score: 85, deps: ['r3-projects'] },
  { slug: 'fe4-kanban',    title: 'Kanban board view',               phase: 'Frontend',   executor: 'llm',    status: 'todo',        duration_days: 2,   value_score: 70, deps: ['r3-tasks'] },
  { slug: 'fe4-graph',     title: 'Dependency graph view',           phase: 'Frontend',   executor: 'hybrid', status: 'todo',        duration_days: 1.5, value_score: 55, deps: ['r3-tasks'] },
  { slug: 't5-e2e',        title: 'End-to-end test suite',           phase: 'Quality',    executor: 'llm',    status: 'todo',        duration_days: 1,   value_score: 60, deps: ['fe4-kanban'] },
];

function seedProject(name: string, type: 'code_repo' | 'research' | 'freelance', tasks: Spec[]) {
  const project = insertProject(db, { name, type });
  const ids = new Map<string, number>();
  for (const t of tasks) {
    const task = insertTask(db, {
      project_id: project.id,
      slug: t.slug, title: t.title, phase: t.phase,
      executor: t.executor, duration_days: t.duration_days, value_score: t.value_score,
      acceptance_criteria: `${t.title} is verified by an automated test.`,
      files_affected: ['lib/example.ts'],
    });
    ids.set(t.slug, task.id);
    if (t.status !== 'todo') updateTaskStatus(db, project.id, t.slug, t.status);
  }
  for (const t of tasks) {
    for (const dep of t.deps ?? []) addDependency(db, ids.get(dep)!, ids.get(t.slug)!);
  }
  return project;
}

const main = seedProject('Atlas Platform', 'code_repo', CRUX_TASKS);

seedProject('Quarterly Report', 'research', [
  { slug: 'q1-outline', title: 'Draft the outline',   phase: 'Writing', executor: 'human', status: 'done', duration_days: 0.5, value_score: 40 },
  { slug: 'q1-figures', title: 'Produce the figures', phase: 'Writing', executor: 'llm',   status: 'todo', duration_days: 1,   value_score: 55, deps: ['q1-outline'] },
]);

const paused = seedProject('Client Retainer', 'freelance', [
  { slug: 'c1-scope', title: 'Agree scope of works', phase: 'Discovery', executor: 'human', status: 'done', duration_days: 0.5, value_score: 50 },
]);
// A non-active project so the Portfolio shows more than one status treatment.
updateProjectStatus(db, paused.id, 'paused');

insertRoi(db, { project_id: main.id, amount: 4800, kind: 'revenue', note: 'Phase one invoice' });
insertRoi(db, { project_id: main.id, amount: 1200, kind: 'cost',    note: 'Infrastructure' });
insertRoi(db, { project_id: main.id, amount: 9000, kind: 'expected', probability: 0.6, note: 'Phase two' });

closeDb();
console.log(`✓ e2e fixture seeded at ${dbPath}`);
