# ADR-012: Transition guards, warning by default

**Status:** accepted
**Date:** 2026-08-09

## Context

`updateTaskStatus` was a bare `UPDATE tasks SET status = ?` behind a CHECK
constraint on the enum. Any task could move to any status from anywhere, while
crux maintained a dependency DAG, CPM float, `test_runs` and `actual_days` and
consulted none of it at transition time.

Two consequences were already visible in the data. 82 done tasks carry no
`actual_days`, so the calibration factor — the mechanism that is supposed to
correct crux's own estimates — sees 52/52 Claude-estimated tasks and only
35/360 human-estimated ones. And nothing prevented closing a task whose
predecessors were still open, which quietly corrupts every CPM number
downstream.

Guards are also a prerequisite for ADR-011: once agents fan out across
processes, a check-then-write is a race, and the fix has to be a write
transaction rather than an in-process lock.

## Decision

Guards are pure functions of `(db, task, target status)` in `lib/guards.ts`.
They report; they do not decide. `applyTaskStatus` in `lib/task-transition.ts`
evaluates them inside `BEGIN IMMEDIATE` and applies policy.

Three guards: `predecessors-incomplete`, `tests-not-green`, `actuals-missing`.

Policy is a `guard_policy` row in `global_config`, and **defaults to `warn`** —
the transition happens, the objection is reported to the caller and written to
`audit` as `task.guard-warning`. `enforce` refuses; `off` skips evaluation.
Introducing the checks therefore cannot break a workflow that worked yesterday,
and the ladder from warn to enforce is a config change rather than a code
change.

`applyTaskStatus` is for a status *asserted* by a human or agent — CLI, MCP,
web UI, the agent's own `crux_task_update` tool. `updateTaskStatus` stays a
bare UPDATE for machinery that has already earned the transition, such as
workflow.ts closing a task after real tests passed.

**Every guard must be satisfiable by the caller.** Two findings forced this.
`crux task done` had no way to record actuals, so `--actual-days` was added
rather than warning about something the CLI could not supply. And an earlier
`tests-never-run` check warned when no test run existed for a task: measured
against the live DB it fired on 136 of 216 open tasks, because only 3
`test_runs` rows exist across 14 projects. That measures whether `crux
test-run` is in the operator's habits, not whether the code works — tests
actually run via `make test` and CI without touching the table. It was dropped.
`tests-not-green` objects only to a recorded red run, which is unambiguous.

## Consequences

Measured against the live DB, closing any open task now warns on 27% of cases,
all `predecessors-incomplete` — real DAG debt where the answer is either to
finish the predecessor or drop the dependency. Supplying `--actual-days`, which
is the point of the flag, is what takes it from 80% to 27%.

That number is the thing to watch. Guards earn their place by being rare and
right; if a future guard pushes the warning rate back toward the majority of
transitions, it is measuring bookkeeping rather than correctness and belongs
out, on the evidence above.

Warned-through transitions are auditable rather than living in a terminal that
has scrolled away, which is what makes an eventual move to `enforce` a decision
based on evidence.

`BEGIN IMMEDIATE` is currently redundant — crux is single-process and a
check-then-write cannot interleave. It is here so ADR-011's fan-out does not
have to retrofit every call site, and so the guard path is correct under
concurrency from the first parallel agent rather than the first bug report.
Callers must now handle a `false` return, which is a wider blast radius than a
`void` update: CLI exits non-zero, MCP returns an error, the HTTP layer returns
409.
