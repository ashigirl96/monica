use anyhow::{Context, Result};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

/// Ordered schema migrations, tracked by `PRAGMA user_version` (rusqlite_migration
/// uses the list position as the version). Append an `M::up(...)` to add a version;
/// never reorder or remove existing entries, or already-migrated databases diverge.
fn migrations() -> Migrations<'static> {
    Migrations::new(migration_steps())
}

fn migration_steps() -> Vec<M<'static>> {
    vec![
        M::up(V1),
        M::up(V2),
        M::up(V3),
        M::up(V4),
        M::up(V5),
        M::up(V6),
        M::up(V7),
        M::up(V8),
        M::up(V9),
        M::up(V10),
        M::up(V11),
        M::up(V12),
        M::up(V13),
        M::up(V14),
        M::up(V15),
        M::up(V16),
        M::up(V17),
        M::up(V18),
        M::up(V19),
        M::up(V20),
        M::up(V21),
        M::up(V22),
        M::up(V23),
    ]
}

/// v1: storage foundation (work items, runs, events, external refs) + MON-id counter.
const V1: &str = r#"
    CREATE TABLE mon_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE work_items (
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
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE runs (
      id            TEXT PRIMARY KEY,
      work_item_id  TEXT NOT NULL REFERENCES work_items(id),
      agent         TEXT,
      branch        TEXT,
      worktree_path TEXT,
      status        TEXT NOT NULL,
      settings_path TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT REFERENCES work_items(id),
      run_id       TEXT REFERENCES runs(id),
      kind         TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE external_refs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      ref_type     TEXT NOT NULL,
      repo         TEXT,
      number       INTEGER,
      url          TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

/// v2: project registry. One row per repo, holding the execution-environment definition
/// that `issue run` resolves (worktree layout, branch naming, agent settings).
const V2: &str = r#"
    CREATE TABLE projects (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      provider              TEXT NOT NULL DEFAULT 'github',
      repo                  TEXT NOT NULL,
      path                  TEXT,
      default_branch        TEXT NOT NULL DEFAULT 'main',
      worktree_root         TEXT,
      branch_template       TEXT NOT NULL DEFAULT 'monica/gh-{github_issue_number}-mon-{monica_number}-{slug}',
      setup_timeout_sec     INTEGER NOT NULL DEFAULT 600,
      agent_default         TEXT NOT NULL DEFAULT 'claude',
      agent_permission_mode TEXT NOT NULL DEFAULT 'plan',
      hooks_claude          INTEGER NOT NULL DEFAULT 1,
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

/// v3: run-id counter. Mirrors `mon_counter` so each run gets a monotonic `run-<n>` id that is
/// never reused, keeping the `runs/<task_run_id>/` artifact directories collision-free.
const V3: &str = r#"
    CREATE TABLE run_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);
"#;

/// v4: drop the per-project branch-name template. Branch names are now derived directly from the
/// run (`issue-<n>` for a linked GitHub issue, else `mon-<n>`), so the configurable rule is gone.
const V4: &str = r#"
    ALTER TABLE projects DROP COLUMN branch_template;
"#;

/// v5: rename the internal domain from WorkItem/Run to Task/TaskRun, split task state from run
/// state, and add minimal agent-session persistence. Existing MON ids and run-<n> ids stay stable.
const V5: &str = r#"
    ALTER TABLE work_items RENAME TO tasks;
    ALTER TABLE runs RENAME TO task_runs;
    ALTER TABLE run_counter RENAME TO task_run_counter;

    ALTER TABLE task_runs RENAME COLUMN work_item_id TO task_id;
    ALTER TABLE events RENAME COLUMN work_item_id TO task_id;
    ALTER TABLE events RENAME COLUMN run_id TO task_run_id;
    ALTER TABLE external_refs RENAME COLUMN work_item_id TO task_id;

    INSERT INTO task_runs (id, task_id, status, created_at, updated_at)
    SELECT 'legacy-' || t.id,
           t.id,
           t.status,
           strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM tasks t
     WHERE t.status IN ('setting_up', 'running', 'stopped')
       AND (
             NOT EXISTS (
               SELECT 1
                 FROM task_runs r
                WHERE r.task_id = t.id
             )
             OR (
               SELECT r.status
                 FROM task_runs r
                WHERE r.task_id = t.id
                ORDER BY r.created_at DESC,
                         CAST(SUBSTR(r.id, 5) AS INTEGER) DESC
                LIMIT 1
             ) != t.status
           );

    UPDATE tasks
       SET status = 'active'
     WHERE status IN ('setting_up', 'running', 'stopped');

    CREATE TABLE agent_session_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE agent_sessions (
      id                  TEXT PRIMARY KEY,
      task_id             TEXT NOT NULL REFERENCES tasks(id),
      task_run_id         TEXT NOT NULL REFERENCES task_runs(id),
      agent               TEXT NOT NULL,
      mode                TEXT NOT NULL,
      status              TEXT NOT NULL,
      provider_session_id TEXT,
      parent_session_id   TEXT,
      last_event_name     TEXT,
      last_event_at       TEXT,
      metadata_json       TEXT NOT NULL DEFAULT '{}',
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
	"#;

/// v6: make Task status product-level only, collapse AgentSession observation fields into
/// TaskRun, add waiting-for-user run state, and replace archived with soft deletion.
const V6: &str = r#"
    ALTER TABLE tasks ADD COLUMN deleted_at TEXT;

    ALTER TABLE task_runs ADD COLUMN wait_reason TEXT;
    ALTER TABLE task_runs ADD COLUMN provider_session_id TEXT;
    ALTER TABLE task_runs ADD COLUMN last_event_name TEXT;
    ALTER TABLE task_runs ADD COLUMN last_event_at TEXT;
    ALTER TABLE task_runs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

    UPDATE task_runs
       SET provider_session_id = (
             SELECT s.provider_session_id
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
              ORDER BY s.updated_at DESC,
                       CAST(SUBSTR(s.id, 9) AS INTEGER) DESC
              LIMIT 1
           ),
           last_event_name = (
             SELECT s.last_event_name
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
              ORDER BY s.updated_at DESC,
                       CAST(SUBSTR(s.id, 9) AS INTEGER) DESC
              LIMIT 1
           ),
           last_event_at = (
             SELECT s.last_event_at
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
              ORDER BY s.updated_at DESC,
                       CAST(SUBSTR(s.id, 9) AS INTEGER) DESC
              LIMIT 1
           ),
           metadata_json = COALESCE((
             SELECT s.metadata_json
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
              ORDER BY s.updated_at DESC,
                       CAST(SUBSTR(s.id, 9) AS INTEGER) DESC
              LIMIT 1
           ), metadata_json)
     WHERE EXISTS (
             SELECT 1
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
           );

    INSERT INTO task_runs (id, task_id, status, wait_reason, created_at, updated_at)
    SELECT 'legacy-' || t.id,
           t.id,
           CASE
             WHEN t.status = 'need_approval' THEN 'waiting_for_user'
             ELSE 'failed'
           END,
           CASE
             WHEN t.status = 'need_approval' THEN 'exit_plan_mode'
             ELSE NULL
           END,
           strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM tasks t
     WHERE t.status IN ('need_approval', 'failed')
       AND NOT EXISTS (
             SELECT 1
               FROM task_runs r
              WHERE r.task_id = t.id
           );

    UPDATE task_runs
       SET status = 'waiting_for_user',
           wait_reason = 'exit_plan_mode',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id IN (
       SELECT latest.id
         FROM tasks t
         JOIN task_runs latest
           ON latest.id = (
             SELECT r.id
               FROM task_runs r
              WHERE r.task_id = t.id
              ORDER BY r.created_at DESC,
                       CAST(SUBSTR(r.id, 5) AS INTEGER) DESC
              LIMIT 1
           )
        WHERE t.status = 'need_approval'
     );

    UPDATE task_runs
       SET status = 'failed',
           wait_reason = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id IN (
       SELECT latest.id
         FROM tasks t
         JOIN task_runs latest
           ON latest.id = (
             SELECT r.id
               FROM task_runs r
              WHERE r.task_id = t.id
              ORDER BY r.created_at DESC,
                       CASE
                         WHEN r.id GLOB 'run-[0-9]*' THEN CAST(SUBSTR(r.id, 5) AS INTEGER)
                         ELSE -1
                       END DESC,
                       r.id DESC
              LIMIT 1
           )
        WHERE t.status = 'failed'
     );

    UPDATE tasks
       SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE status = 'archived'
       AND deleted_at IS NULL;

    UPDATE tasks
       SET status = CASE
         WHEN status = 'inbox' THEN 'inbox'
         WHEN status = 'ready' THEN 'ready'
         WHEN status = 'done' THEN 'done'
         ELSE 'in_progress'
       END
     WHERE status IN (
       'active',
       'need_approval',
       'failed',
       'pr_open',
       'archived',
       'setting_up',
       'running',
       'stopped'
     );

    DROP TABLE agent_sessions;
    DROP TABLE agent_session_counter;
"#;

/// v7: persist linked GitHub PR sync state so the dashboard can show PR refs without polling
/// GitHub from the task list path.
const V7: &str = r#"
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
"#;

/// v8: store lightweight GitHub PR state for dashboard display.
const V8: &str = r#"
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

    UPDATE external_ref_syncs
       SET last_synced_at = NULL,
           last_error = NULL,
           next_retry_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE target_ref_type = 'github_pull_request'
       AND EXISTS (
             SELECT 1
               FROM external_refs pr
              WHERE pr.task_id = external_ref_syncs.task_id
                AND pr.ref_type = 'github_pull_request'
           );
"#;

/// v9: track branch-driven GitHub PR discovery independently from issue-linked sync state.
const V9: &str = r#"
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
"#;

/// v10: terminal workspace/tab persistence for Work Bench.
const V10: &str = r#"
    CREATE TABLE terminal_workspaces (
      id         TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE terminal_tabs (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES terminal_workspaces(id) ON DELETE CASCADE,
      cwd          TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      sort_order   INTEGER NOT NULL DEFAULT 0,
      is_active    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX terminal_tabs_workspace_idx ON terminal_tabs(workspace_id, sort_order);
"#;

/// v11: rename workspace → runspace (tables, columns, indexes).
const V11: &str = r#"
    ALTER TABLE terminal_workspaces RENAME TO terminal_runspaces;
    ALTER TABLE terminal_tabs RENAME COLUMN workspace_id TO runspace_id;
    DROP INDEX terminal_tabs_workspace_idx;
    CREATE INDEX terminal_tabs_runspace_idx ON terminal_tabs(runspace_id, sort_order);
"#;

/// v12: junction table linking a Task to its Workbench Runspace.
const V12: &str = r#"
    CREATE TABLE "_TaskToRunspace" (
      task_id    TEXT PRIMARY KEY NOT NULL,
      runspace_id TEXT NOT NULL UNIQUE,
      cwd        TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

/// v13: add primary_task_run_id to tasks for explicit "Main Run" designation.
const V13: &str = r#"
    ALTER TABLE tasks ADD COLUMN primary_task_run_id TEXT;
"#;

/// v14: record which Workbench terminal tab a run's Claude session lives in.
const V14: &str = r#"
    ALTER TABLE task_runs ADD COLUMN terminal_tab_id TEXT;
"#;

/// v15: indexes for the hook-path lookups that now run on every Claude hook event
/// (session resolution) and on cmd+g / the tab indicator (tab resolution).
const V15: &str = r#"
    CREATE INDEX task_runs_task_session_idx ON task_runs(task_id, provider_session_id);
    CREATE INDEX task_runs_terminal_tab_idx ON task_runs(terminal_tab_id);
"#;

/// v16: durable terminal sessions owned by the PTY daemon. Tabs reference a session via
/// `terminal_tabs.terminal_session_id` instead of doubling as the PTY id. No FKs:
/// `save_terminal_state` rewrites runspaces/tabs wholesale (DELETE + reinsert), so hard
/// references would break on every layout save; reconcile owns consistency instead.
const V16: &str = r#"
    CREATE TABLE terminal_session_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE terminal_sessions (
      id              TEXT PRIMARY KEY,
      runspace_id     TEXT,
      tab_id          TEXT,
      kind            TEXT NOT NULL DEFAULT 'shell',
      cwd             TEXT NOT NULL,
      shell           TEXT NOT NULL,
      status          TEXT NOT NULL,
      pid             INTEGER,
      rows            INTEGER NOT NULL,
      cols            INTEGER NOT NULL,
      transcript_path TEXT,
      exit_code       INTEGER,
      started_at      TEXT,
      last_seen_at    TEXT,
      exited_at       TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX terminal_sessions_runspace_idx ON terminal_sessions(runspace_id, status);

    ALTER TABLE terminal_tabs ADD COLUMN terminal_session_id TEXT;
"#;

/// v17: drop vestigial is_active columns; active selection moved to the Tauri store.
const V17: &str = r#"
    ALTER TABLE terminal_runspaces DROP COLUMN is_active;
    ALTER TABLE terminal_tabs DROP COLUMN is_active;
"#;

/// v18: drop external_ref_syncs; PR sync state lives in github_pull_request_ref_states (v8)
/// and github_pull_request_branch_syncs (v9), and nothing ever read this table back.
const V18: &str = r#"
    DROP TABLE external_ref_syncs;
"#;

/// v19: retire the inbox status — tracking an issue creates tasks as ready, so inbox was an
/// unreachable parking lot. The enum variant is gone, so any surviving row must move or it
/// would fail to parse.
const V19: &str = r#"
    UPDATE tasks
       SET status = 'ready', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE status = 'inbox';
"#;

/// v20: run settlement resolves sessions by tab (latest per tab) on every terminal death and
/// reconcile sweep; the table only grows (rows are never deleted), so the lookup needs an index.
const V20: &str = r#"
    CREATE INDEX terminal_sessions_tab_idx ON terminal_sessions(tab_id, created_at);
"#;

/// v21: unify done and soft-delete into a single closed concept. The `deleted_at` column becomes
/// `closed_at` — a record-only timestamp, no longer a hard filter — and both the old `done` status
/// and old soft-deleted rows collapse into `status = 'closed'` with a synced `closed_at`.
const V21: &str = r#"
    ALTER TABLE tasks RENAME COLUMN deleted_at TO closed_at;

    UPDATE tasks
       SET status = 'closed'
     WHERE status = 'done' OR closed_at IS NOT NULL;

    UPDATE tasks
       SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE status = 'closed' AND closed_at IS NULL;
"#;

/// v22: count of subagents (Task tool) running under a run's Claude session. A `Stop` hook fires
/// at the end of the parent's turn even while a subagent is still working; this counter lets the
/// lifecycle keep the run `Running` instead of flickering to "your turn" until the subagent ends.
const V22: &str = r#"
    ALTER TABLE task_runs ADD COLUMN active_subagents INTEGER NOT NULL DEFAULT 0;
"#;

/// v23: Text & Memory artifact foundation for the first Personal Space vertical slice.
/// The original text lives in `artifacts`; links and derived relationships are stored separately
/// so promotion from Record to Intent Seed never overwrites the source record.
const V23: &str = r#"
    CREATE TABLE artifact_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE artifacts (
      id                 TEXT PRIMARY KEY,
      space              TEXT NOT NULL CHECK(space IN ('personal')),
      artifact_type      TEXT NOT NULL CHECK(artifact_type IN ('journal', 'essay', 'record', 'intent_seed')),
      title              TEXT,
      body               TEXT NOT NULL DEFAULT '',
      status             TEXT,
      source_artifact_id TEXT REFERENCES artifacts(id),
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted_at         TEXT
    );

    CREATE INDEX artifacts_space_type_updated_idx
      ON artifacts(space, artifact_type, updated_at);

    CREATE TABLE artifact_links (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      from_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      to_artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      kind             TEXT NOT NULL CHECK(kind IN ('derived_from', 'related')),
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(from_artifact_id, to_artifact_id, kind)
    );

    CREATE INDEX artifact_links_from_idx ON artifact_links(from_artifact_id);
    CREATE INDEX artifact_links_to_idx ON artifact_links(to_artifact_id);
"#;

/// Apply any pending migrations. Idempotent: a fully-migrated database is a no-op.
pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    migrations()
        .to_latest(conn)
        .context("failed to apply database migrations")
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_core::{
        DisplayStatus, EventRepository, NewTaskRun, ProjectRepository, TaskRepository,
        TaskRunRepository, TaskRunStatus, TaskRunWaitReason, TaskStatus, TaskSummaryFilter,
    };
    use rusqlite::params;

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monica-mig-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let _ = std::fs::remove_file(&path);
        path
    }

    /// Apply the first `n` migrations, staging the historical schema a compat test starts from.
    fn stage_through(conn: &mut Connection, n: usize) {
        let steps: Vec<M<'static>> = migration_steps().into_iter().take(n).collect();
        Migrations::new(steps).to_latest(conn).unwrap();
    }

    #[test]
    fn migration_set_is_valid() {
        migrations().validate().expect("migrations should validate");
    }

    /// A project row written under the v3 schema (which still has `branch_template`) must survive
    /// the v4 `DROP COLUMN` and stay readable through `Db`/`Project::from_row` afterwards. `Db` has
    /// no constructor from an existing connection, so the v3 state is staged on disk and reopened
    /// via `Db::open_at`, which runs the pending v4 migration on that existing data.
    #[test]
    fn v4_drops_branch_template_and_preserves_v3_rows() {
        let path = temp_db_path("v4");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 3);
            conn.execute(
                "INSERT INTO projects (id, name, repo, path, branch_template)
                 VALUES ('o/r', 'r', 'o/r', '/tmp/r', 'monica/{slug}')",
                [],
            )
            .unwrap();
        }

        let db = crate::sqlite::SqliteStore::open_at(&path).unwrap();
        let project = db
            .get_project("o/r")
            .unwrap()
            .expect("v3 row must survive the v4 migration and read back via Project::from_row");
        assert_eq!(project.id, "o/r");
        assert_eq!(project.path.as_deref(), Some("/tmp/r"));

        let has_column: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM pragma_table_info('projects') WHERE name = 'branch_template'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 0, "branch_template column must be dropped");

        let version: i64 = db
            .conn()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, migration_steps().len() as i64);

        std::fs::remove_file(&path).ok();
    }

    /// Runspace/tab rows written under the v16 schema (which still has `is_active`) must survive
    /// the v17 `DROP COLUMN` and read back via `load_terminal_state`.
    #[test]
    fn v17_drops_is_active_and_preserves_rows() {
        let path = temp_db_path("v17");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 16);
            conn.execute(
                "INSERT INTO terminal_runspaces (id, sort_order, is_active)
                 VALUES ('rs-1', 0, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO terminal_tabs
                   (id, runspace_id, cwd, title, sort_order, is_active, terminal_session_id)
                 VALUES ('tab-1', 'rs-1', '/tmp', 'tab', 0, 1, 'ts-1')",
                [],
            )
            .unwrap();
        }

        let db = crate::sqlite::SqliteStore::open_at(&path).unwrap();
        let snapshot = db.load_terminal_state().unwrap();
        assert_eq!(snapshot.runspaces.len(), 1);
        assert_eq!(snapshot.runspaces[0].id, "rs-1");
        assert_eq!(snapshot.runspaces[0].tabs[0].id, "tab-1");
        assert_eq!(
            snapshot.runspaces[0].tabs[0].terminal_session_id.as_deref(),
            Some("ts-1")
        );

        for table in ["terminal_runspaces", "terminal_tabs"] {
            let has_column: i64 = db
                .conn()
                .query_row(
                    &format!(
                        "SELECT count(*) FROM pragma_table_info('{table}') WHERE name = 'is_active'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has_column, 0, "{table}.is_active must be dropped");
        }

        std::fs::remove_file(&path).ok();
    }

    /// A database carrying v7-era external_ref_syncs rows must migrate through the v18 DROP
    /// without error and end at the latest user_version.
    #[test]
    fn v18_drops_external_ref_syncs() {
        let path = temp_db_path("v18");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 17);
            conn.execute(
                "INSERT INTO tasks (id, kind, status, title) VALUES ('mon-1', 'dev', 'inbox', 't')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO external_refs (task_id, ref_type, repo, number)
                 VALUES ('mon-1', 'github_issue', 'o/r', 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO external_ref_syncs (task_id, source_ref_id, target_ref_type)
                 VALUES ('mon-1', 1, 'github_pull_request')",
                [],
            )
            .unwrap();
        }

        let db = crate::sqlite::SqliteStore::open_at(&path).unwrap();
        let has_table: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'external_ref_syncs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_table, 0, "external_ref_syncs must be dropped");

        let version: i64 = db
            .conn()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, migration_steps().len() as i64);

        std::fs::remove_file(&path).ok();
    }

    /// Inbox rows written under the v18 schema must land as `ready` after v19, while every
    /// other status is left untouched; the Inbox enum variant no longer exists to parse them.
    #[test]
    fn v19_moves_inbox_tasks_to_ready() {
        let path = temp_db_path("v19");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 18);
            conn.execute_batch(
                "INSERT INTO tasks (id, kind, status, title) VALUES
                   ('mon-1', 'development', 'inbox', 'parked'),
                   ('mon-2', 'development', 'done', 'finished'),
                   ('mon-3', 'development', 'in_progress', 'active');",
            )
            .unwrap();
        }

        let db = crate::sqlite::SqliteStore::open_at(&path).unwrap();
        let status_of = |id: &str| -> String {
            db.conn()
                .query_row(
                    "SELECT status FROM tasks WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(status_of("mon-1"), "ready");
        // v21 (applied by open_at → to_latest) folds the old `done` status into `closed`.
        assert_eq!(status_of("mon-2"), "closed");
        assert_eq!(status_of("mon-3"), "in_progress");

        // The migrated row must read back through the repository (TaskStatus::Inbox is gone).
        let task = db.get_task("mon-1").unwrap().unwrap();
        assert_eq!(task.status, TaskStatus::Ready);

        std::fs::remove_file(&path).ok();
    }

    /// v21 collapses the old `done` status and old soft-deleted rows into a single `closed`
    /// status, renames `deleted_at` to `closed_at`, and backfills `closed_at` so it stays in sync.
    #[test]
    fn v21_unifies_done_and_soft_delete_into_closed() {
        let path = temp_db_path("v21");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 20);
            conn.execute_batch(
                "INSERT INTO tasks (id, kind, status, title) VALUES
                   ('mon-done', 'development', 'done', 'finished'),
                   ('mon-active', 'development', 'in_progress', 'active');
                 INSERT INTO tasks (id, kind, status, title, deleted_at) VALUES
                   ('mon-deleted', 'development', 'in_progress', 'removed', '2026-01-02T03:04:05.000Z');",
            )
            .unwrap();
        }

        let db = crate::sqlite::SqliteStore::open_at(&path).unwrap();
        let row = |id: &str| -> (String, Option<String>) {
            db.conn()
                .query_row(
                    "SELECT status, closed_at FROM tasks WHERE id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap()
        };

        let (done_status, done_closed_at) = row("mon-done");
        assert_eq!(done_status, "closed");
        assert!(done_closed_at.is_some(), "old done row must get a closed_at");

        let (deleted_status, deleted_closed_at) = row("mon-deleted");
        assert_eq!(deleted_status, "closed");
        assert_eq!(deleted_closed_at.as_deref(), Some("2026-01-02T03:04:05.000Z"));

        let (active_status, active_closed_at) = row("mon-active");
        assert_eq!(active_status, "in_progress");
        assert!(active_closed_at.is_none());

        // The closed row must read back through the repository (no hard filter hides it).
        let task = db.get_task("mon-done").unwrap().unwrap();
        assert_eq!(task.status, TaskStatus::Closed);
        assert!(task.closed_at.is_some());

        std::fs::remove_file(&path).ok();
    }

    /// Tab rows written under the v15 schema must survive the v16 ALTER TABLE and read back
    /// with a NULL `terminal_session_id`, and the new session tables must exist.
    #[test]
    fn v16_adds_terminal_sessions_and_preserves_v15_tabs() {
        let path = temp_db_path("v16");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 15);
            conn.execute(
                "INSERT INTO terminal_runspaces (id, sort_order, is_active)
                 VALUES ('rs-1', 0, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO terminal_tabs (id, runspace_id, cwd, title, sort_order, is_active)
                 VALUES ('tab-1', 'rs-1', '/tmp', 'tab', 0, 1)",
                [],
            )
            .unwrap();
        }

        let db = crate::sqlite::SqliteStore::open_at(&path).unwrap();
        let snapshot = db.load_terminal_state().unwrap();
        assert_eq!(snapshot.runspaces.len(), 1);
        assert_eq!(snapshot.runspaces[0].tabs[0].id, "tab-1");
        assert_eq!(snapshot.runspaces[0].tabs[0].terminal_session_id, None);

        let session_table: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM sqlite_master
                  WHERE type = 'table' AND name = 'terminal_sessions'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(session_table, 1);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn v5_v6_renames_task_schema_and_preserves_old_rows() {
        let path = temp_db_path("v5");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 4);

            for status in ["setting_up", "running", "stopped", "failed", "ready"] {
                let id = format!("MON-{}", status.replace('_', "-"));
                conn.execute(
                    "INSERT INTO work_items (id, kind, status, title, body)
                     VALUES (?1, 'development', ?2, ?3, '')",
                    params![id, status, status],
                )
                .unwrap();
            }
            conn.execute("INSERT INTO run_counter DEFAULT VALUES", [])
                .unwrap();
            conn.execute(
                "INSERT INTO runs (id, work_item_id, agent, branch, worktree_path, status)
                 VALUES ('run-1', 'MON-running', 'claude', 'issue-9', '/tmp/wt', 'running')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO runs
                   (id, work_item_id, agent, branch, worktree_path, status, created_at, updated_at)
                 VALUES
                   ('run-99', 'MON-stopped', 'claude', 'issue-99', '/tmp/stale', 'running',
                    '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events (work_item_id, run_id, kind, payload_json)
                 VALUES ('MON-running', 'run-1', 'claude_hook', '{\"hook_event_name\":\"Stop\"}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO external_refs (work_item_id, ref_type, repo, number, url)
                 VALUES ('MON-running', 'github_issue', 'o/r', 9, 'https://example.com/9')",
                [],
            )
            .unwrap();
        }

        let mut db = crate::sqlite::SqliteStore::open_at(&path).unwrap();
        for old in ["work_items", "runs", "run_counter"] {
            let count: i64 = db
                .conn()
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![old],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0, "{old} must be renamed away");
        }

        assert_eq!(
            db.get_task("MON-setting-up").unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert_eq!(
            db.get_task("MON-running").unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert_eq!(
            db.get_task("MON-stopped").unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert_eq!(
            db.get_task("MON-failed").unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert_eq!(
            db.get_task("MON-ready").unwrap().unwrap().status,
            TaskStatus::Ready
        );

        let run = db.get_task_run("run-1").unwrap().unwrap();
        assert_eq!(run.task_id, "MON-running");
        assert_eq!(run.status, TaskRunStatus::Running);
        assert!(
            db.get_task_run("legacy-MON-running").unwrap().is_none(),
            "tasks with an existing matching run do not need a synthetic lifecycle run"
        );
        let stale_run = db.get_task_run("run-99").unwrap().unwrap();
        assert_eq!(stale_run.task_id, "MON-stopped");
        assert_eq!(stale_run.status, TaskRunStatus::Running);

        let setup_run = db.get_task_run("legacy-MON-setting-up").unwrap().unwrap();
        assert_eq!(setup_run.task_id, "MON-setting-up");
        assert_eq!(setup_run.status, TaskRunStatus::SettingUp);
        let stopped_run = db.get_task_run("legacy-MON-stopped").unwrap().unwrap();
        assert_eq!(stopped_run.task_id, "MON-stopped");
        assert_eq!(stopped_run.status, TaskRunStatus::Stopped);

        let stopped_rows = db
            .list_task_summaries(TaskSummaryFilter::Status(DisplayStatus::Stopped), None)
            .unwrap();
        assert_eq!(
            stopped_rows
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["MON-stopped"],
            "legacy stopped tasks without runs must survive display-status filters"
        );

        let events = db.list_events(Some("MON-running")).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].task_id.as_deref(), Some("MON-running"));
        assert_eq!(events[0].task_run_id.as_deref(), Some("run-1"));

        let refs = db.list_external_refs("MON-running").unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].task_id, "MON-running");

        let next = db
            .start_task_run(NewTaskRun {
                task_id: "MON-ready".to_string(),
                agent: None,
                branch: None,
                worktree_path: None,
            })
            .unwrap();
        assert_eq!(next.id, "run-2");

        for table in ["agent_session_counter", "agent_sessions"] {
            let count: i64 = db
                .conn()
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0, "{table} must be collapsed into task_runs");
        }

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn v6_collapses_agent_sessions_and_soft_deletes_archived_tasks() {
        let path = temp_db_path("v6-agent-sessions");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 5);

            for (id, status) in [
                ("MON-wait", "need_approval"),
                ("MON-wait-no-run", "need_approval"),
                ("MON-failed-no-run", "failed"),
                ("MON-failed-run", "failed"),
                ("MON-archived", "archived"),
                ("MON-pr", "pr_open"),
            ] {
                conn.execute(
                    "INSERT INTO tasks (id, kind, status, title)
                     VALUES (?1, 'development', ?2, ?1)",
                    params![id, status],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO task_runs
                   (id, task_id, status, created_at, updated_at)
                 VALUES
                   ('run-10', 'MON-wait', 'stopped',
                    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                   ('run-11', 'MON-wait', 'running',
                    '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
                   ('run-12', 'MON-failed-run', 'running',
                    '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_sessions
                   (id, task_id, task_run_id, agent, mode, status, provider_session_id,
                    last_event_name, last_event_at, metadata_json, updated_at)
                 VALUES
                   ('session-1', 'MON-wait', 'run-11', 'claude', 'new', 'running',
                    'provider-old', 'SessionStart', '2026-01-02T00:00:01.000Z',
                    '{\"version\":1}', '2026-01-02T00:00:01.000Z'),
                   ('session-2', 'MON-wait', 'run-11', 'claude', 'new', 'running',
                    'provider-new', 'PreToolUse', '2026-01-02T00:00:02.000Z',
                    '{\"version\":2}', '2026-01-02T00:00:02.000Z')",
                [],
            )
            .unwrap();
        }

        let db = crate::sqlite::SqliteStore::open_at(&path).unwrap();

        assert_eq!(
            db.get_task("MON-wait").unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert_eq!(
            db.get_task("MON-pr").unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        // v21 (applied by open_at → to_latest) folds the v6 soft-delete into `closed`, which is
        // a visible archive — the old "hidden from normal reads" guarantee no longer holds.
        assert_eq!(
            db.get_task("MON-archived").unwrap().unwrap().status,
            TaskStatus::Closed
        );

        let archived: (String, Option<String>) = db
            .conn()
            .query_row(
                "SELECT status, closed_at FROM tasks WHERE id = 'MON-archived'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(archived.0, TaskStatus::Closed.as_str());
        assert!(archived.1.is_some());

        let wait_run = db.get_task_run("run-11").unwrap().unwrap();
        assert_eq!(wait_run.status, TaskRunStatus::WaitingForUser);
        assert_eq!(wait_run.wait_reason, Some(TaskRunWaitReason::ExitPlanMode));
        assert_eq!(
            wait_run.provider_session_id.as_deref(),
            Some("provider-new")
        );
        assert_eq!(wait_run.last_event_name.as_deref(), Some("PreToolUse"));
        assert_eq!(wait_run.metadata["version"].as_i64(), Some(2));

        let legacy_wait = db.get_task_run("legacy-MON-wait-no-run").unwrap().unwrap();
        assert_eq!(legacy_wait.status, TaskRunStatus::WaitingForUser);
        assert_eq!(
            legacy_wait.wait_reason,
            Some(TaskRunWaitReason::ExitPlanMode)
        );
        let legacy_failed = db
            .get_task_run("legacy-MON-failed-no-run")
            .unwrap()
            .unwrap();
        assert_eq!(legacy_failed.status, TaskRunStatus::Failed);
        assert_eq!(legacy_failed.wait_reason, None);
        let failed_run = db.get_task_run("run-12").unwrap().unwrap();
        assert_eq!(failed_run.status, TaskRunStatus::Failed);

        let visible = db.list_task_summaries(TaskSummaryFilter::All, None).unwrap();
        assert_eq!(
            visible
                .iter()
                .find(|row| row.id == "MON-archived")
                .unwrap()
                .status,
            DisplayStatus::Closed,
            "v21 surfaces the closed archive in the All summary"
        );
        assert_eq!(
            visible
                .iter()
                .find(|row| row.id == "MON-wait-no-run")
                .unwrap()
                .status,
            DisplayStatus::WaitingForUser
        );
        assert_eq!(
            visible
                .iter()
                .find(|row| row.id == "MON-failed-no-run")
                .unwrap()
                .status,
            DisplayStatus::Failed
        );

        let dropped: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dropped, 0);

        std::fs::remove_file(&path).ok();
    }
}
