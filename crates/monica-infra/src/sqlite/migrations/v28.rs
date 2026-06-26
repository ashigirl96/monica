/// v28: make external_refs provider-agnostic. Adds a `provider` column (GitHub for every existing
/// row) and rewrites the GitHub-coupled `ref_type` values to the provider-agnostic kinds, matching
/// the domain's `Provider` + `RefType { Issue, PullRequest }` model.
///
/// The v7 partial unique index keyed off the old `ref_type = 'github_pull_request'` literal, so the
/// value rewrite would leave it matching zero rows — silently dropping the PR-dedup guarantee. It is
/// recreated against the new `'pull_request'` value.
pub(super) const SQL: &str = r#"
    ALTER TABLE external_refs ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
    UPDATE external_refs SET ref_type = 'issue'        WHERE ref_type = 'github_issue';
    UPDATE external_refs SET ref_type = 'pull_request' WHERE ref_type = 'github_pull_request';
    DROP INDEX external_refs_github_pr_unique;
    CREATE UNIQUE INDEX external_refs_pull_request_unique
      ON external_refs(task_id, ref_type, repo, number)
     WHERE ref_type = 'pull_request'
       AND repo IS NOT NULL
       AND number IS NOT NULL;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::{
        assert_column_exists, assert_index_exists, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn adds_provider_column_and_rewrites_ref_types() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 27);
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status, title)
               VALUES ('mon-1', 'development', 'ready', 't');
             INSERT INTO external_refs (task_id, ref_type, repo, number)
               VALUES ('mon-1', 'github_issue', 'o/r', 1),
                      ('mon-1', 'github_pull_request', 'o/r', 2);",
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        assert_column_exists(&conn, "external_refs", "provider");

        let rows: Vec<(String, String)> = conn
            .prepare("SELECT ref_type, provider FROM external_refs ORDER BY number")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            rows,
            vec![
                ("issue".to_string(), "github".to_string()),
                ("pull_request".to_string(), "github".to_string()),
            ]
        );
    }

    #[test]
    fn swaps_pull_request_unique_index_to_provider_agnostic_predicate() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 27);
        conn.execute_batch(super::SQL).unwrap();

        let old_index_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'external_refs_github_pr_unique'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_index_count, 0, "old github-coupled index must be dropped");
        assert_index_exists(&conn, "external_refs_pull_request_unique");

        // The recreated index still rejects duplicate PR refs under the new ref_type value.
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status, title)
               VALUES ('mon-1', 'development', 'ready', 't');
             INSERT INTO external_refs (task_id, provider, ref_type, repo, number)
               VALUES ('mon-1', 'github', 'pull_request', 'o/r', 7);",
        )
        .unwrap();
        let dup = conn.execute(
            "INSERT INTO external_refs (task_id, provider, ref_type, repo, number)
             VALUES ('mon-1', 'github', 'pull_request', 'o/r', 7)",
            [],
        );
        assert!(dup.is_err(), "duplicate pull_request ref must violate the unique index");
    }
}
