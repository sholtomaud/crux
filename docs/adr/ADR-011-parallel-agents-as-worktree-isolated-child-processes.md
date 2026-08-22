# ADR-011: Parallel agents as worktree-isolated child processes

**Status:** proposed
**Date:** 2026-08-09

## Context

crux runs one agent at a time, implicitly. `lib/agent.ts` and
`lib/workflow.ts` drive a single task to completion in the foreground, and
there is no table describing who is working — the closest thing is
`tasks.executor` (`llm`/`human`/`hybrid`/`auto`), which names a *kind* of
worker, not an instance of one.

Tracking N concurrent workers means the number of agents becomes a property
of the data, not of the code. That is the tracker's job; crux is not itself
the agent.

Two pieces of the schema already anticipate this and are unused for it:
`tasks.worktree_path` gives each task an isolated checkout, and the DB opens
in WAL mode, which permits concurrent readers alongside a writer. What is
missing is a supervisor, an identity for each agent, and safety at the
points where a guard reads state and then writes it.

The proof-of-concept this borrows from solves concurrency with `asyncio`
inside one process, coordinated by a single in-process lock. That does not
transfer. `node:sqlite` is synchronous by design (AGENTS.md), and
`lib/agent.ts`/`lib/workflow.ts` shell out with `spawnSync` throughout;
making them async would be a rewrite of the one part of crux that already
works well.

Distinct agent roles are the reason to want this beyond raw throughput.
Refinement, engineering and review are different jobs deserving different
models — and review in particular must not be performed by the agent that
did the work, or the quality gate is self-marking.

## Decision

Fan out with child processes, not async. A supervisor selects ready tasks in
CPM/WSJF order, assigns each to a free agent, and spawns `crux agent --task
<slug>` per assignment, each in that task's own git worktree. The SEA binary
re-invokes itself via `process.execPath`, so this works identically for the
installed binary and for `node index.ts` in development.

Add an `agents` table — `id`, `name`, `role` (`refiner`/`engineer`/
`reviewer`), `provider`, `model`, `max_concurrent` — and
`tasks.assigned_agent_id`. Provider and model per agent is what ADR-010's
registry resolves against.

Guards become transactional. Any check that reads state and then writes it —
predecessors complete, WIP within limit, reviewer is not the engineer,
`actual_days` recorded before a task may close — runs inside a
`BEGIN IMMEDIATE` transaction, and every connection sets `busy_timeout`.

The reviewer constraint is enforced, not conventional: a task's reviewing
agent must differ from the agent recorded as its engineer in `agent_runs`.
When no other agent is eligible, review falls back to a human rather than
blocking — the task parks in `review` awaiting manual approval. Degrading to
the human is the safe direction; deadlocking a single-agent configuration is
not, and a self-review that silently satisfies the gate would be worse than
either.

## Consequences

Parallelism arrives without touching the agent loop, and filesystem
isolation is real rather than cooperative — two agents editing the same file
in different worktrees cannot corrupt each other, which an in-process design
could not have promised.

The correctness burden moves to the database. Single-process crux could read
then write safely by construction; that guarantee is now gone, and any guard
written in the old style is a live race rather than a latent one. SQLite WAL
admits exactly one writer, so a missing `busy_timeout` surfaces as
intermittent `SQLITE_BUSY` under load and nowhere else — the failure mode is
load-dependent and will not appear in single-agent testing. Writes are
millisecond-scale, so contention itself is not the concern; forgetting the
timeout is.

Observability gets worse before it gets better. Output from N processes
interleaves, so the `audit` table becomes the real execution trace rather
than a secondary record, and there is a strong case for streaming it to the
UI over SSE once this lands.

Crashed agents leave worktrees and `in-progress` rows behind. The supervisor
needs to reap on startup, which implies recording the child PID and start
time alongside the assignment.

Cost per unit of work becomes measurable per agent, and therefore per model,
via ADR-010's `agent_runs`. That is the point: `days_per_point` keyed by
`(executor, task_type)` is what answers whether delegating a given kind of
work is actually cheaper than doing it, and it cannot be computed until
several agents have worked comparable tasks.
