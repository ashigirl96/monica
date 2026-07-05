/// v31: claude_sessions — the single source of truth mapping a Claude Code session Monica
/// launched (`claude_session_id`, the pre-minted UUID) to its Workbench runspace/tab, the
/// terminal session driving its PTY, and the cwd its JSONL transcript path derives from.
/// The JSONL path itself is not stored: it is a pure function of cwd + claude_session_id.
/// No FKs, consistent with v16: `save_terminal_state` rewrites runspaces/tabs by
/// DELETE+reinsert, so hard references would break on every layout save — reconcile and
/// the adapter's coupled ended-transition own consistency instead.
pub(super) const SQL: &str = r#"
    CREATE TABLE claude_sessions (
      claude_session_id   TEXT PRIMARY KEY,
      runspace_id         TEXT NOT NULL,
      tab_id              TEXT NOT NULL,
      terminal_session_id TEXT NOT NULL,
      cwd                 TEXT NOT NULL,
      name                TEXT,
      status              TEXT NOT NULL DEFAULT 'active',
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ended_at            TEXT
    );
    CREATE INDEX claude_sessions_terminal_idx ON claude_sessions(terminal_session_id);
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_column_exists, assert_index_exists, assert_table_exists, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn creates_claude_sessions_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 30);

        conn.execute_batch(super::SQL).unwrap();

        assert_table_exists(&conn, "claude_sessions");
        assert_column_exists(&conn, "claude_sessions", "claude_session_id");
        assert_column_exists(&conn, "claude_sessions", "terminal_session_id");
        assert_column_exists(&conn, "claude_sessions", "status");
        assert_column_exists(&conn, "claude_sessions", "ended_at");
        assert_index_exists(&conn, "claude_sessions_terminal_idx");

        conn.execute(
            "INSERT INTO claude_sessions
               (claude_session_id, runspace_id, tab_id, terminal_session_id, cwd)
             VALUES ('uuid-1', 'sdk', 'tab-1', 'ts-1', '/tmp')",
            [],
        )
        .unwrap();
        let (status, created_at): (String, String) = conn
            .query_row(
                "SELECT status, created_at FROM claude_sessions
                 WHERE claude_session_id = 'uuid-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "active");
        assert!(created_at.ends_with('Z'));
    }
}
