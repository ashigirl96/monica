/// v14: record which Workbench terminal tab a run's Claude session lives in.
pub(super) const SQL: &str = r#"
    ALTER TABLE task_runs ADD COLUMN terminal_tab_id TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn adds_terminal_tab_id_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 13);
        conn.execute_batch(super::SQL).unwrap();

        let has_column: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('task_runs') WHERE name = 'terminal_tab_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 1);
    }
}
