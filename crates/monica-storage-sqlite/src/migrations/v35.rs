pub(super) const SQL: &str = r#"
    CREATE TABLE explanation_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE explanations (
        id                  TEXT PRIMARY KEY,
        title               TEXT NOT NULL,
        mode                TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id),
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_table_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_explanation_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 34);
        conn.execute_batch(super::SQL).unwrap();
        assert_table_exists(&conn, "explanation_counter");
        assert_table_exists(&conn, "explanations");
    }
}
