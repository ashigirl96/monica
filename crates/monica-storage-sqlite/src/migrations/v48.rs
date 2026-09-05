/// v48: cache the GitHub issue title/state the way v8 already caches PR status. `external_refs`
/// holds the address (repo + number) and this table holds what GitHub currently says about it, so
/// a task can reference an issue without Monica owning — and going stale on — its title.
pub(super) const SQL: &str = r#"
    CREATE TABLE github_issue_ref_states (
      external_ref_id INTEGER PRIMARY KEY REFERENCES external_refs(id) ON DELETE CASCADE,
      title           TEXT,
      state           TEXT CHECK(state IN ('open', 'closed')),
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Every task read now resolves its newest issue ref through a correlated subquery. The only
    -- other index on external_refs is partial on ref_type = 'pull_request', so without this one
    -- that subquery full-scans the table once per task row.
    CREATE INDEX external_refs_issue_idx
      ON external_refs(task_id, id)
      WHERE ref_type = 'issue';
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_column_exists, assert_index_exists, assert_table_exists, stage_through,
    };
    use rusqlite::Connection;

    fn staged() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 47);
        conn.execute_batch(super::SQL).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status, title) VALUES ('MON-1', 'development', 'ready', 't');
             INSERT INTO external_refs (id, task_id, provider, ref_type, repo, number)
               VALUES (1, 'MON-1', 'github', 'issue', 'owner/repo', 42);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn creates_issue_ref_states_table() {
        let conn = staged();
        assert_table_exists(&conn, "github_issue_ref_states");
        for column in ["external_ref_id", "title", "state", "created_at", "updated_at"] {
            assert_column_exists(&conn, "github_issue_ref_states", column);
        }
    }

    #[test]
    fn indexes_the_newest_issue_ref_lookup() {
        let conn = staged();
        assert_index_exists(&conn, "external_refs_issue_idx");
        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN
                   SELECT er.id FROM external_refs er
                    WHERE er.task_id = 'MON-1' AND er.ref_type = 'issue'
                    ORDER BY er.id DESC LIMIT 1",
                [],
                |r| r.get("detail"),
            )
            .unwrap();
        assert!(plan.contains("external_refs_issue_idx"), "unexpected plan: {plan}");
    }

    #[test]
    fn rejects_unknown_state() {
        let conn = staged();
        let err = conn.execute_batch(
            "INSERT INTO github_issue_ref_states (external_ref_id, state) VALUES (1, 'merged')",
        );
        assert!(err.is_err(), "state must be constrained to open/closed");
    }

    #[test]
    fn cascades_when_the_ref_is_deleted() {
        let conn = staged();
        conn.execute_batch(
            "INSERT INTO github_issue_ref_states (external_ref_id, title, state)
               VALUES (1, 'hello', 'open')",
        )
        .unwrap();
        conn.execute_batch("DELETE FROM external_refs WHERE id = 1").unwrap();
        let remaining: i64 = conn
            .query_row("SELECT count(*) FROM github_issue_ref_states", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
