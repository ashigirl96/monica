/// v34: add memo to tasks for free-form per-task notes.
pub(super) const SQL: &str = r#"
    ALTER TABLE tasks ADD COLUMN memo TEXT NOT NULL DEFAULT '';
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_memo_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 33);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "tasks", "memo");
    }
}
