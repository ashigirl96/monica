use anyhow::{Context, Result};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

/// Ordered schema migrations, tracked by `PRAGMA user_version` (rusqlite_migration
/// uses the list position as the version). Append an `M::up(...)` to add a version;
/// never reorder or remove existing entries, or already-migrated databases diverge.
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(V1),
        M::up(V2),
        M::up(V3),
        M::up(V4),
        M::up(V5),
        M::up(V6),
        M::up(V7),
    ])
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

/// Apply any pending migrations. Idempotent: a fully-migrated database is a no-op.
pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    migrations()
        .to_latest(conn)
        .context("failed to apply database migrations")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DisplayStatus, NewTaskRun, TaskRunStatus, TaskRunWaitReason, TaskStatus};
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
            Migrations::new(vec![M::up(V1), M::up(V2), M::up(V3)])
                .to_latest(&mut conn)
                .unwrap();
            conn.execute(
                "INSERT INTO projects (id, name, repo, path, branch_template)
                 VALUES ('o/r', 'r', 'o/r', '/tmp/r', 'monica/{slug}')",
                [],
            )
            .unwrap();
        }

        let db = crate::Db::open_at(&path).unwrap();
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
        assert_eq!(version, 7);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn v5_v6_renames_task_schema_and_preserves_old_rows() {
        let path = temp_db_path("v5");

        {
            let mut conn = Connection::open(&path).unwrap();
            Migrations::new(vec![M::up(V1), M::up(V2), M::up(V3), M::up(V4)])
                .to_latest(&mut conn)
                .unwrap();

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

        let mut db = crate::Db::open_at(&path).unwrap();
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
            .list_task_summaries(Some(DisplayStatus::Stopped), None)
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
            Migrations::new(vec![M::up(V1), M::up(V2), M::up(V3), M::up(V4), M::up(V5)])
                .to_latest(&mut conn)
                .unwrap();

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

        let db = crate::Db::open_at(&path).unwrap();

        assert_eq!(
            db.get_task("MON-wait").unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert_eq!(
            db.get_task("MON-pr").unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert!(
            db.get_task("MON-archived").unwrap().is_none(),
            "soft-deleted archived tasks should be hidden from normal reads"
        );

        let archived: (String, Option<String>) = db
            .conn()
            .query_row(
                "SELECT status, deleted_at FROM tasks WHERE id = 'MON-archived'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(archived.0, TaskStatus::InProgress.as_str());
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

        let visible = db.list_task_summaries(None, None).unwrap();
        assert!(
            visible.iter().all(|row| row.id != "MON-archived"),
            "soft-deleted tasks should not appear in dashboard/list summaries"
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
