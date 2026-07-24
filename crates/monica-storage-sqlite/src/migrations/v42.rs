// status は essay のみ使用（NULL = writing と読む。backfill はしない）。
// primary_note_id はここでは列を足すだけ。書き込みは get-or-create の lazy 作成が担う。
pub(super) const SQL: &str = r#"
    ALTER TABLE notes ADD COLUMN status TEXT;
    ALTER TABLE projects ADD COLUMN primary_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_status_and_primary_note_id_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 41);
        conn.execute("INSERT INTO notes (id, kind, title) VALUES ('note-1', 'essay', 't')", [])
            .unwrap();
        conn.execute("INSERT INTO projects (id, name, repo) VALUES ('o/r', 'r', 'o/r')", [])
            .unwrap();

        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "notes", "status");
        assert_column_exists(&conn, "projects", "primary_note_id");

        let status: Option<String> = conn
            .query_row("SELECT status FROM notes WHERE id = 'note-1'", [], |r| r.get(0))
            .unwrap();
        assert!(status.is_none());
        let primary: Option<String> = conn
            .query_row("SELECT primary_note_id FROM projects WHERE id = 'o/r'", [], |r| r.get(0))
            .unwrap();
        assert!(primary.is_none());
    }
}
