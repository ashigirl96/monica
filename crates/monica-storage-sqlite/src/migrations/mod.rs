use anyhow::{Context, Result};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

macro_rules! migrations {
    ($($v:ident),+ $(,)?) => {
        $(mod $v;)+

        fn migration_steps() -> Vec<M<'static>> {
            vec![$(M::up($v::SQL)),+]
        }
    };
}

migrations!(
    v01, v02, v03, v04, v05,
    v06, v07, v08, v09, v10,
    v11, v12, v13, v14, v15,
    v16, v17, v18, v19, v20,
    v21, v22, v23, v24, v25,
    v26, v27, v28,
);

/// Apply any pending migrations. Idempotent: a fully-migrated database is a no-op.
pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    Migrations::new(migration_steps())
        .to_latest(conn)
        .context("failed to apply database migrations")
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub fn temp_db_path(name: &str) -> std::path::PathBuf {
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
    pub fn stage_through(conn: &mut Connection, n: usize) {
        let steps: Vec<M<'static>> = migration_steps().into_iter().take(n).collect();
        Migrations::new(steps).to_latest(conn).unwrap();
    }

    pub fn migration_count() -> usize {
        migration_steps().len()
    }

    pub fn assert_table_exists(conn: &Connection, table: &str) {
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "missing table: {table}");
    }

    pub fn assert_table_absent(conn: &Connection, table: &str) {
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "table should not exist: {table}");
    }

    pub fn assert_column_exists(conn: &Connection, table: &str, column: &str) {
        let count: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "{table}.{column} must exist");
    }

    pub fn assert_column_absent(conn: &Connection, table: &str, column: &str) {
        let count: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "{table}.{column} must not exist");
    }

    pub fn assert_index_exists(conn: &Connection, index: &str) {
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                [index],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "missing index: {index}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_application::{
        DisplayStatus, EventRepository, NewTaskRun, ProjectRepository, Provider, RefType,
        TaskBoardQuery, TaskRunStatus, TaskRunStore, TaskRunWaitReason, TaskStatus, TaskStore,
        TaskSummaryFilter,
    };
    use rusqlite::params;
    use test_support::*;

    #[test]
    fn migration_set_is_valid() {
        Migrations::new(migration_steps())
            .validate()
            .expect("migrations should validate");
    }

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

        let db = crate::SqliteStore::open_at(&path).unwrap();
        let project = db
            .get_project("o/r")
            .unwrap()
            .expect("v3 row must survive the v4 migration and read back via Project::from_row");
        assert_eq!(project.id, "o/r");
        assert_eq!(project.path.as_deref(), Some("/tmp/r"));

        assert_column_absent(db.conn(), "projects", "branch_template");

        let version: i64 = db
            .conn()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, migration_count() as i64);

        std::fs::remove_file(&path).ok();
    }

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

        let db = crate::SqliteStore::open_at(&path).unwrap();
        let snapshot = db.load_terminal_state().unwrap();
        assert_eq!(snapshot.runspaces.len(), 1);
        assert_eq!(snapshot.runspaces[0].id, "rs-1");
        assert_eq!(snapshot.runspaces[0].tabs[0].id, "tab-1");
        assert_eq!(
            snapshot.runspaces[0].tabs[0].terminal_session_id.as_deref(),
            Some("ts-1")
        );

        for table in ["terminal_runspaces", "terminal_tabs"] {
            assert_column_absent(db.conn(), table, "is_active");
        }

        std::fs::remove_file(&path).ok();
    }

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

        let db = crate::SqliteStore::open_at(&path).unwrap();
        assert_table_absent(db.conn(), "external_ref_syncs");

        let version: i64 = db
            .conn()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, migration_count() as i64);

        std::fs::remove_file(&path).ok();
    }

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

        let db = crate::SqliteStore::open_at(&path).unwrap();
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

        let task = db.get_task("mon-1").unwrap().unwrap();
        assert_eq!(task.status, TaskStatus::Ready);

        std::fs::remove_file(&path).ok();
    }

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

        let db = crate::SqliteStore::open_at(&path).unwrap();
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

        let task = db.get_task("mon-done").unwrap().unwrap();
        assert_eq!(task.status, TaskStatus::Closed);
        assert!(task.closed_at.is_some());

        std::fs::remove_file(&path).ok();
    }

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

        let db = crate::SqliteStore::open_at(&path).unwrap();
        let snapshot = db.load_terminal_state().unwrap();
        assert_eq!(snapshot.runspaces.len(), 1);
        assert_eq!(snapshot.runspaces[0].tabs[0].id, "tab-1");
        assert_eq!(snapshot.runspaces[0].tabs[0].terminal_session_id, None);

        assert_table_exists(db.conn(), "terminal_sessions");

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

        let mut db = crate::SqliteStore::open_at(&path).unwrap();
        for old in ["work_items", "runs", "run_counter"] {
            assert_table_absent(db.conn(), old);
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
            assert_table_absent(db.conn(), table);
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

        let db = crate::SqliteStore::open_at(&path).unwrap();

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
        let wait_metadata: serde_json::Value =
            serde_json::from_str(wait_run.metadata.as_str()).unwrap();
        assert_eq!(wait_metadata["version"].as_i64(), Some(2));

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

        assert_table_absent(db.conn(), "agent_sessions");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn v24_drops_library_tables() {
        let path = temp_db_path("v24");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 23);
            conn.execute(
                "INSERT INTO artifact_counter DEFAULT VALUES",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO library_entries (id, state, kind, body_markdown)
                 VALUES ('ART-1', 'draft', 'memo', 'hello')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO attachment_counter DEFAULT VALUES",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO library_attachments (id, entry_id, original_file_name, byte_size, relative_path)
                 VALUES ('ATT-1', 'ART-1', 'img.png', 3, 'ART-1/img.png')",
                [],
            )
            .unwrap();
        }

        let db = crate::SqliteStore::open_at(&path).unwrap();
        for table in [
            "library_entries",
            "library_attachments",
            "artifact_counter",
            "attachment_counter",
        ] {
            assert_table_absent(db.conn(), table);
        }

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn v28_rewrites_legacy_ref_types_and_reads_back_provider_agnostic() {
        let path = temp_db_path("v28");

        {
            let mut conn = Connection::open(&path).unwrap();
            stage_through(&mut conn, 27);
            conn.execute_batch(
                "INSERT INTO tasks (id, kind, status, title)
                   VALUES ('mon-1', 'development', 'ready', 't');
                 INSERT INTO external_refs (task_id, ref_type, repo, number)
                   VALUES ('mon-1', 'github_issue', 'o/r', 1),
                          ('mon-1', 'github_pull_request', 'o/r', 2);",
            )
            .unwrap();
        }

        // open_at applies v28; reading back exercises external_ref_from_row's provider/ref_type parse.
        let db = crate::SqliteStore::open_at(&path).unwrap();
        let refs = db.list_external_refs("mon-1").unwrap();
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().all(|r| r.provider == Provider::Github));
        assert_eq!(refs[0].ref_type, RefType::Issue);
        assert_eq!(refs[1].ref_type, RefType::PullRequest);

        std::fs::remove_file(&path).ok();
    }
}
