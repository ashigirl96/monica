/// v32: hook-observed agent state on terminal sessions, powering the per-tab indicator for any
/// Monica shell (task or not). Cleared (NULL) when no agent has reported or its session ended.
pub(super) const SQL: &str = r#"
    ALTER TABLE terminal_sessions ADD COLUMN agent_status TEXT;
    ALTER TABLE terminal_sessions ADD COLUMN agent_wait_reason TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_agent_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 31);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "terminal_sessions", "agent_status");
        assert_column_exists(&conn, "terminal_sessions", "agent_wait_reason");
    }
}
