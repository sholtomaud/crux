# ADR-009: Drop @modelcontextprotocol/sdk for a hand-rolled stdio server

**Status:** accepted
**Date:** 2026-08-02

## Context

crux declares exactly one runtime dependency, `@modelcontextprotocol/sdk`.
That one dependency resolves to 132 packages: express, express-rate-limit,
hono, @hono/node-server, cors, jose, pkce-challenge, eventsource, ajv,
ajv-formats, raw-body, content-type, cross-spawn, zod, zod-to-json-schema
and their transitive deps — HTTP transport, SSE, CORS, rate limiting and
OAuth/JWT machinery.

crux executes none of it. The entire surface it touches is three imports in
`index.ts`: `McpServer`, `StdioServerTransport`, and `z`. ADR-002 already
settled that crux is stdio-only, so the HTTP and OAuth halves of the SDK are
dead weight by design, not by accident. `lib/server.ts` — the UI server —
already uses bare `node:http`.

The cost is not hypothetical. Every dependabot PR this repo has ever
received has been a bump to a transitive package under this dependency:
qs, fast-uri, ip-address, express-rate-limit, body-parser. On 2026-08-02 a
backlog of four such PRs had gone stale enough that three had to be closed
as obsolete — the lockfile had moved past them while they sat. That is
recurring maintenance on code paths that never run.

This is also the one place the stack departs from its own conventions:
`node:sqlite` over better-sqlite3, native TypeScript over ts-node, a
framework-free UI (ADR-005), a zero-install SEA binary (ADR-001).

## Decision

Replace the SDK with a hand-rolled MCP stdio server. MCP over stdio is
newline-delimited JSON-RPC 2.0 on stdin/stdout, and crux needs four
methods: `initialize`, `notifications/initialized`, `tools/list`,
`tools/call`.

Tool schemas go on the wire as JSON Schema, which is what
zod-to-json-schema produces today. Rather than transcribe 30
`server.tool()` registrations into literal JSON Schema objects by hand —
roughly 200 fields, each an opportunity for a silent typo that only
surfaces as a client-side validation failure — `lib/mcp/schema.ts`
provides a small builder covering exactly the subset of the zod API those
registrations use (`string`, `number`, `boolean`, `enum`, `array`,
`object`, plus `optional`, `describe`, `min`, `max`). It emits JSON Schema
and validates input. The registrations keep their existing shape, so the
cutover diff is an import line rather than 30 rewritten schemas, and
`git diff` stays reviewable.

The builder is deliberately not a general-purpose validation library: it
implements what crux's tool surface needs and should grow only when a tool
needs something new.

## Consequences

crux becomes a zero-runtime-dependency project: no dependabot treadmill, a
smaller SEA bundle, and a lockfile that only carries dev tooling.

In exchange crux owns protocol compliance. The SDK tracks MCP spec changes
and negotiates protocol versions; hand-rolled, that becomes a maintenance
task whenever the spec moves. Server features crux does not currently
expose — resources, prompts, sampling, elicitation — would each have to be
written rather than imported. Validation bugs become crux's bugs: zod
rejects malformed tool input today, and hand-written checks must not be
laxer, or a bad `tools/call` reaches the DB layer.

The bet is that a personal, stdio-only, tools-only server sits well inside
the stable core of the protocol, and that 132 packages is a high price for
three imports.
