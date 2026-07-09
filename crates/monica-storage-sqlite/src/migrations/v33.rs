/// v33: track the Claude Code session id on the terminal session so any tab can expose it
/// (e.g. for `claude --resume`). Set by hooks alongside `agent_status`; cleared on SessionEnd.
pub(super) const SQL: &str = r#"
    ALTER TABLE terminal_sessions ADD COLUMN provider_session_id TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_provider_session_id() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 32);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "terminal_sessions", "provider_session_id");
    }
}
