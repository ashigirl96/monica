/// v25: remember when a `Stop` was blocked by the subagent guard. When the last `SubagentStop`
/// brings `active_subagents` to 0, the deferred `Stop → WaitingForUser` transition fires
/// atomically inside the same UPDATE, preventing the run from staying stuck at `Running`.
pub(super) const SQL: &str = r#"
    ALTER TABLE task_runs ADD COLUMN pending_stop INTEGER NOT NULL DEFAULT 0;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_pending_stop_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 24);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "task_runs", "pending_stop");
    }
}
