pub(super) const SQL: &str = r#"
    ALTER TABLE notes ADD COLUMN deleted_at TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_deleted_at_column_to_notes() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 38);
        conn.execute("INSERT INTO notes (id) VALUES ('note-1')", []).unwrap();

        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "notes", "deleted_at");

        let deleted_at: Option<String> = conn
            .query_row("SELECT deleted_at FROM notes WHERE id = 'note-1'", [], |r| r.get(0))
            .unwrap();
        assert!(deleted_at.is_none());
    }
}
