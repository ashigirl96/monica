/// v53: a closed task keeps no bench link, and the tab it was closed from is recorded as a hold so
/// the Workbench's teardown of the closed task's runspace spares it until its agent (or shell) is
/// done. The DELETE clears the links every close before this version left behind.
pub(super) const SQL: &str = r#"
    DELETE FROM "_TaskToRunspace"
     WHERE task_id IN (SELECT id FROM tasks WHERE status = 'closed');

    CREATE TABLE task_close_holds (
      task_id             TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      terminal_tab_id     TEXT NOT NULL,
      terminal_session_id TEXT NOT NULL,
      release_on          TEXT NOT NULL CHECK(release_on IN ('agent_exit', 'shell_exit')),
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, assert_table_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn drops_only_the_bench_links_of_closed_tasks() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 52);
        conn.execute_batch(
            r#"INSERT INTO tasks (id, kind, status, title) VALUES
                 ('MON-1', 'development', 'closed', 'done'),
                 ('MON-2', 'development', 'in_progress', 'live');
               INSERT INTO "_TaskToRunspace" (task_id, runspace_id, cwd) VALUES
                 ('MON-1', 'bench-MON-1', '/a'),
                 ('MON-2', 'bench-MON-2', '/b');"#,
        )
        .unwrap();
        conn.execute_batch(super::SQL).unwrap();

        let mut stmt = conn.prepare(r#"SELECT task_id FROM "_TaskToRunspace""#).unwrap();
        let remaining: Vec<String> =
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(remaining, vec!["MON-2".to_string()]);
    }

    #[test]
    fn creates_close_holds_that_reject_an_unknown_release() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 52);
        conn.execute_batch(super::SQL).unwrap();
        assert_table_exists(&conn, "task_close_holds");
        for column in ["task_id", "terminal_tab_id", "terminal_session_id", "release_on", "created_at"] {
            assert_column_exists(&conn, "task_close_holds", column);
        }
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status, title) VALUES ('MON-1', 'development', 'closed', 't')",
        )
        .unwrap();
        let insert = |release: &str| {
            conn.execute(
                "INSERT OR REPLACE INTO task_close_holds
                   (task_id, terminal_tab_id, terminal_session_id, release_on)
                 VALUES ('MON-1', 'tab-1', 'ts-1', ?1)",
                [release],
            )
        };
        assert!(insert("agent_exit").is_ok());
        assert!(insert("whenever").is_err());
    }
}
