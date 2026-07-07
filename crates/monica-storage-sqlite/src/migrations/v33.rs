/// v33: hook/JSONL observability for Claude sessions.
///
/// `claude_sessions` gains the conversation-level state driven by hooks
/// (`conversation_status` / `wait_reason`), the transcript cursor (`jsonl_offset`), and
/// `provider_session_id` — the id Claude currently writes its transcript under, which
/// diverges from the pre-minted `claude_session_id` after a `/clear` or resume.
///
/// `claude_session_events` is the hook event log doubling as an outbox: the short-lived
/// CLI hook process can only write to the DB, so the desktop drain worker reads rows with
/// `consumed_at IS NULL`, emits UI events (reading the transcript JSONL where needed), and
/// stamps them consumed. No FKs, consistent with v31.
pub(super) const SQL: &str = r#"
    ALTER TABLE claude_sessions ADD COLUMN conversation_status TEXT NOT NULL DEFAULT 'idle';
    ALTER TABLE claude_sessions ADD COLUMN wait_reason TEXT;
    ALTER TABLE claude_sessions ADD COLUMN jsonl_offset INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE claude_sessions ADD COLUMN provider_session_id TEXT;

    CREATE TABLE claude_session_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      claude_session_id TEXT NOT NULL,
      kind              TEXT NOT NULL,
      payload_json      TEXT NOT NULL DEFAULT '{}',
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      consumed_at       TEXT
    );
    CREATE INDEX claude_session_events_pending_idx
      ON claude_session_events(id) WHERE consumed_at IS NULL;
    CREATE INDEX claude_session_events_session_idx
      ON claude_session_events(claude_session_id, id);
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_column_exists, assert_index_exists, assert_table_exists, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn adds_observability_columns_and_event_outbox() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 32);
        conn.execute(
            "INSERT INTO claude_sessions
               (claude_session_id, runspace_id, tab_id, terminal_session_id, cwd)
             VALUES ('uuid-old', 'agent-runtime', 'tab-1', 'ts-1', '/tmp')",
            [],
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        for column in [
            "conversation_status",
            "wait_reason",
            "jsonl_offset",
            "provider_session_id",
        ] {
            assert_column_exists(&conn, "claude_sessions", column);
        }
        let (conversation_status, jsonl_offset): (String, i64) = conn
            .query_row(
                "SELECT conversation_status, jsonl_offset FROM claude_sessions
                 WHERE claude_session_id = 'uuid-old'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(conversation_status, "idle");
        assert_eq!(jsonl_offset, 0);

        assert_table_exists(&conn, "claude_session_events");
        assert_index_exists(&conn, "claude_session_events_pending_idx");
        assert_index_exists(&conn, "claude_session_events_session_idx");

        conn.execute(
            "INSERT INTO claude_session_events (claude_session_id, kind)
             VALUES ('uuid-old', 'SessionStart')",
            [],
        )
        .unwrap();
        let (payload, consumed_at): (String, Option<String>) = conn
            .query_row(
                "SELECT payload_json, consumed_at FROM claude_session_events WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(payload, "{}");
        assert_eq!(consumed_at, None);
    }
}
