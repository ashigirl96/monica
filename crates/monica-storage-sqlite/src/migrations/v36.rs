/// v36: guard provider ownership while Claude hands a resumed session to its first prompt.
pub(super) const SQL: &str = r#"
    ALTER TABLE terminal_sessions ADD COLUMN provider_handoff_from TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_provider_handoff_source() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 35);
        conn.execute_batch(super::SQL).unwrap();

        assert_column_exists(&conn, "terminal_sessions", "provider_handoff_from");
    }
}
