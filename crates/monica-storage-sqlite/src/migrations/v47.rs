// v47: Codex を agent provider から外したので `Agent` の `Codex` variant が消える。行に残った
// 'codex' は読み取り時の `parse::<Agent>()` を落とし、その行を含む一覧ごと失敗させるため、
// 唯一残る agent へ寄せる。`task_runs.agent` の NULL は「未確定」を意味するので触らない。
//
// agent の付け替えより先に codex run の session を落とす。stopped + session ありの run は
// `resumable_session()` が Some を返して `claude --resume <codex-session-id>` を組み立ててしまい、
// しかも `run_needs_prepare` が false なので UI 上は prepare も促されず Run が詰む。session を
// 消せば「prepare が必要な stopped run」に落ち着く。
pub(super) const SQL: &str = r#"
    UPDATE task_runs SET agent_session_id = NULL WHERE agent = 'codex';
    UPDATE task_runs SET agent = 'claude' WHERE agent = 'codex';
    UPDATE projects SET agent_default = 'claude' WHERE agent_default = 'codex';
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::stage_through;
    use rusqlite::Connection;

    fn agent_of(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row("SELECT agent FROM task_runs WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    }

    fn session_of(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row("SELECT agent_session_id FROM task_runs WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    fn agent_default_of(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT agent_default FROM projects WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn rewrites_codex_rows_and_leaves_every_other_value_alone() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 46);
        conn.execute_batch(
            r#"
            INSERT INTO tasks (id, kind, title, status) VALUES ('MON-1', 'task', 'a task', 'open');
            INSERT INTO task_runs (id, task_id, agent, status, agent_session_id)
              VALUES ('run-codex', 'MON-1', 'codex', 'stopped', 'codex-sess-1'),
                     ('run-claude', 'MON-1', 'claude', 'stopped', 'claude-sess-1'),
                     ('run-null', 'MON-1', NULL, 'stopped', NULL);
            INSERT INTO projects (id, name, repo, agent_default)
              VALUES ('owner/codex-proj', 'codex-proj', 'owner/codex-proj', 'codex'),
                     ('owner/claude-proj', 'claude-proj', 'owner/claude-proj', 'claude');
            "#,
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        assert_eq!(agent_of(&conn, "run-codex").as_deref(), Some("claude"));
        assert_eq!(agent_of(&conn, "run-claude").as_deref(), Some("claude"));
        assert_eq!(agent_of(&conn, "run-null"), None, "NULL means undecided, not codex");
        assert_eq!(agent_default_of(&conn, "owner/codex-proj"), "claude");
        assert_eq!(agent_default_of(&conn, "owner/claude-proj"), "claude");
    }

    /// A migrated Codex run must not stay resumable: keeping its session would have the Claude
    /// label resume a Codex session, and `run_needs_prepare` would never offer a way out.
    #[test]
    fn retires_the_session_of_a_migrated_codex_run() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 46);
        conn.execute_batch(
            r#"
            INSERT INTO tasks (id, kind, title, status) VALUES ('MON-1', 'task', 'a task', 'open');
            INSERT INTO task_runs (id, task_id, agent, status, agent_session_id)
              VALUES ('run-codex', 'MON-1', 'codex', 'stopped', 'codex-sess-1'),
                     ('run-claude', 'MON-1', 'claude', 'stopped', 'claude-sess-1');
            "#,
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        assert_eq!(session_of(&conn, "run-codex"), None);
        assert_eq!(
            session_of(&conn, "run-claude").as_deref(),
            Some("claude-sess-1"),
            "a Claude run's session is still resumable"
        );
    }
}
