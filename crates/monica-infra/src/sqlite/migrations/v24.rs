/// v24: drop Library/Artifact tables (library_entries, library_attachments, counters).
pub(super) const SQL: &str = r#"
    DROP TABLE IF EXISTS library_attachments;
    DROP TABLE IF EXISTS library_entries;
    DROP TABLE IF EXISTS attachment_counter;
    DROP TABLE IF EXISTS artifact_counter;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
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
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0, "{table} must be dropped");
        }
    }
}
