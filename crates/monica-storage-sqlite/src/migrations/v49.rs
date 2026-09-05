/// v49: make `tasks.title` / `tasks.body` nullable so an issue-backed task can leave them empty
/// and let `github_issue_ref_states` (v48) be the single source of the GitHub-owned text. Reads
/// resolve `COALESCE(issue_state.title, tasks.title, '')`, so the column survives as the fallback
/// for rows tracked before the cache existed.
///
/// SQLite cannot drop a NOT NULL in place, and the usual 12-step table rebuild would need
/// `PRAGMA foreign_keys = OFF` — a no-op inside the transaction rusqlite_migration wraps each step
/// in — while `external_refs` and `task_runs` still point at `tasks(id)`. Adding a nullable twin
/// and renaming it over the original keeps the table's identity, so no foreign key ever dangles.
/// Safe here because `tasks.title` / `tasks.body` carry no index, trigger or view.
pub(super) const SQL: &str = r#"
    ALTER TABLE tasks ADD COLUMN title_nullable TEXT;
    UPDATE tasks SET title_nullable = title;
    ALTER TABLE tasks DROP COLUMN title;
    ALTER TABLE tasks RENAME COLUMN title_nullable TO title;

    ALTER TABLE tasks ADD COLUMN body_nullable TEXT;
    UPDATE tasks SET body_nullable = body;
    ALTER TABLE tasks DROP COLUMN body;
    ALTER TABLE tasks RENAME COLUMN body_nullable TO body;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_absent, assert_column_exists, stage_through};
    use rusqlite::Connection;

    fn notnull(conn: &Connection, column: &str) -> i64 {
        conn.query_row(
            &format!("SELECT \"notnull\" FROM pragma_table_info('tasks') WHERE name = '{column}'"),
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn drops_not_null_and_keeps_existing_text() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 48);
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status, title, body, project_id)
               VALUES ('MON-1', 'development', 'ready', 'tracked title', 'tracked body', 'owner/repo')",
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        assert_eq!(notnull(&conn, "title"), 0, "title must be nullable");
        assert_eq!(notnull(&conn, "body"), 0, "body must be nullable");
        let (title, body): (Option<String>, Option<String>) = conn
            .query_row("SELECT title, body FROM tasks WHERE id = 'MON-1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(title.as_deref(), Some("tracked title"));
        assert_eq!(body.as_deref(), Some("tracked body"));
    }

    #[test]
    fn accepts_null_title_and_body_afterwards() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 48);
        conn.execute_batch(super::SQL).unwrap();
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status) VALUES ('MON-1', 'development', 'ready')",
        )
        .unwrap();
        let title: Option<String> = conn
            .query_row("SELECT title FROM tasks WHERE id = 'MON-1'", [], |r| r.get(0))
            .unwrap();
        assert!(title.is_none());
    }

    #[test]
    fn leaves_the_other_columns_intact() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 48);
        conn.execute_batch(super::SQL).unwrap();
        for column in [
            "id",
            "kind",
            "status",
            "phase",
            "project_id",
            "labels",
            "details_json",
            "source_json",
            "primary_task_run_id",
            "closed_at",
            "created_at",
            "updated_at",
        ] {
            assert_column_exists(&conn, "tasks", column);
        }
        assert_column_absent(&conn, "tasks", "title_nullable");
        assert_column_absent(&conn, "tasks", "body_nullable");
    }
}
