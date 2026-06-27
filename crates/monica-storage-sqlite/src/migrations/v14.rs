/// v14: record which Workbench terminal tab a run's Claude session lives in.
pub(super) const SQL: &str = r#"
    ALTER TABLE task_runs ADD COLUMN terminal_tab_id TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_terminal_tab_id_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 13);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "task_runs", "terminal_tab_id");
    }
}
