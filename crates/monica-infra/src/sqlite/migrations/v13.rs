/// v13: add primary_task_run_id to tasks for explicit "Main Run" designation.
pub(super) const SQL: &str = r#"
    ALTER TABLE tasks ADD COLUMN primary_task_run_id TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn adds_primary_task_run_id_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 12);
        conn.execute_batch(super::SQL).unwrap();

        let has_column: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('tasks') WHERE name = 'primary_task_run_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 1);
    }
}
