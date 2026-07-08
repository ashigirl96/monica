/// v31: drop `task_runs.settings_path`. The column recorded where the agent hooks config was
/// written, but nothing ever read it back — the wrapper era that consumed it via
/// `MONICA_CLAUDE_SETTINGS_PATH` is long gone (agents now load hooks from the cwd config
/// themselves).
pub(super) const SQL: &str = r#"
    ALTER TABLE task_runs DROP COLUMN settings_path;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn drops_settings_path_and_preserves_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 30);

        conn.execute(
            "INSERT INTO tasks (id, kind, status, title) VALUES ('t-1', 'dev', 'backlog', 'x')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_runs (id, task_id, status, settings_path)
             VALUES ('run-1', 't-1', 'setting_up', '/tmp/settings.json')",
            [],
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        let has_column: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('task_runs') WHERE name = 'settings_path'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 0);

        let status: String = conn
            .query_row("SELECT status FROM task_runs WHERE id = 'run-1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "setting_up");
    }
}
