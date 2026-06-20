/// v9: track branch-driven GitHub PR discovery independently from issue-linked sync state.
pub(super) const SQL: &str = r#"
    CREATE TABLE github_pull_request_branch_syncs (
      task_id        TEXT NOT NULL REFERENCES tasks(id),
      repo           TEXT NOT NULL,
      branch         TEXT NOT NULL,
      last_synced_at TEXT,
      last_error     TEXT,
      next_retry_at  TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (task_id, repo, branch)
    );

    CREATE INDEX github_pr_branch_syncs_retry_idx
      ON github_pull_request_branch_syncs(next_retry_at);
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn creates_branch_syncs_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 8);
        conn.execute_batch(super::SQL).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'github_pull_request_branch_syncs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
