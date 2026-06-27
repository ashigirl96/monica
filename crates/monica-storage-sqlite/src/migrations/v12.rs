/// v12: junction table linking a Task to its Workbench Runspace.
pub(super) const SQL: &str = r#"
    CREATE TABLE "_TaskToRunspace" (
      task_id    TEXT PRIMARY KEY NOT NULL,
      runspace_id TEXT NOT NULL UNIQUE,
      cwd        TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_table_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn creates_task_to_runspace_junction() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 11);
        conn.execute_batch(super::SQL).unwrap();
        assert_table_exists(&conn, "_TaskToRunspace");
    }
}
