/// v23: Artifact / Library v1. Single `library_entries` table with a `state` column
/// (`draft` / `saved`) so that drafts and saved artifacts share the same ID and attachments
/// can reference entries before they are formally saved.
pub(super) const SQL: &str = r#"
    CREATE TABLE artifact_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE library_entries (
      id             TEXT PRIMARY KEY,
      state          TEXT NOT NULL CHECK (state IN ('draft', 'saved')),
      kind           TEXT NOT NULL CHECK (kind IN ('memo', 'essay', 'intent')),
      title          TEXT,
      body_markdown  TEXT NOT NULL DEFAULT '',
      project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
      occurred_at    TEXT,
      revision       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TRIGGER library_entries_saved_update_check BEFORE UPDATE ON library_entries WHEN NEW.state = 'saved'
    BEGIN SELECT CASE WHEN NEW.kind = 'essay' AND (NEW.title IS NULL OR length(trim(NEW.title)) = 0) THEN RAISE(ABORT, 'essay requires non-empty title') WHEN NEW.kind = 'intent' AND (NEW.title IS NULL OR length(trim(NEW.title)) = 0) THEN RAISE(ABORT, 'intent requires non-empty title') WHEN NEW.kind = 'memo' AND NEW.title IS NOT NULL THEN RAISE(ABORT, 'memo must not have title') END; END;

    CREATE TRIGGER library_entries_saved_insert_check BEFORE INSERT ON library_entries WHEN NEW.state = 'saved'
    BEGIN SELECT CASE WHEN NEW.kind IN ('essay','intent') AND (NEW.title IS NULL OR length(trim(NEW.title)) = 0) THEN RAISE(ABORT, 'essay/intent requires non-empty title') WHEN NEW.kind = 'memo' AND NEW.title IS NOT NULL THEN RAISE(ABORT, 'memo must not have title') END; END;

    CREATE INDEX library_entries_state_kind_idx
      ON library_entries(state, kind, updated_at DESC);
    CREATE INDEX library_entries_project_idx
      ON library_entries(state, kind, project_id);

    CREATE TABLE attachment_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE library_attachments (
      id                 TEXT PRIMARY KEY,
      entry_id           TEXT NOT NULL REFERENCES library_entries(id) ON DELETE CASCADE,
      original_file_name TEXT NOT NULL,
      mime_type          TEXT,
      byte_size          INTEGER NOT NULL,
      relative_path      TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX library_attachments_entry_idx ON library_attachments(entry_id);
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn creates_library_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 22);
        conn.execute_batch(super::SQL).unwrap();

        for table in [
            "artifact_counter",
            "library_entries",
            "library_attachments",
            "attachment_counter",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "missing table: {table}");
        }
    }
}
