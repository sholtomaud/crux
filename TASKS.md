# crux — Tasks
<!-- GENERATED: false — this file is the bootstrap seed, manually maintained until crux_init is available -->

## Phase 0: Project Bootstrap

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p0-pkg | Initialise package.json with bin entry | done | — |
| p0-manifest | Write manifest.json (MCPB spec v0.3) | done | p0-pkg |
| p0-makefile | Update Makefile: add port 8765 for crux ui | done | — |
| p0-gitignore | Write .gitignore (.crux/, node_modules/, *.mcpb) | done | — |
| p0-deps | Install @modelcontextprotocol/sdk | done | p0-pkg |

## Phase 1: Database Layer

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p1-schema | Write schema.sql (all tables) | done | p0-pkg |
| p1-db | Write lib/db.ts (open, migrate, CRUD, queries) | done | p1-schema |
| p1-db-test | Write test/unit/db.test.ts | done | p1-db |

## Phase 2: CPM Algorithm

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p2-cpm | Write lib/cpm.ts (topo sort, forward pass, backward pass, float, cycle detection) | done | p1-db |
| p2-cpm-test | Write test/unit/cpm.test.ts | done | p2-cpm |

## Phase 3: Reports

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p3-reports | Write lib/reports.ts (tasks.md, status.md, ADR generators) | done | p1-db, p2-cpm |
| p3-reports-test | Write test/unit/reports.test.ts | done | p3-reports |

## Phase 4: CLI Entry Point

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p4-index | Write index.ts (dual-mode detection, argv parsing, command routing) | done | p1-db, p2-cpm, p3-reports |
| p4-cli-smoke | Smoke test: crux --help, crux status, crux overview | done | p4-index |

## Phase 5: MCP Server

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p5-mcp | Add MCP stdio server mode to index.ts (all crux_* tools) | done | p4-index, p0-deps |
| p5-mcp-smoke | Smoke test: MCP server starts, tools list correctly (21 tools) | done | p5-mcp |

## Phase 6: GitHub Integration

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p6-gh | Write lib/gh.ts (issue create/update/close, project board, milestone) | done | p1-db |
| p6-gh-int | Write test/integration/sync.test.ts (against sholtomaud/crux-test) | open | p6-gh |

## Phase 7: Browser UI

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p7-server | Write lib/server.ts (node:http, static serving, JSON API routes) | done | p1-db, p2-cpm |
| p7-ui-kanban | Write ui/index.html + ui/app.js (meta Kanban) | done | p7-server |
| p7-ui-project | Write ui/project.html (project detail: tasks, CPM, burndown) | done | p7-server |
| p7-ui-roi | Write ui/roi.html (ROI dashboard + spread indicator) | done | p7-server |
| p7-ui-graph | Write ui/graph.html (dependency DAG, SVG) | done | p7-server |
| p7-ui-db | Write ui/db.html (raw table explorer) | done | p7-server |
| p7-ui-smoke | Smoke test: crux ui starts, all pages load without error | open | p7-ui-kanban, p7-ui-project, p7-ui-roi, p7-ui-graph, p7-ui-db |

## Phase 8: Local LLM Integration

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p8-ask | Write lib/ask.ts (fetch to OpenAI-compatible endpoint with DB context) | done | p1-db |
| p8-ask-smoke | Smoke test: crux ask "hello" against llama-server | open | p8-ask, p4-index |

## Phase 9: Google Sheets Sync

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p9-sheets | Write lib/sheets.ts (OAuth2 + Sheets REST API via native fetch) | done | p1-db |
| p9-sheets-smoke | Smoke test: crux sync --target sheets pushes snapshot | open | p9-sheets, p4-index |

## Phase 10: Skill & Auto-Install

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p10-skill | Write skills/crux/SKILL.md (three-tier routing logic) | done | p5-mcp |
| p10-skill-install | Implement skill auto-install prompt in crux_init | done | p10-skill |

## Phase 11: Integration Tests

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p11-int-sync | Write test/integration/sync.test.ts | open | p6-gh |
| p11-int-milestone | Write test/integration/milestone.test.ts | open | p6-gh |
| p11-int-coverage | Write test/integration/coverage.test.ts | open | p5-mcp, p6-gh |

## Phase 12: Pack & Validate

| Slug | Title | Status | Depends On |
|---|---|---|---|
| p12-validate | mcpb validate manifest.json passes clean | done | p5-mcp, p0-manifest |
| p12-pack | mcpb pack → crux.mcpb (3.4MB, 2459 files) | done | p12-validate |
| p12-install-smoke | Install crux.mcpb in Claude Code, confirm tools appear | open | p12-pack |

---

## Critical Path (manual estimate)

```
p0-pkg → p0-deps → p1-schema → p1-db → p2-cpm → p3-reports → p4-index → p5-mcp → p12-validate → p12-pack → p12-install-smoke
```

## Summary

| Phase | Tasks | Status |
|---|---|---|
| 0 — Bootstrap | 5 | 5 done |
| 1 — Database | 3 | 3 done |
| 2 — CPM | 2 | 2 done |
| 3 — Reports | 2 | 2 done |
| 4 — CLI | 2 | 2 done |
| 5 — MCP Server | 2 | 2 done |
| 6 — GitHub | 2 | 1 done |
| 7 — Browser UI | 7 | 6 done |
| 8 — Local LLM | 2 | 1 done |
| 9 — Sheets | 2 | 1 done |
| 10 — Skill | 2 | 2 done |
| 11 — Integration Tests | 3 | 0 done |
| 12 — Pack | 3 | 2 done |
| **Total** | **39** | **29 done** |
