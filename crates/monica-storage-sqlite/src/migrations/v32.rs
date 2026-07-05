/// v32: claude_sessions.launch_phase — how far a pending open got, stamped durably so a
/// crash leaves evidence: `reserved` (no launch write attempted yet — provably nothing
/// runs under the id, safe to reclaim) vs `submitting` (a write was attempted — unknowable,
/// reclaimed only through observed death). The backfill default is `submitting`: rows that
/// predate the column must stay on the conservative side.
pub(super) const SQL: &str = r#"
    ALTER TABLE claude_sessions
      ADD COLUMN launch_phase TEXT NOT NULL DEFAULT 'submitting';
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_launch_phase_with_a_conservative_backfill() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 31);
        conn.execute(
            "INSERT INTO claude_sessions
               (claude_session_id, runspace_id, tab_id, terminal_session_id, cwd)
             VALUES ('uuid-old', 'sdk', 'tab-1', 'ts-1', '/tmp')",
            [],
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        assert_column_exists(&conn, "claude_sessions", "launch_phase");
        let phase: String = conn
            .query_row(
                "SELECT launch_phase FROM claude_sessions WHERE claude_session_id = 'uuid-old'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(phase, "submitting", "pre-column rows must not read as reclaimable");
    }
}
