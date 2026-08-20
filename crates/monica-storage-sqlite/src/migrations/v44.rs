/// v44: drop `tasks.memo`. The alt+M per-task memo feature (added in v34) was removed
/// end-to-end, so the column no longer has readers or writers.
pub(super) const SQL: &str = r#"
    ALTER TABLE tasks DROP COLUMN memo;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_absent, stage_through};
    use rusqlite::Connection;

    #[test]
    fn drops_memo_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 43);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_absent(&conn, "tasks", "memo");
    }
}
