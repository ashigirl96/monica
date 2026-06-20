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
    use crate::sqlite::migrations::test_support::stage_through;
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

        let has_closed_at: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('tasks') WHERE name = 'closed_at'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_closed_at, 1);

        let has_deleted_at: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('tasks') WHERE name = 'deleted_at'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_deleted_at, 0, "deleted_at must be renamed to closed_at");

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
