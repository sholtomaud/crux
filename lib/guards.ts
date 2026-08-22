/**
 * lib/guards.ts — transition guards (ADR-011)
 *
 * crux has always had the data to know when a status change doesn't add up — a
 * dependency DAG, real `test_runs`, recorded actuals — and never consulted it:
 * `updateTaskStatus` was a bare UPDATE behind a CHECK constraint.
 *
 * These are pure functions of (db, task, target status). They report; they do
 * not decide. Whether a failing guard blocks or merely warns is the caller's
 * policy question, answered by `guardPolicy()` — the default is 'warn', so
 * turning the checks on cannot break a workflow that was working yesterday.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { Task, TaskStatus } from './db/types.ts';
import { tasksByProject } from './db/tasks.ts';
import { dependenciesByProject } from './db/dependencies.ts';
import { projectById } from './db/projects.ts';
import { getConfig } from './db/config.ts';

export const GUARD_POLICIES = ['warn', 'enforce', 'off'] as const;
export type GuardPolicy = typeof GUARD_POLICIES[number];

export const GUARD_POLICY_KEY = 'guard_policy';

/**
 * How a failing guard is treated. Defaults to 'warn': the transition still
 * happens and the reason is surfaced. Flip to 'enforce' once the warnings have
 * been quiet for a while — see `crux config guard-policy`.
 */
export function guardPolicy(db: DatabaseSync): GuardPolicy {
  const raw = getConfig(db, GUARD_POLICY_KEY);
  return (GUARD_POLICIES as readonly string[]).includes(raw ?? '') ? (raw as GuardPolicy) : 'warn';
}

export interface GuardFailure {
  /** Stable machine-readable id, e.g. 'predecessors-incomplete'. */
  code:   string;
  reason: string;
}

/** Predecessors must be done (or dropped) before work starts or finishes. */
function guardPredecessors(db: DatabaseSync, task: Task, to: TaskStatus): GuardFailure | null {
  if (to !== 'in-progress' && to !== 'done') return null;

  const deps = dependenciesByProject(db, task.project_id).filter(d => d.successor_id === task.id);
  if (deps.length === 0) return null;

  const byId    = new Map(tasksByProject(db, task.project_id).map(t => [t.id, t]));
  const pending = deps
    .map(d => byId.get(d.predecessor_id))
    .filter((t): t is Task => !!t && t.status !== 'done' && t.status !== 'dropped');

  if (pending.length === 0) return null;
  return {
    code: 'predecessors-incomplete',
    reason: `${pending.length} predecessor${pending.length === 1 ? '' : 's'} not done: ${pending.map(t => `${t.slug} (${t.status})`).join(', ')}`,
  };
}

/**
 * A task must not close over a failing test run.
 *
 * Deliberately narrow: it objects to a *red* run, never to a missing one. An
 * earlier version warned on absence too, and measured against the live DB it
 * fired on 136 of 216 open tasks — because only 3 `test_runs` rows exist across
 * 14 projects. That is a measure of whether `crux test-run` is in the
 * operator's habits, not of whether the code works, and a guard that fires on
 * 63% of transitions with nothing useful to say trains you to ignore all three.
 * Tests actually run through `make test` and CI without ever touching this
 * table. When a red run *is* recorded, the objection is unambiguous.
 */
function guardTests(db: DatabaseSync, task: Task, to: TaskStatus): GuardFailure | null {
  if (to !== 'done') return null;

  const proj = projectById(db, task.project_id);
  if (!proj?.test_cmd) return null;

  const latest = db.prepare(
    'SELECT status FROM test_runs WHERE project_id = ? AND task_slug = ? ORDER BY run_at DESC LIMIT 1'
  ).get(task.project_id, task.slug) as { status: string } | undefined;

  if (latest && latest.status !== 'pass') {
    return { code: 'tests-not-green', reason: `latest test run for ${task.slug} was a ${latest.status}` };
  }
  return null;
}

/**
 * Closing without `actual_days` is the leak that starves the calibration
 * factor: 52/52 Claude-estimated tasks calibrate, but the human path drops
 * actuals on the floor, so `days_per_point` and `capital_required` never
 * self-correct for human work.
 */
function guardActuals(_db: DatabaseSync, task: Task, to: TaskStatus): GuardFailure | null {
  if (to !== 'done') return null;
  if (task.actual_days !== null && task.actual_days !== undefined) return null;
  if (task.duration_days === null || task.duration_days === undefined) return null; // nothing to calibrate against
  return {
    code: 'actuals-missing',
    reason: `no actual_days recorded — estimate of ${task.duration_days}d can never be calibrated`,
  };
}

const GUARDS = [guardPredecessors, guardTests, guardActuals];

/** Every guard that objects to this transition. Empty means clean. */
export function evaluateTransition(db: DatabaseSync, task: Task, to: TaskStatus): GuardFailure[] {
  if (task.status === to) return [];
  return GUARDS.map(g => g(db, task, to)).filter((f): f is GuardFailure => f !== null);
}

/** One-line rendering for CLI stderr and audit detail. */
export function formatFailures(failures: GuardFailure[]): string {
  return failures.map(f => `${f.code}: ${f.reason}`).join('; ');
}
