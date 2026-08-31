// v47: Codex を agent provider から外したので `Agent` の `Codex` variant が消える。行に残った
// 'codex' は読み取り時の `parse::<Agent>()` を落とし、その行を含む一覧ごと失敗させるため、
// 唯一残る agent へ寄せる。`task_runs.agent` の NULL は「未確定」を意味するので触らない。
//
// agent の付け替えより先に codex 由来の実行状態を落とす。どちらも codex の hook からしか
// 更新されず、その hook はもう存在しないので、残すと誰も直せない嘘になる:
//
// - `task_runs.agent_session_id`: stopped + session ありの run は `resumable_session()` が Some を
//   返して `claude --resume <codex-session-id>` を組み立ててしまい、しかも `run_needs_prepare` が
//   false なので UI 上は prepare も促されず Run が詰む。
// - `terminal_sessions` の agent 3 列: session が終われば `apply_terminal_session_updates` が
//   クリアするが、移行時に生きている shell はその寿命のあいだ running/waiting を出し続ける。
pub(super) const SQL: &str = r#"
    UPDATE terminal_sessions
       SET agent_status = NULL, agent_wait_reason = NULL, agent_session_id = NULL
     WHERE tab_id IN (
       SELECT terminal_tab_id FROM task_runs
        WHERE agent = 'codex' AND terminal_tab_id IS NOT NULL
     );
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

    /// A shell still live at upgrade time keeps its terminal-session agent state, and the Codex
    /// hook that used to clear it is gone — so the migration has to, or the tab header shows a
    /// running/waiting indicator nothing can ever retract.
    #[test]
    fn clears_terminal_session_agent_state_of_a_migrated_codex_run() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 46);
        conn.execute_batch(
            r#"
            INSERT INTO tasks (id, kind, title, status) VALUES ('MON-1', 'task', 'a task', 'open');
            INSERT INTO task_runs (id, task_id, agent, status, terminal_tab_id)
              VALUES ('run-codex', 'MON-1', 'codex', 'running', 'tab-codex'),
                     ('run-claude', 'MON-1', 'claude', 'running', 'tab-claude');
            INSERT INTO terminal_sessions
              (id, tab_id, cwd, shell, status, rows, cols, agent_status, agent_wait_reason, agent_session_id)
              VALUES ('ts-codex', 'tab-codex', '/tmp', 'zsh', 'running', 24, 80,
                      'waiting_for_user', 'permission_request', 'codex-sess-1'),
                     ('ts-claude', 'tab-claude', '/tmp', 'zsh', 'running', 24, 80,
                      'running', NULL, 'claude-sess-1');
            "#,
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        let agent_state = |id: &str| -> (Option<String>, Option<String>, Option<String>) {
            conn.query_row(
                "SELECT agent_status, agent_wait_reason, agent_session_id
                   FROM terminal_sessions WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        };
        assert_eq!(agent_state("ts-codex"), (None, None, None));
        assert_eq!(
            agent_state("ts-claude"),
            (Some("running".to_string()), None, Some("claude-sess-1".to_string())),
            "a Claude tab's live indicator must survive"
        );
    }
}
