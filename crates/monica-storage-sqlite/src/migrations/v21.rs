/// v21: unify done and soft-delete into a single closed concept. The `deleted_at` column becomes
/// `closed_at` — a record-only timestamp, no longer a hard filter — and both the old `done` status
/// and old soft-deleted rows collapse into `status = 'closed'` with a synced `closed_at`.
pub(super) const SQL: &str = r#"
    ALTER TABLE tasks RENAME COLUMN deleted_at TO closed_at;

    UPDATE tasks
       SET status = 'closed'
     WHERE status = 'done' OR closed_at IS NOT NULL;

    UPDATE tasks
       SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE status = 'closed' AND closed_at IS NULL;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_column_absent, assert_column_exists, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn renames_deleted_at_and_unifies_closed() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 20);
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status, title) VALUES ('t-done', 'dev', 'done', 'done task');
             INSERT INTO tasks (id, kind, status, title) VALUES ('t-active', 'dev', 'in_progress', 'active task');",
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        assert_column_exists(&conn, "tasks", "closed_at");
        assert_column_absent(&conn, "tasks", "deleted_at");

        let done_status: String = conn
            .query_row("SELECT status FROM tasks WHERE id = 't-done'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(done_status, "closed");

        let active_status: String = conn
            .query_row("SELECT status FROM tasks WHERE id = 't-active'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(active_status, "in_progress");
    }
}
