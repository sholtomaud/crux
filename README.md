# crux

Personal project manager with Critical Path Method (CPM), ROI tracking, and local LLM routing.
Runs as a CLI, an MCP server, and a browser UI. Distributed as a Node.js Single Executable Application (SEA) — no runtime required on the host.

---

## Prerequisites

- [Apple container CLI](https://github.com/apple/container) (provides Node 25 for the build)
- Python 3 on macOS host (for install automation — pre-installed on macOS)
- llama-server (optional, for `crux ask`)

No Node.js required on your Mac host.

---

## First-time setup

```sh
# 1. Build the container image (once)
make image

# 2. Update package-lock.json inside the container (once, or after adding deps)
make deps-update

# 3. Build the macOS SEA binary, install to ~/bin, configure PATH + VSCode MCP
make install
```

`make install` does all of the following automatically:
- Bundles TypeScript → `dist/crux.cjs` (esbuild)
- Downloads the official macOS arm64 Node binary inside the container
- Injects the bundle blob into the Node binary (`postject`)
- Copies `dist/crux-macos-arm64` → `~/bin/crux`
- Strips Gatekeeper quarantine (`xattr -d com.apple.quarantine`)
- Adds `~/bin` to `PATH` in `~/.zshrc` if missing
- Merges the MCP server entry into VSCode `settings.json`

After install, open a new terminal:

```sh
crux --help
```

---

## Daily use

### CLI

```sh
crux init                        # initialise a project in the current repo
crux status                      # show task progress + CPM
crux overview                    # meta Kanban across all projects
crux task add <slug> "<title>"   # add a task
crux task update <slug> active   # update task status
crux dep add <from> <to>         # add a dependency
crux cpm                         # print critical path
crux graph                       # ASCII dependency DAG
crux roi record <slug> <hours> <value>
crux session start
crux session end
crux report tasks                # generate tasks.md
crux report status               # generate status.md
crux ask "what should I work on next?"   # route to local LLM
crux ui                          # start browser UI on http://localhost:8765
```

### Browser UI

```sh
crux ui
```

Open [http://localhost:8765](http://localhost:8765). Pages:

| URL | Description |
|---|---|
| `/` | Meta Kanban — all projects by status |
| `/project.html?id=<id>` | Project detail — tasks, CPM, burndown |
| `/roi.html?id=<id>` | ROI dashboard + spread indicator |
| `/graph.html?id=<id>` | Dependency DAG (SVG) |
| `/db.html` | Raw table explorer |

### Local LLM (`crux ask`)

crux routes natural-language questions to a local OpenAI-compatible endpoint.
Default config at `~/.crux/config.json`:

```json
{
  "llm": {
    "endpoint": "http://localhost:8080/v1/chat/completions",
    "model": "local",
    "max_tokens": 512,
    "temperature": 0.2
  }
}
```

Start llama-server with `--host 0.0.0.0` if calling from inside a container.
From a container, the Mac host is typically reachable at `192.168.64.1`.

---

## MCP server

crux runs as an MCP stdio server when invoked with no arguments and a piped stdin.

### VSCode

`make install` adds this to `~/Library/Application Support/Code/User/settings.json` automatically:

```json
{
  "mcp": {
    "servers": {
      "crux": { "command": "/Users/<you>/bin/crux" }
    }
  }
}
```

### Claude Code (requires Node 25 on host)

```sh
mcpb init crux.mcpb
```

### Available MCP tools (21)

`crux_init`, `crux_status`, `crux_overview`, `crux_cpm`, `crux_task_add`, `crux_task_update`,
`crux_dep_add`, `crux_sync`, `crux_report`, `crux_ready`, `crux_graph`, `crux_test_run`,
`crux_milestone_check`, `crux_session_start`, `crux_session_end`, `crux_roi_record`,
`crux_roi_report`, `crux_spread_check`, `crux_project_add`, `crux_project_link`, `crux_ask`

---

## Build targets

```sh
make image          # build container image
make deps-update    # npm install inside container (update lock file)
make install        # full macOS SEA build + install + configure
make sea-linux      # build Linux arm64 SEA → dist/crux-linux-arm64
make sea-macos      # build macOS arm64 SEA → dist/crux-macos-arm64 (unsigned)
make bundle         # esbuild only → dist/crux.cjs
make test           # run unit tests
make validate       # lint + test
make mcpb-pack      # pack crux.mcpb bundle
make shell          # interactive container shell
make clean          # remove container image + volumes
```

---

## Skill (three-tier routing)

Copy `skills/crux/SKILL.md` to your Claude project skills directory to activate routing:

```
TIER 1 — CLI      crux <command>          free, instant
TIER 2 — Local    crux ask "<question>"   free, local LLM
TIER 3 — Claude   MCP tools               paid, cloud
```

---

## Database

Global DB at `~/.crux/crux.db` (SQLite, WAL mode).
Per-repo pointer at `.crux/project.json`.

Schema: `projects`, `tasks`, `dependencies`, `sessions`, `roi_records`, `test_runs`, `adrs`, `task_adrs`, `audit`.
# crux
