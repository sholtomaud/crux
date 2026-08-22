/**
 * test/unit/agent-runs.test.ts — ADR-010 telemetry
 *
 * The invariant under test throughout: crux records what it measured and
 * nothing else. Unknown cost stays NULL, aggregates expose their coverage, and
 * telemetry never changes what the caller sees.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  insertAgentRun, recordAgentRun, projectSpend, spendByRole, spendByStep, spendByTask,
  agentRunsByTask, roiSummary, spendReport,
} from '../../lib/db.ts';
import { computeCost, openAiCompatible } from '../../lib/providers.ts';
import type { LlmRequest, LlmResponse, Provider, ProviderConfig } from '../../lib/providers.ts';
import { tracked } from '../../lib/telemetry.ts';

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
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, 'p', 'code_repo');
  return id;
}

function seedTask(db: DatabaseSync, projectId: string, slug: string): number {
  db.prepare('INSERT INTO tasks (project_id, slug, title) VALUES (?, ?, ?)').run(projectId, slug, slug);
  return (db.prepare('SELECT id FROM tasks WHERE project_id = ? AND slug = ?')
    .get(projectId, slug) as { id: number }).id;
}

const NOW  = '2026-08-09T00:00:00.000Z';
const THEN = '2026-08-09T00:00:02.000Z';

function baseRun(projectId: string) {
  return {
    project_id: projectId,
    role: 'engineer' as const,
    provider: 'local',
    started_at: NOW,
    completed_at: THEN,
    outcome: 'ok' as const,
  };
}

// ── Cost ──────────────────────────────────────────────────────────────────────

describe('computeCost never invents a number', () => {
  const priced: ProviderConfig = {
    endpoint: 'x', model: 'm',
    pricing: { input_per_1m: 3, output_per_1m: 15 },
  };

  test('configured pricing is applied per million tokens', () => {
    // 1M in at $3 + 1M out at $15
    assert.equal(computeCost(1_000_000, 1_000_000, priced), 18);
  });

  test('partial usage still prices what is known', () => {
    assert.equal(computeCost(500_000, null, priced), 1.5);
  });

  test('priced provider with no usage at all yields null, not zero', () => {
    assert.equal(computeCost(null, null, priced), null);
  });

  test('local inference is zero even when tokens went uncounted', () => {
    assert.equal(computeCost(null, null, { endpoint: 'x', model: 'm', local: true }), 0);
    assert.equal(computeCost(100, 200, { endpoint: 'x', model: 'm', local: true }), 0);
  });

  test('unpriced remote provider yields null — the cost is real but unknown', () => {
    assert.equal(computeCost(100, 200, { endpoint: 'x', model: 'm' }), null);
  });
});

// ── Persistence and ROI mirroring ─────────────────────────────────────────────

describe('agent_runs persistence', () => {
  test('nullable usage round-trips as NULL rather than 0', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const tid = seedTask(db, pid, 'a');
    insertAgentRun(db, { ...baseRun(pid), task_id: tid });

    const [row] = agentRunsByTask(db, tid);
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, null);
    assert.equal(row.cost_usd, null);
    assert.equal(row.role, 'engineer');
  });

  test('paid runs mirror into roi_records so runway sees them', () => {
    const db = makeDb();
    const pid = seedProject(db);
    recordAgentRun(db, { ...baseRun(pid), provider: 'anthropic', cost_usd: 0.25, step: 'write-impl' });

    assert.equal(roiSummary(db, pid).cost, 0.25);
    const note = (db.prepare('SELECT note, currency FROM roi_records').get() as { note: string; currency: string });
    assert.match(note.note, /^agent_run:\d+ engineer\/write-impl anthropic$/);
    assert.equal(note.currency, 'USD');
  });

  test('zero-cost local inference is logged but is not a cash outflow', () => {
    const db = makeDb();
    const pid = seedProject(db);
    recordAgentRun(db, { ...baseRun(pid), cost_usd: 0 });

    assert.equal(projectSpend(db, pid).runs, 1);
    assert.equal(roiSummary(db, pid).cost, 0);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM roi_records').get() as { c: number }).c, 0);
  });

  test('unknown cost does not mirror — a NULL is not a free run', () => {
    const db = makeDb();
    const pid = seedProject(db);
    recordAgentRun(db, { ...baseRun(pid), provider: 'openai' });
    assert.equal((db.prepare('SELECT COUNT(*) c FROM roi_records').get() as { c: number }).c, 0);
  });

  test('spend survives deletion of the task it was spent on', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const tid = seedTask(db, pid, 'doomed');
    recordAgentRun(db, { ...baseRun(pid), task_id: tid, cost_usd: 1 });

    db.exec('PRAGMA foreign_keys = ON;');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(tid);

    const spend = projectSpend(db, pid);
    assert.equal(spend.runs, 1);
    assert.equal(spend.total_cost_usd, 1);
    assert.equal((db.prepare('SELECT task_id FROM agent_runs').get() as { task_id: null }).task_id, null);
  });
});

// ── Coverage-aware aggregates ─────────────────────────────────────────────────

describe('aggregates report coverage, not just totals', () => {
  test('runs_with_cost exposes that a total understates real spend', () => {
    const db = makeDb();
    const pid = seedProject(db);
    recordAgentRun(db, { ...baseRun(pid), cost_usd: 2, input_tokens: 100, output_tokens: 50 });
    recordAgentRun(db, { ...baseRun(pid), provider: 'openai' }); // unpriced: cost unknown
    recordAgentRun(db, { ...baseRun(pid), provider: 'openai', input_tokens: 10 });

    const spend = projectSpend(db, pid);
    assert.equal(spend.runs, 3);
    assert.equal(spend.runs_with_cost, 1);
    assert.equal(spend.runs_with_usage, 2);
    assert.equal(spend.total_cost_usd, 2);
    assert.equal(spend.input_tokens, 110);
  });

  test('errors are counted, since a failed call can still have burned tokens', () => {
    const db = makeDb();
    const pid = seedProject(db);
    recordAgentRun(db, { ...baseRun(pid), outcome: 'error', cost_usd: 0.5 });
    const spend = projectSpend(db, pid);
    assert.equal(spend.errors, 1);
    assert.equal(spend.total_cost_usd, 0.5);
  });

  test('grouping by role, step and task splits the same total', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const tid = seedTask(db, pid, 'a');
    recordAgentRun(db, { ...baseRun(pid), task_id: tid, role: 'refiner',  step: 'estimate',   cost_usd: 1 });
    recordAgentRun(db, { ...baseRun(pid), task_id: tid, role: 'engineer', step: 'write-impl', cost_usd: 4 });
    recordAgentRun(db, { ...baseRun(pid), task_id: tid, role: 'engineer', step: 'write-impl', cost_usd: 2 });

    const byRole = spendByRole(db, pid);
    assert.deepEqual(byRole.map(r => [r.role, r.total_cost_usd]), [['engineer', 6], ['refiner', 1]]);

    const byStep = spendByStep(db, pid);
    assert.deepEqual(byStep.map(r => [r.step, r.runs]), [['write-impl', 2], ['estimate', 1]]);

    const byTask = spendByTask(db, pid);
    assert.equal(byTask.length, 1);
    assert.equal(byTask[0].slug, 'a');
    assert.equal(byTask[0].total_cost_usd, 7);
  });

  test('a project with no runs reports zeros, not nulls', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const spend = projectSpend(db, pid);
    assert.equal(spend.runs, 0);
    assert.equal(spend.total_cost_usd, 0);
    assert.equal(spend.input_tokens, 0);
  });
});

// ── spendReport — the one computation CLI, MCP and UI all read ───────────────

describe('spendReport', () => {
  function seedTaskWithDuration(db: DatabaseSync, pid: string, slug: string, days: number | null): number {
    db.prepare('INSERT INTO tasks (project_id, slug, title, duration_days) VALUES (?, ?, ?, ?)')
      .run(pid, slug, slug, days);
    return (db.prepare('SELECT id FROM tasks WHERE project_id = ? AND slug = ?')
      .get(pid, slug) as { id: number }).id;
  }

  test('cost_coverage is 1 when every run was priced', () => {
    const db = makeDb();
    const pid = seedProject(db);
    recordAgentRun(db, { ...baseRun(pid), cost_usd: 1 });
    recordAgentRun(db, { ...baseRun(pid), cost_usd: 2 });
    assert.equal(spendReport(db, pid).cost_coverage, 1);
  });

  test('cost_coverage drops below 1 as soon as one run is unpriced', () => {
    const db = makeDb();
    const pid = seedProject(db);
    recordAgentRun(db, { ...baseRun(pid), cost_usd: 1 });
    recordAgentRun(db, { ...baseRun(pid), provider: 'openai' });
    assert.equal(spendReport(db, pid).cost_coverage, 0.5);
  });

  test('cost per estimated day divides only by tasks that actually had spend', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const paid   = seedTaskWithDuration(db, pid, 'paid', 2);
    seedTaskWithDuration(db, pid, 'untouched', 98); // no runs — must not dilute
    recordAgentRun(db, { ...baseRun(pid), task_id: paid, cost_usd: 10 });

    assert.equal(spendReport(db, pid).cost_per_duration_day, 5);
  });

  test('tasks with spend but no estimate leave the per-day rate null', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const t = seedTaskWithDuration(db, pid, 'unestimated', null);
    recordAgentRun(db, { ...baseRun(pid), task_id: t, cost_usd: 10 });
    assert.equal(spendReport(db, pid).cost_per_duration_day, null);
  });

  test('an untouched project reports nulls rather than dividing by zero', () => {
    const db = makeDb();
    const pid = seedProject(db);
    const r = spendReport(db, pid);
    assert.equal(r.total.runs, 0);
    assert.equal(r.cost_coverage, null);
    assert.equal(r.cost_per_duration_day, null);
    assert.deepEqual(r.by_role, []);
  });

  test('spend is scoped to its own project', () => {
    const db = makeDb();
    const a = seedProject(db);
    const b = seedProject(db);
    recordAgentRun(db, { ...baseRun(a), cost_usd: 5 });
    assert.equal(spendReport(db, a).total.total_cost_usd, 5);
    assert.equal(spendReport(db, b).total.runs, 0);
  });
});

// ── The tracked() seam ────────────────────────────────────────────────────────

function fakeProvider(
  impl: (req: LlmRequest) => Promise<LlmResponse>,
  cfg: Partial<ProviderConfig> = {},
): Provider {
  return {
    name: 'fake',
    config: { endpoint: 'x', model: 'configured-model', ...cfg },
    complete: impl,
  };
}

const okResponse: LlmResponse = {
  message: { role: 'assistant', content: 'hi' },
  finish_reason: 'stop',
  usage: { input_tokens: 12, output_tokens: 3, cost_usd: 0.001, model: 'served-model' },
};

describe('tracked()', () => {
  test('logs the served model and measured duration', async () => {
    const db = makeDb();
    const pid = seedProject(db);
    const resp = await tracked(db, fakeProvider(async () => okResponse),
      { messages: [] }, { project_id: pid, role: 'ask' });

    assert.equal(resp.message?.content, 'hi');
    const row = db.prepare('SELECT * FROM agent_runs').get() as {
      model: string; outcome: string; duration_ms: number; input_tokens: number; role: string;
    };
    assert.equal(row.model, 'served-model'); // not the configured name
    assert.equal(row.outcome, 'ok');
    assert.equal(row.role, 'ask');
    assert.equal(row.input_tokens, 12);
    assert.ok(row.duration_ms >= 0);
  });

  test('a provider throw is logged as an error run and rethrown', async () => {
    const db = makeDb();
    const pid = seedProject(db);
    const boom = fakeProvider(async () => { throw new Error('connection refused'); });

    await assert.rejects(
      () => tracked(db, boom, { messages: [] }, { project_id: pid, role: 'engineer' }),
      /connection refused/,
    );

    const row = db.prepare('SELECT * FROM agent_runs').get() as {
      outcome: string; detail: string; model: string; cost_usd: null;
    };
    assert.equal(row.outcome, 'error');
    assert.match(row.detail, /connection refused/);
    assert.equal(row.model, 'configured-model'); // no response to read a served model from
    assert.equal(row.cost_usd, null);
  });

  test('caller-supplied outcome wins, so a reviewer can log a hold', async () => {
    const db = makeDb();
    const pid = seedProject(db);
    await tracked(db, fakeProvider(async () => okResponse), { messages: [] },
      { project_id: pid, role: 'reviewer', outcome: 'hold', detail: 'no acceptance criteria' });

    const row = db.prepare('SELECT outcome, detail FROM agent_runs').get() as { outcome: string; detail: string };
    assert.equal(row.outcome, 'hold');
    assert.equal(row.detail, 'no acceptance criteria');
  });

  test('a broken telemetry sink does not take down the caller', async () => {
    const db = makeDb();
    const pid = seedProject(db);
    db.exec('DROP TABLE agent_runs;');

    const resp = await tracked(db, fakeProvider(async () => okResponse),
      { messages: [] }, { project_id: pid, role: 'ask' });
    assert.equal(resp.message?.content, 'hi'); // work is worth more than a metrics row
  });

  test('a null db skips logging entirely', async () => {
    const resp = await tracked(null, fakeProvider(async () => okResponse),
      { messages: [] }, { project_id: null, role: 'ask' });
    assert.equal(resp.message?.content, 'hi');
  });
});

// ── OpenAI-compatible wire parsing ────────────────────────────────────────────

describe('openAiCompatible usage extraction', () => {
  const realFetch = globalThis.fetch;

  function stubFetch(payload: unknown, ok = true, status = 200) {
    globalThis.fetch = (async () => ({
      ok, status,
      json:  async () => payload,
      text:  async () => JSON.stringify(payload),
    })) as unknown as typeof fetch;
  }

  test('reads prompt/completion tokens and the served model name', async () => {
    stubFetch({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage:   { prompt_tokens: 40, completion_tokens: 8 },
      model:   'qwen3.5-35b',
    });
    try {
      const p = openAiCompatible('local', { endpoint: 'http://x', model: 'placeholder', local: true });
      const r = await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.usage.input_tokens, 40);
      assert.equal(r.usage.output_tokens, 8);
      assert.equal(r.usage.model, 'qwen3.5-35b');
      assert.equal(r.usage.cost_usd, 0); // local
      assert.equal(r.finish_reason, 'stop');
    } finally { globalThis.fetch = realFetch; }
  });

  test('a server that omits usage yields nulls, not zeros', async () => {
    stubFetch({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    try {
      const p = openAiCompatible('remote', { endpoint: 'http://x', model: 'm' });
      const r = await p.complete({ messages: [] });
      assert.equal(r.usage.input_tokens, null);
      assert.equal(r.usage.output_tokens, null);
      assert.equal(r.usage.cost_usd, null);
    } finally { globalThis.fetch = realFetch; }
  });

  test('non-numeric token fields are rejected rather than coerced', async () => {
    stubFetch({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage:   { prompt_tokens: null, completion_tokens: 'many' },
    });
    try {
      const p = openAiCompatible('remote', { endpoint: 'http://x', model: 'm' });
      const r = await p.complete({ messages: [] });
      assert.equal(r.usage.input_tokens, null);
      assert.equal(r.usage.output_tokens, null);
    } finally { globalThis.fetch = realFetch; }
  });

  test('pricing turns reported tokens into dollars', async () => {
    stubFetch({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage:   { prompt_tokens: 1_000_000, completion_tokens: 100_000 },
    });
    try {
      const p = openAiCompatible('anthropic', {
        endpoint: 'http://x', model: 'm',
        pricing: { input_per_1m: 3, output_per_1m: 15 },
      });
      const r = await p.complete({ messages: [] });
      assert.equal(r.usage.cost_usd, 4.5); // 3 + 1.5
    } finally { globalThis.fetch = realFetch; }
  });

  test('an HTTP error names the provider', async () => {
    stubFetch({ error: 'nope' }, false, 500);
    try {
      const p = openAiCompatible('local', { endpoint: 'http://x', model: 'm' });
      await assert.rejects(() => p.complete({ messages: [] }), /Provider 'local' returned HTTP 500/);
    } finally { globalThis.fetch = realFetch; }
  });
});
