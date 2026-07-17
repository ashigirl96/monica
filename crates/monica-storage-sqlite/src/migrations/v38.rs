// kind/content/date の DDL デフォルトは v38 時点のスナップショット（migration は frozen）。
// 実際の作成デフォルトは store の create_note が明示的に insert する。
pub(super) const SQL: &str = r#"
    CREATE TABLE note_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE notes (
        id         TEXT PRIMARY KEY,
        title      TEXT,
        kind       TEXT NOT NULL DEFAULT 'memo',
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        content    TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"blockGroup","content":[{"type":"blockContainer","content":[{"type":"paragraph"}]}]}]}',
        date       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now','localtime')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX notes_date_idx ON notes(date);
    -- (project_id, date) だと ORDER BY date DESC, rowid DESC を逆方向スキャンだけで満たせる
    CREATE INDEX notes_project_idx ON notes(project_id, date);
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_index_exists, assert_table_exists, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn creates_notes_table_and_indexes() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 37);

        conn.execute_batch(super::SQL).unwrap();
        assert_table_exists(&conn, "notes");
        assert_table_exists(&conn, "note_counter");
        assert_index_exists(&conn, "notes_date_idx");
        assert_index_exists(&conn, "notes_project_idx");

        conn.execute("INSERT INTO notes (id) VALUES ('note-1')", [])
            .unwrap();
        let (kind, content, date): (String, String, String) = conn
            .query_row(
                "SELECT kind, content, date FROM notes WHERE id = 'note-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(kind, "memo");
        assert!(content.starts_with(r#"{"type":"doc""#));
        assert_eq!(date.len(), 10);
    }
}
