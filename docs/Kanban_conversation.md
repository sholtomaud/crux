The asymmetry
These two projects are almost complementary. The kanban board's own architecture doc splits agentic work into three phases: (1) parallel agents with pluggable LLM providers, (2) cost/token/completion metrics, (3) agents that actually do the work. It built 1 and 2, and explicitly deferred 3 as "a different kind of project."

crux has already built phase 3 — lib/agent.ts is a real tool-call loop with read/write/run_command against a real repo, lib/workflow.ts is a deterministic step engine with scoped per-step context, and there's real CI via test_cmd/run_env plus git worktree isolation. What crux is missing is phases 1 and 2 — the parts kanban finished.

So this isn't "port a kanban board." It's "crux does the expensive work blind, and kanban has the instrumentation."

Ranked by value
1. The agent_runs table — crux has the consumer but not the producer
This is the standout. crux's README documents an entire Capital Model: daily_cost, capital_required, monthly_burn, runway_weeks, RAG thresholds, an algedonic CRITICAL warning below 4 weeks. It has roi_records(kind='cost') to feed it.

But grepping usage|input_tokens|cost_usd|total_tokens across all of lib/ returns nothing. Every LLM call in agent.ts, workflow.ts and ask.ts discards the response's usage block. "cost_of_claude — logged as roi_records" is manual data entry. The capital model is running on numbers a human types in.

kanban's agent_runs (one row per invocation: provider, model, action, started/completed, input/output tokens, cost_usd, outcome, reason) is precisely the missing producer. Two adaptations make it better in crux than in kanban:

kanban logs one action type (review_readiness) because that's its only LLM call. workflow.ts already decomposes work into discrete named steps, so crux gets per-step cost attribution for free — which step of which task type burns the budget.
kanban normalises cost by estimate_points. crux already has duration_days and value_score, so cost-per-duration-day and cost-per-value-point both fall out without inventing a new estimation unit.
And the loop closes: an agent_runs row can auto-emit an roi_records cost entry, making runway_weeks reflect actual spend instead of recollection.

One caution — kanban's MockProvider reports simulated cost so its demo metrics aren't empty. Do not copy that into crux. A capital model that silently ingests invented dollars is worse than one with gaps.

2. Provider abstraction with usage as part of the contract
lib/ask.ts hardcodes a single OpenAI-compatible endpoint via DEFAULT_LLM. kanban's ReasoningProvider registry with a per-agent provider/model column is the pattern — but the design point worth copying isn't the class hierarchy, it's that ReasoningResult bundles decision + usage so every provider is forced to report comparable telemetry. That's what makes #1 work across vendors.

For crux the routing axis isn't agent personas, it's ADR-003's three tiers. The executor column (llm/human/hybrid/auto) already exists on tasks; adding provider/model alongside it makes tier selection data rather than global config, and lets a cheap local model handle scaffolding steps while Claude handles the hard ones — with the cost difference visible.

3. Transition guards — crux has the richest data and doesn't use it
lib/db/tasks.ts:61-68 is a bare UPDATE tasks SET status = ?. The only protection is a CHECK constraint on the enum. Any task can jump to any status from anywhere.

Meanwhile crux maintains a full dependency DAG, computes CPM float, and stores test_runs and coverage_target. kanban's guard_ready (predecessors complete) and guard_tests (CI green before Review) are exactly the two gates crux has the best data for and doesn't enforce — and crux's version would be gated on real test runs, not kanban's simulated CI.

Worth being precise about what doesn't transfer: kanban's apply_transition returns a bool and re-checks WIP inside the lock to close a TOCTOU race introduced by concurrent async reasoning. crux is synchronous node:sqlite in a single process and has no such race. What crux does need from that design is the guard-returns-a-reason plumbing, so CLI, MCP and UI all surface the same rejection message rather than each inventing one.

4. Live updates via SSE
kanban pushes over WebSocket. crux's UI fetches once on load — the only recurring timer is the session clock at ui/project.html:277.

The multi-client argument is weak for a single-user tool, but there's a stronger one: crux agent mutates the DB from the CLI while the browser sits open showing stale state. Streaming the audit table over SSE would make agent runs visible live. SSE rather than WebSocket — one-way, native, no dependency, fits the plain-Node server and ADR-005's no-framework constraint.

5. A card detail panel that can author agent inputs
ui/project.html renders board columns, but status changes go through a <select> and the detail panel only shows dependency chips. Meanwhile acceptance_criteria, files_affected and files_to_create — the fields workflow.ts feeds directly into its prompts — have no UI at all. They're CLI/MCP-only.

kanban's ▸ detail panel (description / requirements / acceptance criteria / tests / estimate) is the model. This matters more than drag-and-drop: it's the difference between the UI being a dashboard and being able to actually prepare work for an agent. Drag-and-drop is the natural pairing once guards exist, since a rejected drop is what makes the state machine visible.

Related: the agent panel at ui/app.js:113 still says "coming in a later phase." kanban's per-ticket reasoning line — the agent's stated verdict and why, rendered on the card — is a cheaper and more useful first fill than a chat box.

Worth skipping
Simulated CI (_simulate_ci, TEST_PASS_PROBABILITY = 0.8) — crux runs real tests. This would be a regression.
Seeded agent personas (Aria/Rex/Nova) and per-agent avatars — crux is single-operator; the meaningful "who" is executor + routing tier.
asyncio TaskGroup / semaphore machinery — solves a problem crux's sync single-process model doesn't have.
estimate_points — ADR-004 committed to duration_days + WSJF. Adding story points would create two competing estimation units and break the calibration factor.
Recommendation
Do #1 and #2 together, as kanban itself concluded — the provider contract is what makes the telemetry comparable, and neither is worth much alone. That's a schema addition, a small registry, and threading a usage return through agent.ts/workflow.ts/ask.ts. It converts crux's documented-but-unfed capital model into a real one, which is the largest gap between what the README claims and what the code does.

#3 is a separate, self-contained change and the natural follow-up. #4 and #5 are UI work that gets much more compelling once #3 gives the board real semantics.

Want me to draft an ADR for the provider + agent_runs design, or go straight to implementing it?