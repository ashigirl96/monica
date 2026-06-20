/// v16: durable terminal sessions owned by the PTY daemon. Tabs reference a session via
/// `terminal_tabs.terminal_session_id` instead of doubling as the PTY id. No FKs:
/// `save_terminal_state` rewrites runspaces/tabs wholesale (DELETE + reinsert), so hard
/// references would break on every layout save; reconcile owns consistency instead.
pub(super) const SQL: &str = r#"
    CREATE TABLE terminal_session_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE terminal_sessions (
      id              TEXT PRIMARY KEY,
      runspace_id     TEXT,
      tab_id          TEXT,
      kind            TEXT NOT NULL DEFAULT 'shell',
      cwd             TEXT NOT NULL,
      shell           TEXT NOT NULL,
      status          TEXT NOT NULL,
      pid             INTEGER,
      rows            INTEGER NOT NULL,
      cols            INTEGER NOT NULL,
      transcript_path TEXT,
      exit_code       INTEGER,
      started_at      TEXT,
      last_seen_at    TEXT,
      exited_at       TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX terminal_sessions_runspace_idx ON terminal_sessions(runspace_id, status);

    ALTER TABLE terminal_tabs ADD COLUMN terminal_session_id TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn creates_terminal_session_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 15);
        conn.execute_batch(super::SQL).unwrap();

        for table in ["terminal_session_counter", "terminal_sessions"] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "missing table: {table}");
        }

        let has_column: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('terminal_tabs') WHERE name = 'terminal_session_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 1);
    }
}
