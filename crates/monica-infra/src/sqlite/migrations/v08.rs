/// v8: store lightweight GitHub PR state for dashboard display.
pub(super) const SQL: &str = r#"
    CREATE TABLE github_pull_request_ref_states (
      external_ref_id INTEGER PRIMARY KEY REFERENCES external_refs(id) ON DELETE CASCADE,
      status          TEXT CHECK(status IN ('draft', 'open', 'closed', 'merged')),
      synced_at       TEXT,
      last_error      TEXT,
      next_retry_at   TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX github_pr_ref_states_refresh_idx
      ON github_pull_request_ref_states(status, synced_at, next_retry_at);

    UPDATE external_ref_syncs
       SET last_synced_at = NULL,
           last_error = NULL,
           next_retry_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE target_ref_type = 'github_pull_request'
       AND EXISTS (
             SELECT 1
               FROM external_refs pr
              WHERE pr.task_id = external_ref_syncs.task_id
                AND pr.ref_type = 'github_pull_request'
           );
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn creates_pr_ref_states_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 7);
        conn.execute_batch(super::SQL).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'github_pull_request_ref_states'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
