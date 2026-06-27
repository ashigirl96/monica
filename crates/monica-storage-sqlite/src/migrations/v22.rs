/// v22: count of subagents (Task tool) running under a run's Claude session. A `Stop` hook fires
/// at the end of the parent's turn even while a subagent is still working; this counter lets the
/// lifecycle keep the run `Running` instead of flickering to "your turn" until the subagent ends.
pub(super) const SQL: &str = r#"
    ALTER TABLE task_runs ADD COLUMN active_subagents INTEGER NOT NULL DEFAULT 0;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_active_subagents_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 21);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "task_runs", "active_subagents");
    }
}
