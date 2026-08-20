// "provider" は external_refs の提供元 (GitHub) と衝突する語彙なので、エージェント実行系
// (Claude/Codex) のセッション id は domain の公式語彙 Agent に揃える。
// task_runs_task_session_idx は SQLite の RENAME COLUMN が定義を自動追従するので触らない。
pub(super) const SQL: &str = r#"
    ALTER TABLE task_runs RENAME COLUMN provider_session_id TO agent_session_id;
    ALTER TABLE terminal_sessions RENAME COLUMN provider_session_id TO agent_session_id;
    ALTER TABLE explanations RENAME COLUMN provider_session_id TO agent_session_id;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_column_absent, assert_column_exists, assert_index_exists, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn renames_provider_session_id_to_agent_session_id() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 44);
        conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        conn.execute(
            "INSERT INTO task_runs (id, task_id, status, provider_session_id, created_at, updated_at)
             VALUES ('run-1', 'MON-1', 'running', 'sess-run',
                     '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO terminal_sessions (id, cwd, shell, status, rows, cols, provider_session_id)
             VALUES ('ts-1', '/tmp', '/bin/zsh', 'running', 24, 80, 'sess-term')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO explanations (id, title, mode, provider_session_id, terminal_session_id)
             VALUES ('expl-1', 't', 'diff', 'sess-expl', 'ts-1')",
            [],
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        for table in ["task_runs", "terminal_sessions", "explanations"] {
            assert_column_exists(&conn, table, "agent_session_id");
            assert_column_absent(&conn, table, "provider_session_id");
        }
        assert_index_exists(&conn, "task_runs_task_session_idx");

        for (table, id, expected) in [
            ("task_runs", "run-1", "sess-run"),
            ("terminal_sessions", "ts-1", "sess-term"),
            ("explanations", "expl-1", "sess-expl"),
        ] {
            let value: String = conn
                .query_row(
                    &format!("SELECT agent_session_id FROM {table} WHERE id = ?1"),
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(value, expected);
        }
    }
}
