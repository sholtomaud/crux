# ADR-010: Pluggable LLM providers and per-run cost telemetry

**Status:** accepted
**Date:** 2026-08-09

## Context

crux's README documents a capital model in detail: `daily_cost`,
`capital_required`, `monthly_burn`, `runway_weeks`, RAG thresholds, and an
algedonic `CRITICAL` signal that bypasses task priority when runway drops
below four weeks. It consumes `roi_records` rows with `kind='cost'`.

Nothing produces those rows automatically. Grepping
`usage|input_tokens|cost_usd|total_tokens` across `lib/` returns no matches:
`lib/agent.ts`, `lib/workflow.ts` and `lib/ask.ts` all read `choices` off the
OpenAI-compatible response and discard the `usage` block beside it. The
README's "cost_of_claude — logged as roi_records" is manual data entry. The
capital model — the feature crux is arguably built around — runs on numbers
a human remembers to type in.

The second gap is provider selection. `lib/ask.ts` hardcodes a single
endpoint in `DEFAULT_LLM`, overridable only globally via
`~/.crux/config.json`. ADR-003 defines three routing tiers, but the tier is
chosen by a human reading a skill file, not carried as data on the work.
Once distinct agent roles exist (refiner, engineer, reviewer — see ADR-011),
each wants a different model, and there is nowhere to say so.

These are one decision because they are mutually load-bearing. Telemetry
without a provider abstraction measures one endpoint. A provider abstraction
without mandatory usage reporting produces figures that cannot be compared
across vendors, which is the only reason to collect them.

## Decision

Introduce a provider registry keyed by name. A provider takes a request and
returns a result whose type pairs the model's output with a usage record
(`input_tokens`, `output_tokens`, `cost_usd`, plus the `model` actually
served). Usage is part of the return type, not an optional side channel —
a provider that cannot report it returns nulls explicitly rather than
omitting the field.

Log every invocation to a new `agent_runs` table: `project_id`, `task_id`,
`agent_id`, `role`, `step`, `provider`, `model`, `started_at`,
`completed_at`, token counts, `cost_usd`, `outcome`, `detail`. Timing is
measured by the caller around the provider call, never self-reported, so
wall-clock stays comparable across providers regardless of internal retries.
Because `lib/workflow.ts` already decomposes work into named steps, `step`
gives per-step cost attribution without further work.

Cost rows flow onward: an `agent_runs` insert with a non-null `cost_usd`
emits a corresponding `roi_records` row with `kind='cost'`, so `runway_weeks`
reflects measured spend.

**crux never fabricates cost.** The kanban proof-of-concept this borrows from
has its mock provider report plausible simulated tokens and dollars so its
metrics page looks populated with no vendor wired up. That is correct for a
demo and unacceptable here: a capital model that silently ingests invented
dollars is worse than one with visible gaps. Providers that do not return
usage record NULL, and any aggregate must report its coverage — how many runs
carried usage — alongside the total.

## Consequences

The capital model becomes fed by measurement rather than recollection, and
cost per task, per workflow step, per `task_type` and per `executor` all
become queryable from one table.

The cost is that every LLM call site must thread usage back. `lib/agent.ts`
runs a multi-turn tool loop, so a single task produces many rows, not one —
`agent_runs` will be the fastest-growing table in the schema and wants an
index on `(project_id, task_id)` from the start.

Local models are covered: llama-server, Ollama and LM Studio all return an
OpenAI-shaped `usage` block, so tier 2 reports real tokens. They report no
price, so `cost_usd` for local inference is zero by definition — correct, but
it means cost comparisons between tiers measure marginal spend and silently
omit the electricity and hardware behind tier 2. Time per point (ADR-011) is
the honest counterweight and should be read alongside it.

Aggregates must resist averaging over absent data. The obvious reporting bug
is a mean that quietly divides by the rows that happened to have usage; the
coverage figure exists to make that visible rather than to be optional.
