/// v10: terminal workspace/tab persistence for Work Bench.
pub(super) const SQL: &str = r#"
    CREATE TABLE terminal_workspaces (
      id         TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE terminal_tabs (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES terminal_workspaces(id) ON DELETE CASCADE,
      cwd          TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      sort_order   INTEGER NOT NULL DEFAULT 0,
      is_active    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX terminal_tabs_workspace_idx ON terminal_tabs(workspace_id, sort_order);
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn creates_terminal_workspace_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 9);
        conn.execute_batch(super::SQL).unwrap();

        for table in ["terminal_workspaces", "terminal_tabs"] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "missing table: {table}");
        }
    }
}
