-- Monica SQLite Schema (Single Source of Truth)
-- Edit this file, then run `just db-diff <name>` to generate a migration.

CREATE TABLE mon_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

CREATE TABLE task_run_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  phase        TEXT,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  project_id   TEXT,
  labels       TEXT NOT NULL DEFAULT '[]',
  details_json TEXT NOT NULL DEFAULT '{}',
  source_json  TEXT,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE task_runs (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  agent               TEXT,
  branch              TEXT,
  worktree_path       TEXT,
  status              TEXT NOT NULL,
  settings_path       TEXT,
  wait_reason         TEXT,
  provider_session_id TEXT,
  last_event_name     TEXT,
  last_event_at       TEXT,
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT REFERENCES tasks(id),
  task_run_id  TEXT REFERENCES task_runs(id),
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE external_refs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  ref_type   TEXT NOT NULL,
  repo       TEXT,
  number     INTEGER,
  url        TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE projects (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  provider              TEXT NOT NULL DEFAULT 'github',
  repo                  TEXT NOT NULL,
  path                  TEXT,
  default_branch        TEXT NOT NULL DEFAULT 'main',
  worktree_root         TEXT,
  setup_timeout_sec     INTEGER NOT NULL DEFAULT 600,
  agent_default         TEXT NOT NULL DEFAULT 'claude',
  agent_permission_mode TEXT NOT NULL DEFAULT 'plan',
  hooks_claude          INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE external_ref_syncs (
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  source_ref_id   INTEGER NOT NULL REFERENCES external_refs(id),
  target_ref_type TEXT NOT NULL,
  last_synced_at  TEXT,
  last_error      TEXT,
  next_retry_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (task_id, source_ref_id, target_ref_type)
);

CREATE UNIQUE INDEX external_refs_github_pr_unique
  ON external_refs(task_id, ref_type, repo, number)
 WHERE ref_type = 'github_pull_request'
   AND repo IS NOT NULL
   AND number IS NOT NULL;

CREATE TABLE github_pull_request_ref_states (
  external_ref_id INTEGER PRIMARY KEY REFERENCES external_refs(id) ON DELETE CASCADE,
  status          TEXT CHECK(status IN ('draft', 'open', 'closed', 'merged')),
  synced_at       TEXT,
  last_error      TEXT,
  next_retry_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX github_pr_ref_states_refresh_idx
  ON github_pull_request_ref_states(status, synced_at, next_retry_at);

CREATE TABLE github_pull_request_branch_syncs (
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  repo           TEXT NOT NULL,
  branch         TEXT NOT NULL,
  last_synced_at TEXT,
  last_error     TEXT,
  next_retry_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (task_id, repo, branch)
);

CREATE INDEX github_pr_branch_syncs_retry_idx
  ON github_pull_request_branch_syncs(next_retry_at);

CREATE TABLE terminal_runspaces (
  id         TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE terminal_tabs (
  id          TEXT PRIMARY KEY,
  runspace_id TEXT NOT NULL REFERENCES terminal_runspaces(id) ON DELETE CASCADE,
  cwd         TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX terminal_tabs_runspace_idx ON terminal_tabs(runspace_id, sort_order);
