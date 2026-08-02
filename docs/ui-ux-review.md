# crux Web UI — UX Review

Scope: `ui/index.html`, `ui/project.html`, `ui/graph.html`, `ui/roi.html`, `ui/db.html`, `ui/app.js`, `ui/sw.js`, `lib/server.ts`. Produced for task `p25-ui-ux-review`, triggered by user-reported gap: *"I don't see the kanban board per project, should be able to click the project and it changes the kanban board, should be able to see and filter human/llm tasks."*

Constraint respected throughout: **ADR-005** — pure HTML/SVG, esbuild-inlined assets, no framework, no CDN. Every recommendation below stays inside that boundary.

## 1. Screen-by-screen inventory (what each page actually does today)

| Page | Route | What it renders | Data source |
|---|---|---|---|
| `index.html` | `/` | A kanban-*looking* board, but the lanes are **project status** (Active / Stalled / Paused / Done), and each card is a **project**, not a task. Cards show task-count/hours/ROI and a status `<select>`. A spread-warning banner appears if >2 active projects. | `GET /api/overview` |
| `project.html` | `/project?id=` | Session start/stop widget, 7 stat tiles, critical-path strip, then **one plain `<table>` per phase** (flat list, no grouping UI beyond a `<h2>` per phase — no accordion, no collapse). Each row has status dropdown + expandable dependency detail row. ROI table at the bottom. | `GET /api/project/:id`, `GET /api/cpm/:id` |
| `graph.html` | `/graph?id=` | Custom SVG DAG renderer with real pan/zoom/click-for-detail. Genuinely the most polished screen — hand-rolled layered layout (Kahn's algorithm + lane assignment), critical path highlighted in red, click node → info panel with WSJF/float/etc. | `GET /api/project/:id`, `GET /api/cpm/:id`, `GET /api/db/dependencies` |
| `roi.html` | `/roi` | Flat table of all projects' ROI/hr with a hardcoded `BASELINE = 150` AUD/hr opportunity-cost warning threshold. | `GET /api/roi` |
| `db.html` | `/db` | Raw SQLite table browser — tab per table, dumps up to 500 rows verbatim (including internal ids). Useful for debugging, not really an end-user screen. | `GET /api/db/:table` |

Shared shell (`app.js`): top nav (Overview / ROI / DB — **no nav link to Graph**, it's only reachable from within a project), PWA install prompt, shared dark-only CSS injected once, a tiny `el()` DOM builder used only by `index.html` (the other pages hand-build HTML strings via template literals — two different rendering styles in the same app).

## 2. Is there a per-project task kanban board? Does clicking a project switch into it?

**No, confirmed by reading the source.** `index.html`'s `#kanban` groups *projects* into status lanes — clicking a card just navigates to `/project?id=…`, and `project.html` has no board view at all, only the flat per-phase table described above. There is no task-level kanban anywhere in the app. This matches the user's report exactly.

## 3. Can tasks be filtered by executor (human/llm/hybrid/auto)?

**No.** Grepped `project.html` and `app.js` for `executor` — zero matches. The `executor` field (now mandatory on every task as of this session's `crux_task_add`/`crux_task_bulk_update` work) isn't displayed anywhere in the UI, let alone filterable. This is a genuinely new gap — no existing backlog task covers it (see below).

## 4. Gap list, mapped to existing backlog

| Gap | Existing backlog task? | Notes |
|---|---|---|
| No per-project task board/kanban | **Partially** — `p18-task-kanban-board` | Scoped as a *cross-project* kanban ("filter by project or view all"), not a *per-project* board reached by clicking into one project. As written it wouldn't fully satisfy the reported gap. Recommend re-scoping or splitting (see §5). |
| Flat, non-collapsible phase tables | `p22-ui-phase-accordions` | Already covers this — collapsible accordions per phase with rollup counts. Just needs building. |
| No filter/search on task list | `p18-task-list-ui` | Already covers filter/search, but its description doesn't mention `executor` as a filter dimension — needs that added when picked up. |
| No Gantt view | `p18-gantt-ui`, `p14-gantt-svg` | Two tasks touch Gantt from different angles (project page vs. CPM SVG overlay) — worth checking for overlap before both are built. |
| No live updates (must refresh) | `p22-ui-sse-live` | Already covers this. |
| No duration/actual variance columns | `p22-ui-duration-cols` | Already covers this. |
| No sub-task-status checklist | `p22-ui-task-substatus` | Already covers this. |
| **No executor (human/llm/hybrid) display or filter anywhere in the UI** | **None — net new** | Not covered by any open task. Recommend adding one (see §5). |
| No light mode / theme toggle | None — net new | All 5 pages hardcode a dark palette (`#0f0f0f` background) with no `prefers-color-scheme` handling or toggle. |
| No nav link to the Graph view | None — net new, minor | `renderNav()` only lists Overview/ROI/DB; Graph is orphaned unless you're already inside a project. |
| `db.html` has no auth/warning and exposes raw internal ids/rows | None — net new, minor | Fine for a local single-user tool (server binds `127.0.0.1` only per `lib/server.ts` header comment), but worth a one-line note if this UI is ever exposed beyond localhost — `PROD_GAPS.md` / `p23-cloud-deploy-security-research` already own that broader question. |
| Almost no accessibility affordances | None — net new, minor | Only 3 `aria-label`s in the whole UI (zoom buttons in `graph.html`). Status `<select>` elements, tab buttons in `db.html`, and kanban cards have no `aria-*` or keyboard-focus styling beyond browser defaults. |

## 5. Prioritized recommendations

All within ADR-005 (no framework, no CDN, esbuild-inlined assets):

1. **Add a real per-project task board to `project.html`.** Reuse the existing `el()`-less template-literal pattern already used in that file. Group by `status` into columns (`open` / `in-progress` / `blocked` / `done`) the same way `index.html` already groups projects by status into lanes — the pattern to copy from is `index.html`'s `LANES`/`grouped` logic (lines ~60–81), just swap the grouping key from project-status to task-status and the card content from project stats to task stats. This directly answers "click the project and it changes the kanban board." Suggest folding this into `p18-task-kanban-board` but re-scoping its title/description from "cross-project" to explicitly include this per-project view, since as currently written it wouldn't deliver what was asked.
2. **Add an executor filter + badge.** Cheapest high-value fix: add a `statusBadge`-style helper for `executor` in `app.js` (same pattern as the existing `statusBadge()` function, lines 97–110) and a row of filter toggle-buttons above the task table/board in `project.html` (`human` / `llm` / `hybrid` / `auto`, client-side filter over the already-fetched `tasks` array — no new API endpoint needed). This is not covered by any open task; recommend adding a new one (e.g. `p25-ui-executor-filter`) rather than folding into `p18-task-list-ui`, since it's a distinct, small, high-value slice that shouldn't wait on the larger list redesign.
3. **Land `p22-ui-phase-accordions` before or alongside #1** — a per-status board and collapsible phase groups solve adjacent-but-different problems (status view vs. phase view); doing accordions first makes the eventual board easier to reason about since phase-grouping logic won't need to be re-derived.
4. **Reconcile `p18-gantt-ui` vs `p14-gantt-svg`** before either is picked up — confirm they're not duplicate scope (project-page Gantt vs. CPM-graph Gantt overlay) to avoid two competing implementations.
5. **Add a nav link to Graph** in `app.js`'s `renderNav()` links array (currently only Overview/ROI/DB) — one-line fix, but the graph view is the most polished screen in the app and is currently only reachable by drilling into a project first.
6. **Light mode** is a bigger lift (every page hardcodes colors inline rather than using CSS custom properties) — not urgent, but if picked up, the prerequisite refactor is centralizing the color palette into CSS variables in `app.js`'s injected shared styles first, since right now each of the 5 HTML files duplicates its own `<style>` block with hardcoded hex values.

## Bonus: overall app findings (not UI-specific, found while reading around this)

While reading the build/serve path to understand how the UI reaches the browser, two things stood out that aren't UI/UX per se but affect whether these recommendations can even be tested locally:

- **`make dev` / `make build` / `make preview` are broken.** They run `npm run dev`, `npm run build`, and `npm run preview` respectively (Makefile lines 107–117), but `package.json`'s `scripts` block has no `dev`, `build`, or `preview` entries — only `test`, `test:agent`, `lint`, `typecheck`, `format`, `bundle`. These targets appear to be leftover boilerplate from a Vite-style scaffold (the `dev` target's own echo even says *"Start Vite dev server"*, but this project has no Vite dependency anywhere in `package.json`). Running any of the three fails immediately with `npm error Missing script`. Worth a follow-up task to either implement or remove them — right now there's no documented `make` target that actually serves the UI locally for manual testing.
- **UI changes require the same rebuild-and-reload cycle as MCP tool changes.** `esbuild.config.mjs` inlines every file under `ui/` into `lib/ui-assets.ts` as string constants at bundle time (`ui-assets.ts` comment: *"Replace lib/ui-assets.ts with all UI files inlined as strings at bundle time"*). So a UI edit isn't visible until `make bundle`/`make sea-macos` reruns — the exact same friction already tracked for MCP tools under `p18-mcp-self-reload`. Worth linking these two, or broadening `p18-mcp-self-reload`'s scope to cover "any bundled asset," not just MCP tool definitions.
