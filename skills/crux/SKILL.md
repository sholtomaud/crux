---
name: crux
description: Project management with CPM, ROI tracking, and three-tier routing. Route by complexity before acting.
---

# crux skill

## ROUTING RULES — apply before every response

### TIER 1 — CLI (free, instant, no AI)
For: status, reports, task updates, sync, session tracking, graph, ROI records.
Action: `Bash: crux <command>`

### TIER 2 — Local LLM (free, local)
For: "what next", "summarise", "is X worth it", "what's blocking"
Action: `Bash: crux ask "<question>"` — relay the response verbatim.

### TIER 3 — Claude (paid, cloud)
For: strategy across projects, architecture decisions, ambiguous priorities under constraints.
Action: run `crux overview` and `crux cpm` first to load current state, then reason.

## Available MCP Tools
crux_init, crux_status, crux_overview, crux_cpm, crux_task_add, crux_task_update,
crux_dep_add, crux_sync, crux_report, crux_ready, crux_graph, crux_test_run,
crux_milestone_check, crux_session_start, crux_session_end, crux_roi_record,
crux_roi_report, crux_spread_check, crux_project_add, crux_project_link, crux_ask
