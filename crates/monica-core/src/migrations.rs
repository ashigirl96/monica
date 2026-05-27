use anyhow::{Context, Result};
use rusqlite::Connection;

/// Schema migrations applied in order. The index + 1 is the resulting `user_version`,
/// so a new schema change is added by appending one batch to this slice.
const MIGRATIONS: &[&str] = &[
    // v1: storage foundation (work items, runs, events, external refs) + MON-id counter.
    r#"
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
    "#,
];

/// Apply any migrations newer than the connection's `user_version`. Idempotent: a
/// fully-migrated database is a no-op. Each batch + version bump commits atomically.
pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    let mut version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    while (version as usize) < MIGRATIONS.len() {
        let batch = MIGRATIONS[version as usize];
        let tx = conn.transaction()?;
        tx.execute_batch(batch)
            .with_context(|| format!("failed to apply migration v{}", version + 1))?;
        version += 1;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}
