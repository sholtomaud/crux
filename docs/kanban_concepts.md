# Concepts worth taking from the agentic kanban board

Notes from evaluating `~/Development/kanban-canvas-board` (FastAPI + WebSockets
+ SQLite) against crux on 2026-08-09, and deciding what transfers.

The decisions that came out of this are recorded in
[ADR-010](adr/ADR-010-pluggable-llm-providers-and-per-run-cost-telemetry.md),
[ADR-011](adr/ADR-011-parallel-agents-as-worktree-isolated-child-processes.md)
and [ADR-012](adr/ADR-012-transition-guards-warn-by-default.md). This file is
the reasoning behind them and the sequencing, which doesn't belong in any of
them.

## The asymmetry

That board's own architecture doc splits agentic work into three phases:

1. Parallel agents with pluggable LLM providers
2. Cost / token / completion metrics
3. Agents that actually do the work

It built 1 and 2 and explicitly deferred 3 as "a different kind of project."
crux has 3 — `lib/agent.ts` is a real tool-call loop against a real repo,
`lib/workflow.ts` decomposes work into scoped steps, tests are real via
`test_cmd`/`run_env`, and `tasks.worktree_path` gives isolation. What crux
lacks is 1 and 2.

So this is not a port. crux does the expensive work blind; the board has the
instrumentation and none of the work.

## What crux already has, and what it implies

| Concept | crux today | Gap |
|---|---|---|
| Work execution | agent.ts tool loop, workflow.ts step engine | — |
| CI | Real `test_cmd`, `test_runs` table | — |
| Scheduling | CPM, float, WSJF (ADR-004) | — |
| Capital model | Documented, consumes `roi_records` | No producer — see below |
| Provider choice | One hardcoded endpoint (`DEFAULT_LLM`) | Registry, per-agent model |
| Worker identity | `executor` names a *kind*, not an instance | `agents` table |
| Transition rules | Bare `UPDATE`, CHECK constraint only | Guards |
| UI freshness | Fetch on load | SSE |

### The capital model has a consumer but no producer

The single largest finding. The README specifies `daily_cost`,
`capital_required`, `monthly_burn`, `runway_weeks`, RAG thresholds and an
algedonic `CRITICAL` below four weeks. Searching `lib/` for
`usage|input_tokens|cost_usd|total_tokens` returns nothing — every LLM call
discards the `usage` block sitting next to the content it keeps.

The board's `agent_runs` table is exactly the missing producer, and crux
improves on it in one way for free: the board logs a single action type
because it makes one LLM call per ticket, whereas workflow.ts already has
named steps, so crux gets per-step cost attribution without extra design.

### Guards have the best data and the least use

`lib/db/tasks.ts:61` is `UPDATE tasks SET status = ?`. Meanwhile crux
maintains a dependency DAG, computes float, and stores `test_runs` and
`coverage_target`. The board's `guard_ready` (predecessors done) and
`guard_tests` (CI green) are the two gates crux has the richest data for and
does not enforce — and crux's would run on real test results.

### Estimates are fine; actuals leak

Measured against the live DB, contradicting the initial assumption that
tickets are unestimated:

```
duration_days present   292/412 (71%)
value_score present     266/412 (65%)
actual_days present      87/412
done tasks, no actual    82
calibratable:  claude 52/52   ·   human 35/360
```

Coverage of *estimates* is adequate. The leak is **actuals** — 82 done tasks
closed without `actual_days`. Claude-estimated tasks calibrate perfectly
(52/52) because the MCP path records them; the human path does not. So the
requirement belongs on task *closure*, as a guard, not on refinement.

## Points and days: one scheduling unit, two entry points

Story points are worth adopting only if they never reach CPM. `estimate_points`
becomes what a human or refiner agent supplies; `duration_days` stays the
derived unit that CPM, float and `capital_required` consume. Points are an
input, not a parallel field — which is what keeps this compatible with ADR-004.

The conversion reuses machinery that already exists in
`lib/db/calibration.ts`:

```
calibration_factor  = AVG(actual_days / duration_days)     -- exists today
days_per_point      = AVG(actual_days / estimate_points)   -- same shape
```

The part that matters is that `days_per_point` should be a matrix keyed by
`(executor, task_type)` — both already columns. An LLM does five points of
`coding` in hours and five of `research` in days; a human is the inverse.
That table answers whether a given kind of work is worth delegating, and
story points alone can never answer it, because points are deliberately
velocity-free.

Hazard: until actuals accumulate, `days_per_point` is invented, and
`capital_required → runway_weeks → CRITICAL` consumes it. `estimated_by`
already has an `'auto'` value; points-derived durations must carry it, and
capital reporting must expose what fraction of the total rests on
auto-derived numbers.

## Roles

Refiner / engineer / reviewer, mapped onto stages:

| Role | Gate | Status |
|---|---|---|
| Refiner | backlog → ready | Missing. Produces estimates, `acceptance_criteria`, `files_affected` |
| Engineer | ready → review | Built (agent.ts, workflow.ts) |
| Reviewer | review → done | Missing. The board's readiness-judgment provider fits here |

The board lets a ticket's owning agent judge its own ticket. That is harmless
there because the agent never did the work — it only ever judged CI results.
In crux the engineer genuinely writes the code, so the same design would be
self-marking. Reviewer ≠ engineer is enforced in ADR-011 rather than left as
convention.

## Deliberately not taken

- **Simulated CI** (`_simulate_ci`, `TEST_PASS_PROBABILITY = 0.8`) — crux runs
  real tests. Proof-of-concept scaffolding, and a regression here.
- **Simulated cost in the mock provider** — populates a demo metrics page
  with invented dollars. Poison for a capital model; see ADR-010.
- **Seeded personas** (Aria/Rex/Nova) — the *count* of agents should be data
  (ADR-011), but fictional named workers are demo dressing.
- **asyncio TaskGroup / semaphores** — solves in-process concurrency; crux
  fans out as child processes instead.

## The animation

The card-flight animation is worth having — it makes an agent-driven move
legible, and a rejected move needs a visible bounce just as much.

Do not copy the mechanism. The board uses `drawElement`, the experimental
html-in-canvas API; its own console logs `Enable
chrome://flags/#canvas-draw-element or use Brave >= 1.89`, and everywhere
else it degrades to drawing a glowing rounded rectangle, so most viewers
never see the real card fly.

FLIP — measure First and Last rects, Invert with a transform, Play by
removing it — flies the actual card, in every browser, in roughly thirty
lines, with no canvas and no flag. Strictly better than the original, and it
fits ADR-005 without argument.

## Project page metrics

With `agent_runs` populated, the panel worth building is the delegation
question, not `$/token` (a per-model constant that tells you nothing):

- Cost to deliver, split human (`actual_days × daily_cost`) vs agent
  (`SUM(cost_usd)`) — the two halves the capital model names but cannot fill
- Cost per point by executor — the velocity matrix, rendered. The headline
- Revenue vs total cost per project, from existing `roi_records`
- Tokens per completed task over time — catches an agent getting less
  efficient as a codebase grows
- Share of `capital_required` that is `estimated_by='auto'` — the honesty gauge

## Sequencing

1. ~~**ADR-010** — provider registry + `agent_runs`.~~ **Built.** Every LLM call
   is logged with tokens, duration and cost; surfaced via `crux spend`,
   `crux_spend`, `/api/spend/:id` and a project-page panel.
2. ~~**Transactional guards**~~ **Built** — see
   [ADR-012](adr/ADR-012-transition-guards-warn-by-default.md). Warn by
   default, `BEGIN IMMEDIATE` + `busy_timeout` ready for fan-out.
3. **ADR-011** — `agents` table, supervisor, worktree child processes.
4. **Refiner and reviewer roles**, plus `estimate_points` and the velocity matrix.
5. **UI** — SSE live updates, FLIP animation, a detail panel that can author
   `acceptance_criteria` / `files_affected` / `files_to_create` (today those
   drive workflow.ts prompts but have no UI at all), and the metrics above.
