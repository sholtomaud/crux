# Dev Velocity Review — Is the Current Design Right for the Speed We Need?

Quick, critical pass requested mid-way through the UI/UX roadmap (Phases 1–2 shipped: sidebar shell + design tokens + per-project kanban, agent panel scaffold; Phase 3 WebSockets planned but not yet built). Question: does the current technology/design still fit how fast we need to move, given where the roadmap is headed (real-time updates, agent chat, token/$/economics dashboard)?

**Short answer: the core is sound, the edges are already taxing us, and the tax gets worse from here if unaddressed.** Not a rubber stamp — several of the things below cost real time *this session*, not hypothetically.

## What's working and shouldn't change

- **SQLite + single global DB, dual CLI/MCP entrypoint.** No server to run, no schema-migration ceremony, works identically for me (agent) and the human via the same code path. Genuinely good fit for a personal tool moving fast.
- **TypeScript everywhere except the UI.** Every bug this session that typecheck could have caught, it did — the `executor` field, the `apiOverview` extension, the `live.ts` design — all typed and safe. This is a real asset, not a cost.
- **Three-tier routing (CLI/local-LLM/Claude).** Not exercised much this session, but the concept — cheap deterministic operations don't need an LLM at all — is exactly right for cost/speed at scale.
- **SEA binary distribution.** Zero-dependency, offline, single-file — correct for the actual deployment target (a personal Mac tool). Not the problem; *how long it takes to produce one* is.

## What's actually taxing velocity right now

Each of these is a concrete incident, not a hunch:

1. **No hot reload — every change costs a full multi-minute rebuild.** `make sea-macos` runs a container boot, `npm ci` (when the cache holds), `esbuild`, a Node runtime download, SEA blob injection (memory-hungry `postject`), codesign, and install. We ran this loop **six-plus times** this session for both MCP tool changes and UI changes. There's no way to see a change take effect without it. This is already tracked (`p18-mcp-self-reload`) but it's been sitting open while everything downstream — every UI phase, the executor-field rollout — paid the tax on top of it.
2. **The build/verification harness itself was unreliable, twice.** The `node_modules_cache` container volume silently dropped `esbuild` after a daemon crash mid-session — the `.package-lock.json` marker survived, so `ensure-deps` skipped reinstalling and every build failed with a confusing `Cannot find package 'esbuild'` until we forced a fresh `npm ci`. This wasn't a one-off; it happened again later in the session too.
3. **Container-based testing can't reach the actual server.** `startServer()` correctly binds `127.0.0.1` only (right call for the real deployment), but that makes it *unreachable* through container port-publishing — every UI verification this session had to fall back to running the SEA binary natively on the host instead. Fine once understood, but it cost debugging time twice before the pattern was clear.
4. **Process lifecycle isn't clean.** Six `crux` processes were found running simultaneously — five orphaned from 5:42am, still alive, holding no ports, doing nothing. VSCode's "Reload Window" isn't reliably killing the previous MCP server child process. Harmless today (small idle processes), but it's a sign the dev-reload story is fragile in more than one way.
5. **A shipped fix was invisible for a full round-trip because of a caching bug we introduced ourselves.** The PWA service worker cache-first'd `/` and `/app.js` under a `CACHE = 'crux-v1'` constant that had never been bumped — an entire UI redesign shipped correctly to the server and was still invisible in the browser until we found and fixed that. Filed as `p26-sw-cache-auto-version` (still open) precisely because it *will* recur on every future UI change until the version is derived automatically instead of hand-bumped.
6. **Zero test coverage for the UI layer, and it's growing fast.** Every verification of `index.html`/`project.html`/`app.js` this session was `node --check` (syntax only) plus manual `curl`+`grep` against rendered HTML. That catches typos, not logic bugs — a broken `onclick`, a null dereference in `renderContent()`, a filter that silently returns the wrong tasks would all sail through everything we ran. This was tolerable when the UI was five flat, mostly-read-only pages. It's a real gap now that it's a stateful kanban board with filters, a collapsible panel with `localStorage` state, and (next) WebSocket reconnect logic — none of which get any automated safety net.

## Is the no-framework, no-test UI approach still the right call?

ADR-005's reasoning (self-contained, offline, no CDN, no build complexity disproportionate to scope) was correct *for the scope it was written against* — five simple, mostly-static pages. That scope has already changed: Phase 1 added client-side filtering/search state, Phase 2 added `localStorage`-persisted UI state, Phase 3 (planned) adds WebSocket connection state with reconnect-with-backoff, and Phase 4 (planned) adds another dashboard on top. Each phase hand-writes its own version of the same `loadAndRender()`/`renderContent()`-split pattern — not reused, *re-derived* per page, because there's no component model to share it through.

None of that requires reversing ADR-005's actual constraints (no CDN, offline SEA binary) — those are still right. But "no framework" and "no tests" together is a combination that was cheap when the UI was simple and gets more expensive, silently, as it isn't. The risk isn't a framework-vs-no-framework religious question; it's that the codebase is accumulating exactly the kind of stateful, event-driven complexity that's hardest to keep correct by hand-inspection alone, on the one layer of the app with the least amount of safety net.

## Recommendations (none require dropping ADR-005 or the offline SEA binary)

1. **Prioritize `p18-mcp-self-reload` above the remaining UI phases.** Every phase from here pays the same multi-minute rebuild tax; fixing the tax once is worth more than any single feature.
2. **Fix the two build-harness reliability bugs directly**, not just work around them again next time: make `ensure-deps` actually verify `esbuild` is present (not just check for the marker file), and document (or fix) the container-can't-reach-127.0.0.1 limitation so it's not rediscovered from scratch.
3. **Add a minimal UI test harness before Phase 3 (WebSockets) lands**, not after. Doesn't require a framework — running the extracted `<script>` bodies under a lightweight DOM shim (e.g. a `jsdom`-based unit test, same `test/unit/` directory the rest of the codebase already uses) would catch real logic bugs, not just syntax errors, without touching ADR-005 at all.
4. **Formalize the repeated `loadAndRender()`/`renderContent()` pattern into one shared helper in `app.js`** instead of re-deriving it on every new page. A shared *pattern function* is not a framework — it's just not duplicating the same 15 lines a third and fourth time for WebSockets and the economics dashboard.
5. **Land `p26-sw-cache-auto-version` now, not later** — it's small, and it's the exact bug that just cost a full round-trip.

Net: keep the architecture, fix the loop. The tech choices aren't wrong; the iteration loop around them is the actual bottleneck, and it compounds with every phase we add on top of it.
