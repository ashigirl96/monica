/// v51: Runs the Workbench has yet to open as an agent tab. The tab layout is owned by the
/// desktop's frontend, so a Run requested from another process (`monica task run`) can only reach
/// the screen through a row the desktop polls — the same route `monica task attach` takes via
/// `task_runs.terminal_tab_id`. One row per run: re-running a still-prepared run or resuming a
/// stopped one replaces the earlier request rather than queueing a second tab.
pub(super) const SQL: &str = r#"
    CREATE TABLE task_run_launches (
      task_run_id     TEXT PRIMARY KEY,
      task_id         TEXT NOT NULL,
      runspace_id     TEXT NOT NULL,
      cwd             TEXT NOT NULL,
      env_json        TEXT NOT NULL,
      initial_command TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, assert_table_exists, stage_through};
    use rusqlite::Connection;

    fn staged() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 50);
        conn.execute_batch(super::SQL).unwrap();
        conn
    }

    #[test]
    fn creates_task_run_launches_table() {
        let conn = staged();
        assert_table_exists(&conn, "task_run_launches");
        for column in [
            "task_run_id",
            "task_id",
            "runspace_id",
            "cwd",
            "env_json",
            "initial_command",
            "created_at",
        ] {
            assert_column_exists(&conn, "task_run_launches", column);
        }
    }

    #[test]
    fn one_row_per_run() {
        let conn = staged();
        let insert = "INSERT INTO task_run_launches
                        (task_run_id, task_id, runspace_id, cwd, env_json, initial_command)
                      VALUES ('run-1', 'MON-1', 'bench-MON-1', '/wt', '[]', 'claude')";
        conn.execute_batch(insert).unwrap();
        assert!(conn.execute_batch(insert).is_err(), "task_run_id must be unique");
    }
}
