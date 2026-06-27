/// v20: run settlement resolves sessions by tab (latest per tab) on every terminal death and
/// reconcile sweep; the table only grows (rows are never deleted), so the lookup needs an index.
pub(super) const SQL: &str = r#"
    CREATE INDEX terminal_sessions_tab_idx ON terminal_sessions(tab_id, created_at);
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_index_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn creates_terminal_sessions_tab_index() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 19);
        conn.execute_batch(super::SQL).unwrap();
        assert_index_exists(&conn, "terminal_sessions_tab_idx");
    }
}
