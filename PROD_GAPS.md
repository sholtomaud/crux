# crux — Production Readiness Gap Analysis

_Generated 2026-04-19. Review and amend before signing off._

---

## 1. What "Production" Means for crux

**Target user:** Solo developer or small team (2–4 people), self-hosted, local-first.

**Production definition:**
- Installable as a SEA binary (`~/bin/crux`) with zero runtime dependencies
- MCP server works reliably inside Claude Code and other MCP hosts
- PWA UI is installable from `localhost` and usable as a daily driver
- All core project management workflows completable from either CLI or UI — no mandatory fallback to raw SQL
- Data lives in `~/.crux/crux.db` (SQLite) — durable, portable, no cloud required
- No multi-user auth required for local-only deployment; `127.0.0.1` binding is the security boundary

**Out of scope for v1 production:**
- Multi-user / shared-team deployment (deferred to K8s phase)
- OAuth / API key auth (deferred until networked deployment)
- Mobile browser support beyond PWA install on desktop

---

## 2. Current State Summary

| Layer | Status |
|---|---|
| CLI (30+ commands) | ✅ Feature-complete for core PM workflows |
| MCP server (27 tools) | ✅ Stable, used in production by author daily |
| SEA build pipeline | ✅ Reproducible via `make sea-macos` |
| PWA shell | ✅ Installable on localhost, manifest + SW working |
| HTTP API | ⚠️ Read-only (GET only) — zero write path |
| UI write operations | ❌ None — all mutations require CLI or MCP |
| Project status management | ❌ No CLI command to pause/stall/complete a project |
| UI navigation UX | ⚠️ Nav exists, but project→task→dep workflow incomplete |

---

## 3. Gap Table

### P0 — Blocking (must fix before calling it production)

| # | Gap | Category | Phase 18 Task |
|---|---|---|---|
| 1 | UI has zero write path — no POST endpoints | UI write path | `p18-api-write-path` |
| 2 | Cannot change project status (pause/stall/done) from CLI | CLI gap | `p18-project-status-cli` |
| 3 | No task status toggle in UI — must use CLI | UI write path | `p18-task-list-ui` |
| 4 | No project status change in UI — Kanban columns are decorative | UI write path | `p18-project-kanban-ui` |
| 5 | `crux switch` with no args errors instead of listing projects | CLI UX | `p18-switch-list` |

### P1 — Important (ship soon after P0)

| # | Gap | Category | Phase 18 Task |
|---|---|---|---|
| 6 | No Gantt chart — CPM data computed but not visualised | UX/workflow | `p18-gantt-ui` |
| 7 | No link from project page to CPM dependency graph | UX/workflow | `p18-graph-link-ui` |
| 8 | No session timer in UI — time tracking requires CLI | UX/workflow | `p18-session-ui` |
| 9 | Task list has no filter or search | UX/workflow | `p18-task-list-ui` |
| 10 | No dependency view per task (predecessors/successors) | UX/workflow | `p18-graph-link-ui` |

### P2 — Nice to Have (post-v1)

| # | Gap | Category | Notes |
|---|---|---|---|
| 11 | No ADR UI — create/view ADRs requires CLI/MCP | UX | Low frequency operation |
| 12 | No ROI entry form in UI | UX | CLI `crux roi add` covers this |
| 13 | `project set-env` has no MCP tool | CLI/MCP parity | Minor |
| 14 | Agent iteration count not persisted to DB | Observability | Low priority |
| 15 | Sheets sync has no UI config | Integration | Niche |
| 16 | No task creation form in UI | UX | CLI/MCP preferred path |
| 17 | DB explorer has 500-row hard limit | UX | Acceptable for v1 |
| 18 | No LLM chat interface in UI | Feature | Phase 19+ |
| 19 | No mkcert / HTTPS for LAN access | Infrastructure | Deferred to K8s phase |
| 20 | No multi-user auth | Infrastructure | Deferred to networked deployment |

---

## 4. Security Model Decision

**For v1 (local-only):** HTTP server binds to `127.0.0.1` only. No auth required. This is the correct model for a personal productivity tool — the OS user boundary is the auth boundary.

**For future networked/K8s deployment:**
- TLS termination at ingress (nginx + cert-manager + Let's Encrypt)
- crux SEA stays plain HTTP internally
- Add `Bearer` token auth to POST endpoints before any non-localhost exposure
- Single shared secret in `~/.crux/crux.json` (`api_token` field, future)

No code changes needed for v1. The binding to `127.0.0.1` in `lib/server.ts` must not be changed without also adding auth.

---

## 5. Phase 18 Coverage of P0 Gaps

| P0 Gap | Covered by |
|---|---|
| Zero UI write path | `p18-api-write-path` (gates all UI tasks) |
| No project status CLI | `p18-project-status-cli` |
| No task toggle in UI | `p18-task-list-ui` |
| No project status in UI | `p18-project-kanban-ui` |
| `crux switch` no-arg error | `p18-switch-list` |

**All 5 P0 gaps are covered by Phase 18 tasks. ✓**

---

## 6. Sign-off

- [ ] Author review: confirm P0 list is complete and correct
- [ ] Confirm "local-only, 127.0.0.1" as v1 security boundary
- [ ] Confirm P2 items are genuinely post-v1 (not secretly P0)
- [ ] Merge PROD_GAPS.md and mark `p18-prod-audit` done
