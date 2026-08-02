---
name: crux
description: Project management with CPM, ROI tracking, and three-tier routing. Route by complexity before acting.
---

# crux skill

Two front ends, one binary and one database: the `mcp__crux__*` tools and the
`crux` CLI in Bash both run `/Users/sholtomaud/bin/crux`. Prefer MCP for writes
(it is the only path to `crux_adr_add`, and it resolves the active project
without needing `.crux/project.json` in the cwd). Prefer the CLI for reads you
want to filter — `crux cpm | head -30` is not expressible as an MCP call.

Transport does not change cost: a given command's output costs the same either
way. What costs is *which* command you run, and how often — see below.

## ROUTING RULES — apply before every response

### TIER 1 — CLI (free, instant, no AI)
For: status, reports, task updates, sync, session tracking, graph, ROI records.
Action: `Bash: crux <command>`

### TIER 2 — Local LLM (free, local)
For: "what next", "summarise", "is X worth it", "what's blocking"
Action: `Bash: crux ask "<question>"` — relay the response verbatim.

### TIER 3 — Claude (paid, cloud)
For: strategy across projects, architecture decisions, ambiguous priorities.
Load state **lazily** — fetch only what the question needs, never speculatively.

## CONTEXT COST — read before fetching state

Command output stays in context for the rest of the session and is re-read on
every subsequent turn. Fetch the cheapest command that answers the question:

| command | cost | use when |
|---|---|---|
| `crux ready` / `crux spread` / `crux report` | ~100 tok | default — try these first |
| `crux graph` | ~400 tok | dependency shape only |
| `crux status` | ~800 tok | current project's tasks and blockers |
| `crux overview` | ~1.9k tok | genuinely cross-project questions |
| `crux cpm` | ~2.8k tok | only when the question is about scheduling |
| `crux context` | ~5.4k tok | avoid — `crux status` covers almost every case |

Filter output rather than absorbing it whole: `crux cpm | head -30`.
Do not re-fetch state you already pulled this session.

## ADRs

- List: `sqlite3 -readonly ~/.crux/crux.db "SELECT number,status,title FROM adrs;"`
- Add: no CLI path exists. Tell the user rather than writing to the db directly.
