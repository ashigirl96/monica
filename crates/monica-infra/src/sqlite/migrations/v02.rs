/// v2: project registry. One row per repo, holding the execution-environment definition
/// that `issue run` resolves (worktree layout, branch naming, agent settings).
pub(super) const SQL: &str = r#"
    CREATE TABLE projects (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      provider              TEXT NOT NULL DEFAULT 'github',
      repo                  TEXT NOT NULL,
      path                  TEXT,
      default_branch        TEXT NOT NULL DEFAULT 'main',
      worktree_root         TEXT,
      branch_template       TEXT NOT NULL DEFAULT 'monica/gh-{github_issue_number}-mon-{monica_number}-{slug}',
      setup_timeout_sec     INTEGER NOT NULL DEFAULT 600,
      agent_default         TEXT NOT NULL DEFAULT 'claude',
      agent_permission_mode TEXT NOT NULL DEFAULT 'plan',
      hooks_claude          INTEGER NOT NULL DEFAULT 1,
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn creates_projects_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 1);
        conn.execute_batch(super::SQL).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
