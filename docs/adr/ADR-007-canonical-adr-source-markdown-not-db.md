# ADR-007: docs/adr/*.md is the canonical ADR source; DB `adrs` table is deprecated

**Status:** accepted
**Date:** 2026-07-12

## Context

crux has had two parallel places an ADR could live since early on: hand-written
files in `docs/adr/*.md` (ADR-001 through ADR-006, git-reviewable, diffable in
PRs) and a DB-backed `adrs` table with a matching `crux_adr_add`/`crux_adr_list`
MCP tool pair. Nothing kept the two in sync — `crux_project_context`'s `adrs`
array reflects the DB table, which already drifted (it lists 5 entries; ADR-006
only exists as a file, never backfilled).

## Decision

`docs/adr/*.md` is the canonical, single source of truth for architecture
decisions going forward. The DB `adrs` table and `crux_adr_add` are
deprecated: no new ADRs should be inserted via the tool. Existing DB rows
(ADR-001 through 005) are left as-is — a frozen historical snapshot, not
actively maintained — rather than deleted or backfilled to match the
markdown files exactly.

## Consequences

`crux_project_context`'s `adrs` array will read stale/incomplete going
forward (it won't show ADR-006, ADR-007, or anything after) — this is a
known, accepted gap, not a bug. Anyone (human or agent) wanting the current
architecture-decision record should read `docs/adr/*.md` directly rather
than trust `crux_project_context`'s `adrs` field. A future task could either
remove the `adrs` table/tool entirely or repoint `crux_adr_list` to read the
markdown files instead of the DB table — not scoped here.
