-- crux schema
-- Applied once per global DB at ~/.crux/crux.db

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id           TEXT PRIMARY KEY,   -- UUID
    name         TEXT NOT NULL,
    type         TEXT NOT NULL CHECK(type IN ('code_repo','article','research','freelance','learning','personal')),
    status       TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','stalled','paused','done','dropped')),
    gh_repo      TEXT,               -- owner/repo or NULL
    gh_sync      INTEGER NOT NULL DEFAULT 0 CHECK(gh_sync IN (0,1)),
    sheets_id    TEXT,               -- Google Sheets spreadsheet ID or NULL
    hourly_rate  REAL,               -- opportunity cost baseline (per project override)
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug             TEXT NOT NULL,
    title            TEXT NOT NULL,
    description      TEXT,
    phase            TEXT,
    status           TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in-progress','blocked','done','dropped')),
    priority         INTEGER NOT NULL DEFAULT 0,
    duration_days    REAL,
    -- CPM fields (computed, stored for reporting)
    early_start      REAL,
    early_finish     REAL,
    late_start       REAL,
    late_finish      REAL,
    float_days       REAL,
    is_critical      INTEGER NOT NULL DEFAULT 0 CHECK(is_critical IN (0,1)),
    -- integrations
    gh_issue_number  INTEGER,
    coverage_target  REAL,           -- auto-close when test_run.coverage >= this
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, slug)
);

CREATE TABLE IF NOT EXISTS task_adrs (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    adr_id  INTEGER NOT NULL REFERENCES adrs(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, adr_id)
);

CREATE TABLE IF NOT EXISTS dependencies (
    predecessor_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    successor_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (predecessor_id, successor_id),
    CHECK(predecessor_id != successor_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT,
    note        TEXT,
    minutes     REAL   -- computed on session end
);

CREATE TABLE IF NOT EXISTS roi_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    amount      REAL NOT NULL,
    currency    TEXT NOT NULL DEFAULT 'AUD',
    kind        TEXT NOT NULL CHECK(kind IN ('revenue','cost','expected')),
    probability REAL NOT NULL DEFAULT 1.0 CHECK(probability >= 0.0 AND probability <= 1.0),
    note        TEXT
);

CREATE TABLE IF NOT EXISTS test_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_slug   TEXT,
    run_at      TEXT NOT NULL DEFAULT (datetime('now')),
    phase       TEXT CHECK(phase IN ('build','test-c','test-python','lint', NULL)),
    status      TEXT NOT NULL CHECK(status IN ('pass','fail')),
    coverage    REAL,
    output      TEXT,
    commit_sha  TEXT
);

CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
    task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    event       TEXT NOT NULL,
    detail      TEXT,
    actor       TEXT NOT NULL DEFAULT 'human' CHECK(actor IN ('human','crux-auto','claude')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS adrs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number       INTEGER NOT NULL,
    title        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','deprecated','superseded')),
    context      TEXT,
    decision     TEXT,
    consequences TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, number)
);

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_tasks_project   ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_proj   ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_proj      ON audit(project_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_proj  ON test_runs(project_id);
