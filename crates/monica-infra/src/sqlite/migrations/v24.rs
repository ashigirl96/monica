/// v24: drop Library/Artifact tables (library_entries, library_attachments, counters).
pub(super) const SQL: &str = r#"
    DROP TABLE IF EXISTS library_attachments;
    DROP TABLE IF EXISTS library_entries;
    DROP TABLE IF EXISTS attachment_counter;
    DROP TABLE IF EXISTS artifact_counter;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::{assert_table_absent, stage_through};
    use rusqlite::Connection;

    #[test]
    fn drops_library_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 23);
        conn.execute_batch(super::SQL).unwrap();

        for table in [
            "library_entries",
            "library_attachments",
            "artifact_counter",
            "attachment_counter",
        ] {
            assert_table_absent(&conn, table);
        }
    }
}
