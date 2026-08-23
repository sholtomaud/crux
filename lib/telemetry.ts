/**
 * lib/telemetry.ts — time an LLM call and log it (ADR-010)
 *
 * The single seam every LLM call site goes through. Timing is measured here,
 * around the provider call, rather than self-reported by providers — so
 * wall-clock stays comparable across vendors regardless of internal retries or
 * streaming. Failures are logged as runs too: an error that burned tokens
 * still cost money, and an error that burned none is itself a useful signal.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { LlmRequest, LlmResponse, Provider } from './providers.ts';
import type { AgentRole, RunOutcome } from './db/types.ts';
import { recordAgentRun } from './db/agent-runs.ts';

export interface RunContext {
  project_id: string | null;
  task_id?:   number | null;
  agent_id?:  string | null;
  role:       AgentRole;
  /** workflow.ts step name; omit for free-form loops. */
  step?:      string | null;
  /** Overrides the derived outcome — lets a reviewer log 'hold' on a successful call. */
  outcome?:   RunOutcome;
  detail?:    string | null;
}

/**
 * Run one completion through `provider`, recording it to `agent_runs`.
 *
 * Telemetry never masks the call: a provider throw is logged then rethrown, and
 * a failure to log is swallowed rather than taking down the agent — losing a
 * metrics row is bad, losing in-flight work over a metrics row is worse.
 */
export async function tracked(
  db: DatabaseSync | null,
  provider: Provider,
  req: LlmRequest,
  ctx: RunContext,
): Promise<LlmResponse> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();

  const log = (
    resp: LlmResponse | null,
    outcome: RunOutcome,
    detail: string | null,
  ): void => {
    if (!db) return;
    const endedMs = Date.now();
    try {
      recordAgentRun(db, {
        project_id:    ctx.project_id,
        task_id:       ctx.task_id ?? null,
        agent_id:      ctx.agent_id ?? null,
        role:          ctx.role,
        step:          ctx.step ?? null,
        provider:      provider.name,
        model:         resp?.usage.model ?? provider.config.model,
        started_at:    startedAt,
        completed_at:  new Date(endedMs).toISOString(),
        duration_ms:   endedMs - startedMs,
        input_tokens:  resp?.usage.input_tokens  ?? null,
        output_tokens: resp?.usage.output_tokens ?? null,
        cost_usd:      resp?.usage.cost_usd      ?? null,
        outcome,
        detail:        detail ?? ctx.detail ?? null,
      });
    } catch { /* telemetry must not break the caller */ }
  };

  let resp: LlmResponse;
  try {
    resp = await provider.complete(req);
  } catch (err: unknown) {
    log(null, 'error', (err as Error).message.slice(0, 500));
    throw err;
  }

  log(resp, ctx.outcome ?? 'ok', null);
  return resp;
}
