# demo-app — Tasks
<!-- GENERATED: false — example seed for crux demo -->

## Phase 0: Foundations

| Slug | Title | Status | Depends On |
|---|---|---|---|
| f0-repo | Initialise git repo and package.json | done | — |
| f0-ci | Configure GitHub Actions (lint + test) | done | f0-repo |
| f0-docker | Write Dockerfile and docker-compose.yml | done | f0-repo |

## Phase 1: Data Layer

| Slug | Title | Status | Depends On |
|---|---|---|---|
| d1-schema | Design Postgres schema (users, projects, tasks) | done | f0-repo |
| d1-migrations | Write Flyway migration scripts | done | d1-schema |
| d1-orm | Integrate Drizzle ORM, generate types | done | d1-migrations |
| d1-seed | Write seed script for local dev | done | d1-orm |

## Phase 2: Auth

| Slug | Title | Status | Depends On |
|---|---|---|---|
| a2-jwt | Implement JWT issuance and validation | done | d1-orm |
| a2-refresh | Add refresh-token rotation | done | a2-jwt |
| a2-oauth | Add GitHub OAuth2 flow | active | a2-jwt |
| a2-rbac | Implement role-based access control (admin/member/viewer) | open | a2-oauth |

## Phase 3: REST API

| Slug | Title | Status | Depends On |
|---|---|---|---|
| r3-users | CRUD endpoints for users | done | a2-jwt, d1-orm |
| r3-projects | CRUD endpoints for projects | active | a2-rbac, d1-orm |
| r3-tasks | CRUD endpoints for tasks (with pagination) | open | r3-projects |
| r3-search | Full-text search endpoint (pg tsvector) | open | r3-tasks |
| r3-webhooks | Outbound webhook dispatch on state change | open | r3-tasks |

## Phase 4: Frontend

| Slug | Title | Status | Depends On |
|---|---|---|---|
| fe4-scaffold | Scaffold React + Vite + TailwindCSS | done | f0-repo |
| fe4-auth-ui | Login / register / OAuth button screens | active | a2-oauth, fe4-scaffold |
| fe4-dashboard | Project list and summary dashboard | open | r3-projects, fe4-auth-ui |
| fe4-kanban | Drag-and-drop Kanban board | open | r3-tasks, fe4-dashboard |
| fe4-notifications | Real-time toast notifications (SSE) | open | r3-webhooks, fe4-kanban |

## Phase 5: Testing

| Slug | Title | Status | Depends On |
|---|---|---|---|
| t5-unit-api | Unit tests for all API handlers (≥ 80 % coverage) | active | r3-tasks |
| t5-int-db | Integration tests against containerised Postgres | open | d1-seed |
| t5-e2e | Playwright E2E: login → create project → add task | open | fe4-kanban, t5-int-db |

## Phase 6: Observability

| Slug | Title | Status | Depends On |
|---|---|---|---|
| o6-logs | Structured JSON logging (pino) | done | r3-users |
| o6-metrics | Prometheus metrics endpoint | open | r3-tasks |
| o6-traces | OpenTelemetry traces (Jaeger exporter) | open | o6-metrics |
| o6-alerts | PagerDuty alert rules (p95 latency, error rate) | open | o6-traces |

## Phase 7: Deployment

| Slug | Title | Status | Depends On |
|---|---|---|---|
| dp7-staging | Deploy to staging (Railway) | open | t5-int-db |
| dp7-prod | Deploy to production (Railway, autoscale) | open | dp7-staging, t5-e2e |
| dp7-cdn | Configure Cloudflare CDN + WAF rules | open | dp7-prod |

---

## Critical Path (estimate)

```
f0-repo → d1-schema → d1-migrations → d1-orm → a2-jwt → a2-oauth → a2-rbac → r3-projects → r3-tasks → fe4-dashboard → fe4-kanban → t5-e2e → dp7-staging → dp7-prod
```

## Summary

| Phase | Tasks | Status |
|---|---|---|
| 0 — Foundations | 3 | 3 done |
| 1 — Data Layer | 4 | 4 done |
| 2 — Auth | 4 | 2 done, 1 active, 1 open |
| 3 — REST API | 5 | 1 done, 1 active, 3 open |
| 4 — Frontend | 5 | 1 done, 1 active, 3 open |
| 5 — Testing | 3 | 1 active, 2 open |
| 6 — Observability | 4 | 1 done, 3 open |
| 7 — Deployment | 3 | 3 open |
| **Total** | **31** | **11 done, 4 active, 16 open** |
