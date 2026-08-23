/**
 * lib/db/agent-runs.ts — per-invocation LLM telemetry (ADR-010)
 *
 * Aggregates here always report coverage — how many runs actually carried
 * usage — alongside the totals. The obvious reporting bug is a mean that
 * quietly divides by the measured rows and presents the result as the whole
 * picture; `runs` vs `runs_with_cost` is what makes that visible.
 */

import { DatabaseSync } from 'node:sqlite';

import type { AgentRole, AgentRun, RunOutcome } from './types.ts';
import { insertRoi } from './roi.ts';

export interface NewAgentRun {
  project_id:     string | null;
  task_id?:       number | null;
  agent_id?:      string | null;
  role:           AgentRole;
  step?:          string | null;
  provider:       string;
  model?:         string | null;
  started_at:     string;
  completed_at:   string;
  duration_ms?:   number | null;
  input_tokens?:  number | null;
  output_tokens?: number | null;
  cost_usd?:      number | null;
  outcome:        RunOutcome;
  detail?:        string | null;
}

/** Insert one run. Returns the new row id. */
export function insertAgentRun(db: DatabaseSync, run: NewAgentRun): number {
  const info = db.prepare(`
    INSERT INTO agent_runs (
      project_id, task_id, agent_id, role, step, provider, model,
      started_at, completed_at, duration_ms,
      input_tokens, output_tokens, cost_usd, outcome, detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.project_id,
    run.task_id       ?? null,
    run.agent_id      ?? null,
    run.role,
    run.step          ?? null,
    run.provider,
    run.model         ?? null,
    run.started_at,
    run.completed_at,
    run.duration_ms   ?? null,
    run.input_tokens  ?? null,
    run.output_tokens ?? null,
    run.cost_usd      ?? null,
    run.outcome,
    run.detail        ?? null,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Insert a run and, when it cost real money, mirror it into `roi_records` so
 * the capital model's `monthly_burn` / `runway_weeks` see measured agent spend
 * rather than manual entry. Zero-cost local inference is logged but not
 * mirrored — it is not a cash outflow.
 */
export function recordAgentRun(db: DatabaseSync, run: NewAgentRun): number {
  const id = insertAgentRun(db, run);
  if (run.project_id && run.cost_usd !== null && run.cost_usd !== undefined && run.cost_usd > 0) {
    insertRoi(db, {
      project_id: run.project_id,
      amount:     run.cost_usd,
      kind:       'cost',
      currency:   'USD',
      note:       `agent_run:${id} ${run.role}${run.step ? `/${run.step}` : ''} ${run.provider}`,
    });
  }
  return id;
}

export function agentRunsByTask(db: DatabaseSync, taskId: number): AgentRun[] {
  return db.prepare(
    'SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at'
  ).all(taskId) as unknown as AgentRun[];
}

export interface SpendSummary {
  runs:            number;
  runs_with_usage: number;
  runs_with_cost:  number;
  input_tokens:    number;
  output_tokens:   number;
  total_cost_usd:  number;
  errors:          number;
}

const SPEND_COLUMNS = `
  COUNT(*)                                          AS runs,
  SUM(input_tokens IS NOT NULL
      OR output_tokens IS NOT NULL)                 AS runs_with_usage,
  SUM(cost_usd IS NOT NULL)                         AS runs_with_cost,
  COALESCE(SUM(input_tokens), 0)                    AS input_tokens,
  COALESCE(SUM(output_tokens), 0)                   AS output_tokens,
  COALESCE(SUM(cost_usd), 0)                        AS total_cost_usd,
  SUM(outcome = 'error')                            AS errors
`;

/** Spend for one project. `runs_with_cost < runs` means the total understates. */
export function projectSpend(db: DatabaseSync, projectId: string): SpendSummary {
  return db.prepare(
    `SELECT ${SPEND_COLUMNS} FROM agent_runs WHERE project_id = ?`
  ).get(projectId) as unknown as SpendSummary;
}

export function spendByRole(
  db: DatabaseSync,
  projectId: string,
): Array<SpendSummary & { role: AgentRole }> {
  return db.prepare(
    `SELECT role, ${SPEND_COLUMNS} FROM agent_runs WHERE project_id = ? GROUP BY role ORDER BY total_cost_usd DESC`
  ).all(projectId) as unknown as Array<SpendSummary & { role: AgentRole }>;
}

export function spendByStep(
  db: DatabaseSync,
  projectId: string,
): Array<SpendSummary & { step: string | null }> {
  return db.prepare(
    `SELECT step, ${SPEND_COLUMNS} FROM agent_runs WHERE project_id = ? GROUP BY step ORDER BY total_cost_usd DESC`
  ).all(projectId) as unknown as Array<SpendSummary & { step: string | null }>;
}

export interface SpendReport {
  project_id: string;
  total:      SpendSummary;
  /** runs_with_cost / runs. Below 1, every dollar figure here is a floor. */
  cost_coverage: number | null;
  /** Agent spend per estimated day of work, over tasks that carry both. */
  cost_per_duration_day: number | null;
  by_role: Array<SpendSummary & { role: AgentRole }>;
  by_step: Array<SpendSummary & { step: string | null }>;
  by_task: Array<SpendSummary & { task_id: number | null; slug: string | null }>;
}

/**
 * Everything the CLI, MCP and UI need about a project's agent spend, computed
 * once. `cost_coverage` travels with the totals deliberately — a total quoted
 * without it invites reading measured spend as complete spend.
 */
export function spendReport(db: DatabaseSync, projectId: string): SpendReport {
  const total = projectSpend(db, projectId);

  const denom = db.prepare(`
    SELECT COALESCE(SUM(t.duration_days), 0) AS days
    FROM tasks t
    WHERE t.project_id = ?
      AND t.duration_days IS NOT NULL
      AND EXISTS (SELECT 1 FROM agent_runs a WHERE a.task_id = t.id AND a.cost_usd IS NOT NULL)
  `).get(projectId) as { days: number };

  return {
    project_id: projectId,
    total,
    cost_coverage: total.runs > 0 ? total.runs_with_cost / total.runs : null,
    cost_per_duration_day: denom.days > 0 ? total.total_cost_usd / denom.days : null,
    by_role: spendByRole(db, projectId),
    by_step: spendByStep(db, projectId),
    by_task: spendByTask(db, projectId),
  };
}

/** Spend per task, joined to the slug — the input to cost-per-point reporting. */
export function spendByTask(
  db: DatabaseSync,
  projectId: string,
): Array<SpendSummary & { task_id: number | null; slug: string | null }> {
  return db.prepare(`
    SELECT a.task_id, t.slug, ${SPEND_COLUMNS}
    FROM agent_runs a
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.project_id = ?
    GROUP BY a.task_id, t.slug
    ORDER BY total_cost_usd DESC
  `).all(projectId) as unknown as Array<SpendSummary & { task_id: number | null; slug: string | null }>;
}
