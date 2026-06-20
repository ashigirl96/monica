/// v13: add primary_task_run_id to tasks for explicit "Main Run" designation.
pub(super) const SQL: &str = r#"
    ALTER TABLE tasks ADD COLUMN primary_task_run_id TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_primary_task_run_id_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 12);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "tasks", "primary_task_run_id");
    }
}
