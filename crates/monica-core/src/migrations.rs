use anyhow::{Context, Result};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

/// Ordered schema migrations, tracked by `PRAGMA user_version` (rusqlite_migration
/// uses the list position as the version). Append an `M::up(...)` to add a version;
/// never reorder or remove existing entries, or already-migrated databases diverge.
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(V1), M::up(V2)])
}

/// v1: storage foundation (work items, runs, events, external refs) + MON-id counter.
const V1: &str = r#"
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

/// v2: project registry. One row per repo, holding the execution-environment definition
/// that `issue run` resolves (worktree layout, branch naming, agent settings).
const V2: &str = r#"
    CREATE TABLE projects (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      provider              TEXT NOT NULL DEFAULT 'github',
      repo                  TEXT NOT NULL,
      path                  TEXT,
      default_branch        TEXT NOT NULL DEFAULT 'main',
      worktree_root         TEXT,
      branch_template       TEXT NOT NULL DEFAULT 'monica/gh-{github_issue_number}-mon-{monica_number}-{slug}',
      setup_timeout_sec     INTEGER NOT NULL DEFAULT 600,
      agent_default         TEXT NOT NULL DEFAULT 'claude',
      agent_permission_mode TEXT NOT NULL DEFAULT 'plan',
      hooks_claude          INTEGER NOT NULL DEFAULT 1,
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

/// Apply any pending migrations. Idempotent: a fully-migrated database is a no-op.
pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    migrations()
        .to_latest(conn)
        .context("failed to apply database migrations")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_set_is_valid() {
        migrations().validate().expect("migrations should validate");
    }
}
