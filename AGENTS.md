# AGENTS.md

crux is a personal project manager (CPM scheduling, ROI tracking, GitHub
sync) exposed as both a CLI and an MCP server, meant to be driven by an
agent as much as by a human. This file documents the stack conventions so
an agent working in this repo doesn't have to rediscover them.

## Stack: native TypeScript, native SQLite, tsgo for type-checking

- **No build step for dev/CLI/tests.** `.ts` files run directly under
  Node's native TypeScript support — `package.json`'s `bin` points straight
  at `./index.ts`, and `npm test`/`npm run test:agent` run `.ts` test files
  directly via `node --test`. There is no `ts-node`, no `tsx`, no
  transpile-then-run step anywhere in the dev/test loop.
- **`node:sqlite`, not `better-sqlite3`.** Every file in `lib/db/` takes a
  `DatabaseSync` (from `node:sqlite`) as its first parameter — dependency
  injection, no module-level singleton except the one lazy instance in
  `lib/db/open.ts`. `db.exec(...)` is used for schema/DDL/migrations;
  `db.prepare(...).run()/.get()/.all()` for DML. Statements are constructed
  inline per call — there's no cached prepared-statement or
  `db.transaction()`/`iterate()` usage anywhere in `lib/db/*`. New DB code
  should follow that same simple, uncached style rather than introducing a
  different pattern. `DatabaseSync` returns untyped rows, so read sites cast
  with `as unknown as <RowType>` (see `lib/db/projects.ts`, `lib/db/tasks.ts`).
- **`tsgo`, not `tsc`, for type-checking.** Type-checking runs on TypeScript
  7's native-preview compiler (`@typescript/native-preview`, CLI `tsgo`) —
  `make typecheck` / `npm run typecheck` call `tsgo --noEmit`. It's a
  drop-in for `tsc --noEmit` against the same `tsconfig.json`, just much
  faster. See [ADR-006](docs/adr/ADR-006-typescript-7-tsgo-for-type-checking.md).
- **esbuild is only for the SEA bundle**, not for dev or type-checking.
  `make bundle` (`npm run bundle`) produces `dist/crux.cjs`, which
  `make sea-macos`/`sea-linux` then embeds into a standalone Node binary via
  `postject` — see [ADR-001](docs/adr/ADR-001-adopt-node-js-single-executable-application-sea-for-distribution.md).
  This is a deliberate zero-Node-install distribution story; it's orthogonal
  to `tsgo` and shouldn't be conflated with the type-checking tooling.

## Running things

Everything runs inside a container (`make image` to build it once) — there
is no expectation of a host-installed Node/npm. Use the `Makefile` targets
(`make test`, `make typecheck`, `make bundle`, `make dev`, etc.), which wrap
the equivalent `npm` script in a `container run` invocation. Don't reach for
bare `npm`/`node` on the host.

## Tests and TDD

- `test/unit/*.test.ts` — fast, one in-memory `:memory:` `DatabaseSync` per
  test, built from `schema.sql` (see `makeDb()` in `test/unit/reports.test.ts`
  for the pattern). Run via `make test` / `npm test`.
- `test/integration/*.test.ts` — exercises real `gh` CLI / GitHub API calls
  (slower, can take seconds per test). Run via `make test-agent` /
  `npm run test:agent`.
- `test/e2e/*.spec.ts` — Playwright, excluded from `tsconfig.json` and the
  typecheck/lint globs.
- For behavior changes: write or extend a test in the appropriate tier
  first, then implement. When `tsgo`/`tsc` flags a type error, treat it as a
  signal, not busywork — if it points at a real logic gap, add a failing
  test before fixing the source; if it's a benign annotation mismatch, fix
  the type directly.

## ADRs

Architectural/tooling decisions with lasting consequences are recorded in
`docs/adr/` (`ADR-NNN-title.md`, format: Status/Date, then
Context/Decision/Consequences, ~15-20 lines). Check there before assuming a
piece of the stack (SEA, MCP transport, routing tiers, CPM/WSJF scheduling,
the framework-free UI, `tsgo`) is up for casual change.
