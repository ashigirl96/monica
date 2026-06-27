/// v11: rename workspace → runspace (tables, columns, indexes).
pub(super) const SQL: &str = r#"
    ALTER TABLE terminal_workspaces RENAME TO terminal_runspaces;
    ALTER TABLE terminal_tabs RENAME COLUMN workspace_id TO runspace_id;
    DROP INDEX terminal_tabs_workspace_idx;
    CREATE INDEX terminal_tabs_runspace_idx ON terminal_tabs(runspace_id, sort_order);
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_table_absent, assert_table_exists, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn renames_workspace_to_runspace() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 10);
        conn.execute_batch(super::SQL).unwrap();
        assert_table_exists(&conn, "terminal_runspaces");
        assert_table_absent(&conn, "terminal_workspaces");
    }
}
