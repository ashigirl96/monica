/// v26: drop the derived `active_subagents` counter. The subagent guard now reads each hook's
/// authoritative `background_tasks` list directly (see `subagents_in_flight_after`), so the
/// counter — which drifted whenever a `SubagentStart`/`SubagentStop` hook was dropped or fired
/// without its pair — is no longer needed.
pub(super) const SQL: &str = r#"
    ALTER TABLE task_runs DROP COLUMN active_subagents;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::{assert_column_absent, stage_through};
    use rusqlite::Connection;

    #[test]
    fn drops_active_subagents_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 25);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_absent(&conn, "task_runs", "active_subagents");
    }
}
