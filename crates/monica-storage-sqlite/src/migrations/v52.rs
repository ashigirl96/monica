/// v52: the issues GitHub reports as blocking a tracked issue, feeding the start gate that
/// `monica task run` enforces. Unlike `tasks.parent_task_id`, a blocker is stored as the address
/// GitHub gave (repo + number) plus GitHub's own answer about it, never as a link into Monica: the
/// gate has to decide against blockers no task tracks. One row per blocker, rewritten wholesale by
/// every sync so an edge dropped on GitHub disappears here too.
pub(super) const SQL: &str = r#"
    CREATE TABLE github_issue_blockers (
      external_ref_id INTEGER NOT NULL REFERENCES external_refs(id) ON DELETE CASCADE,
      repo            TEXT NOT NULL,
      number          INTEGER NOT NULL,
      state           TEXT NOT NULL CHECK(state IN ('open', 'closed')),
      closed_by_merged_pull_request INTEGER NOT NULL
        CHECK(closed_by_merged_pull_request IN (0, 1)),
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (external_ref_id, repo, number)
    );
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, assert_table_exists, stage_through};
    use rusqlite::Connection;

    fn staged() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 51);
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

    fn insert_blocker(conn: &Connection, repo: &str, number: i64) -> rusqlite::Result<usize> {
        conn.execute(
            "INSERT INTO github_issue_blockers
               (external_ref_id, repo, number, state, closed_by_merged_pull_request)
             VALUES (1, ?1, ?2, 'open', 0)",
            rusqlite::params![repo, number],
        )
    }

    #[test]
    fn creates_issue_blockers_table() {
        let conn = staged();
        assert_table_exists(&conn, "github_issue_blockers");
        for column in [
            "external_ref_id",
            "repo",
            "number",
            "state",
            "closed_by_merged_pull_request",
            "created_at",
            "updated_at",
        ] {
            assert_column_exists(&conn, "github_issue_blockers", column);
        }
    }

    #[test]
    fn holds_several_blockers_per_ref_but_each_address_once() {
        let conn = staged();
        insert_blocker(&conn, "owner/repo", 1).unwrap();
        insert_blocker(&conn, "owner/repo", 2).unwrap();
        insert_blocker(&conn, "other/repo", 1).unwrap();
        assert!(
            insert_blocker(&conn, "owner/repo", 1).is_err(),
            "the same blocker address must not be stored twice for one ref"
        );
        let stored: i64 = conn
            .query_row("SELECT count(*) FROM github_issue_blockers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, 3);
    }

    #[test]
    fn rejects_unknown_state() {
        let conn = staged();
        let err = conn.execute_batch(
            "INSERT INTO github_issue_blockers
               (external_ref_id, repo, number, state, closed_by_merged_pull_request)
             VALUES (1, 'owner/repo', 7, 'merged', 0)",
        );
        assert!(err.is_err(), "state must be constrained to open/closed");
    }

    #[test]
    fn cascades_when_the_ref_is_deleted() {
        let conn = staged();
        insert_blocker(&conn, "owner/repo", 1).unwrap();
        conn.execute_batch("DELETE FROM external_refs WHERE id = 1").unwrap();
        let remaining: i64 = conn
            .query_row("SELECT count(*) FROM github_issue_blockers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
