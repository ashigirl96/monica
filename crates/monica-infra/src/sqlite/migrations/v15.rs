/// v15: indexes for the hook-path lookups that now run on every Claude hook event
/// (session resolution) and on cmd+g / the tab indicator (tab resolution).
pub(super) const SQL: &str = r#"
    CREATE INDEX task_runs_task_session_idx ON task_runs(task_id, provider_session_id);
    CREATE INDEX task_runs_terminal_tab_idx ON task_runs(terminal_tab_id);
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn creates_task_run_indexes() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 14);
        conn.execute_batch(super::SQL).unwrap();

        for idx in ["task_runs_task_session_idx", "task_runs_terminal_tab_idx"] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [idx],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "missing index: {idx}");
        }
    }
}
