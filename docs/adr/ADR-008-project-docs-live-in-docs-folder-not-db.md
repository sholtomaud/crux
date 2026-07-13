# ADR-008: All project documentation lives in docs/ as markdown, not the crux DB

**Status:** accepted
**Date:** 2026-07-13

## Context

ADR-007 settled this specifically for ADRs: `docs/adr/*.md` is canonical,
the DB `adrs` table is deprecated. The broader question behind
p23-docs-storage-decision — where do requirements docs, design docs, and
other project documentation live — was still open.

In practice there's no real DB alternative to compare against: crux's
schema has no table for requirements or design docs (only
`tasks`/`projects`/`adrs`/`dependencies`/`sessions`/`roi_records`/etc.),
and `docs/status-2026-04-14.md` already lives as a plain git-tracked file,
matching the pattern this ADR just makes explicit.

## Decision

All project documentation — requirements, design docs, ADRs, status
snapshots — lives as git-tracked markdown under `docs/` (`docs/adr/`,
and `docs/requirements/`, `docs/design/` etc. as they're needed). The
crux DB stores structured, queryable project-management data only: tasks,
dependencies, sessions, ROI, test runs, audit log. It is not a document
store. No new tables or MCP tools should be added for prose documentation
types.

## Consequences

Docs stay diffable and reviewable in PRs, and readable without crux
running. Agents orienting on a project should read `docs/` directly (per
ADR-007) rather than expect crux tools to surface project documentation.
`crux_adr_add` remains deprecated (ADR-007); no equivalent tool should be
built for other doc types.
