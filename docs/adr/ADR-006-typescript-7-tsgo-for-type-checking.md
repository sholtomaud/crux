# ADR-006: TypeScript 7 (tsgo) for type-checking

**Status:** accepted
**Date:** 2026-07-12

## Context

REQUIREMENTS.MD already commits this project to a native-stack philosophy:
native TypeScript execution (no `ts-node`/`tsx`), native `node:sqlite`, native
`node:test`. Both are already true in practice — `bin` points straight at
`index.ts` and every test file runs unmodified under `node --test` — but
type-*checking* was still on classic `tsc` 5.7 (`Makefile` `typecheck` /
`typecheck-errors` targets). A sibling project, `tfnsw`, adopted TypeScript
7's native-preview compiler (`@typescript/native-preview`, CLI `tsgo`, a Go
port of the type checker) and measured a 4x+ speedup on full-project
type-checking. There's no reason not to bring crux's last non-native piece
of tooling in line.

## Decision

Replace the `typescript` devDependency with `@typescript/native-preview` and
point both `make typecheck` and `make typecheck-errors` at
`node_modules/.bin/tsgo --noEmit` instead of `tsc --noEmit`. `tsconfig.json`
is unchanged — `tsgo` consumes the same config and the existing
`NodeNext`/`allowImportingTsExtensions` setup type-checks clean under it.
No source changes were required; `tsgo` and `tsc` 5.7 agreed on every file.
`npm run typecheck` is also added at the package.json level, mirroring the
Makefile target, since crux previously had no npm-level type-check script.

## Consequences

`make typecheck` is meaningfully faster. Runtime behavior is unchanged —
this only affects the dev-time checking path, not what ships (esbuild still
does its own transform for the SEA bundle, unaffected by this swap; see
[ADR-001](ADR-001-adopt-node-js-single-executable-application-sea-for-distribution.md)
and [ADR-005](ADR-005-pure-html-svg-ui-with-esbuild-inlined-assets-no-framework-no-cdn.md)).
`tsgo` is still a dev-preview release (`^7.0.0-dev`), so pin bumps should be
re-verified against `make typecheck` + full test suite before merging.
Editors relying on the stock TS language service (not the native-preview
extension) will still show 5.x-based inline diagnostics until installed —
this is a display-only gap since the source of truth for CI/Make is `tsgo`.
