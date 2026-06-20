/// v1: storage foundation (work items, runs, events, external refs) + MON-id counter.
pub(super) const SQL: &str = r#"
    CREATE TABLE mon_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE work_items (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      phase        TEXT,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL DEFAULT '',
      project_id   TEXT,
      labels       TEXT NOT NULL DEFAULT '[]',
      details_json TEXT NOT NULL DEFAULT '{}',
      source_json  TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE runs (
      id            TEXT PRIMARY KEY,
      work_item_id  TEXT NOT NULL REFERENCES work_items(id),
      agent         TEXT,
      branch        TEXT,
      worktree_path TEXT,
      status        TEXT NOT NULL,
      settings_path TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT REFERENCES work_items(id),
      run_id       TEXT REFERENCES runs(id),
      kind         TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE external_refs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      ref_type     TEXT NOT NULL,
      repo         TEXT,
      number       INTEGER,
      url          TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn creates_foundation_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::SQL).unwrap();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        for expected in ["mon_counter", "work_items", "runs", "events", "external_refs"] {
            assert!(tables.contains(&expected.to_string()), "missing table: {expected}");
        }
    }
}
