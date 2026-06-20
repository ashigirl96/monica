/// v7: persist linked GitHub PR sync state so the dashboard can show PR refs without polling
/// GitHub from the task list path.
pub(super) const SQL: &str = r#"
    CREATE TABLE external_ref_syncs (
      task_id         TEXT NOT NULL REFERENCES tasks(id),
      source_ref_id   INTEGER NOT NULL REFERENCES external_refs(id),
      target_ref_type TEXT NOT NULL,
      last_synced_at  TEXT,
      last_error      TEXT,
      next_retry_at   TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (task_id, source_ref_id, target_ref_type)
    );

    CREATE UNIQUE INDEX external_refs_github_pr_unique
      ON external_refs(task_id, ref_type, repo, number)
     WHERE ref_type = 'github_pull_request'
       AND repo IS NOT NULL
       AND number IS NOT NULL;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::{assert_table_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn creates_external_ref_syncs_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 6);
        conn.execute_batch(super::SQL).unwrap();
        assert_table_exists(&conn, "external_ref_syncs");
    }
}
