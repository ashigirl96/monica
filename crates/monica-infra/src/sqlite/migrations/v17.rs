/// v17: drop vestigial is_active columns; active selection moved to the Tauri store.
pub(super) const SQL: &str = r#"
    ALTER TABLE terminal_runspaces DROP COLUMN is_active;
    ALTER TABLE terminal_tabs DROP COLUMN is_active;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn drops_is_active_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 16);
        conn.execute_batch(super::SQL).unwrap();

        for table in ["terminal_runspaces", "terminal_tabs"] {
            let has_column: i64 = conn
                .query_row(
                    &format!(
                        "SELECT count(*) FROM pragma_table_info('{table}') WHERE name = 'is_active'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has_column, 0, "{table}.is_active must be dropped");
        }
    }
}
