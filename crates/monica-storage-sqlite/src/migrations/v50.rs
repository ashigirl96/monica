/// v50: add `tasks.parent_task_id`, the Monica-side mirror of GitHub's Sub-issues link. The
/// github-sync issue pass resolves each fetched issue's parent to an open task and writes it here,
/// so the column always reflects what GitHub currently says.
///
/// Deliberately without `REFERENCES tasks(id)`: SQLite refuses to `DROP COLUMN` a column used in a
/// foreign key, and the 12-step rebuild that would work around that is unavailable for `tasks`
/// (see v49), so the constraint would make this column permanent. It would buy nothing in return —
/// nothing deletes a task, and the sync only ever writes a task id it read in the same transaction.
pub(super) const SQL: &str = r#"
    ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_a_nullable_parent_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 49);
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status) VALUES ('MON-1', 'development', 'ready')",
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        assert_column_exists(&conn, "tasks", "parent_task_id");
        let parent: Option<String> = conn
            .query_row("SELECT parent_task_id FROM tasks WHERE id = 'MON-1'", [], |r| r.get(0))
            .unwrap();
        assert!(parent.is_none(), "existing rows start without a parent");
    }

    #[test]
    fn accepts_a_self_referencing_task_id_without_a_foreign_key() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 49);
        conn.execute_batch(super::SQL).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status) VALUES ('MON-1', 'development', 'ready');
             INSERT INTO tasks (id, kind, status, parent_task_id)
               VALUES ('MON-2', 'development', 'ready', 'MON-1')",
        )
        .unwrap();
        let parent: Option<String> = conn
            .query_row("SELECT parent_task_id FROM tasks WHERE id = 'MON-2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(parent.as_deref(), Some("MON-1"));
    }
}
