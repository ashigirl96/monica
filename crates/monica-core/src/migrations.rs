use anyhow::{Context, Result};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

/// Ordered schema migrations, tracked by `PRAGMA user_version` (rusqlite_migration
/// uses the list position as the version). Append an `M::up(...)` to add a version;
/// never reorder or remove existing entries, or already-migrated databases diverge.
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(V1), M::up(V2), M::up(V3), M::up(V4)])
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

/// v3: run-id counter. Mirrors `mon_counter` so each run gets a monotonic `run-<n>` id that is
/// never reused, keeping the `runs/<run_id>/` artifact directories collision-free.
const V3: &str = r#"
    CREATE TABLE run_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);
"#;

/// v4: drop the per-project branch-name template. Branch names are now derived directly from the
/// run (`issue-<n>` for a linked GitHub issue, else `mon-<n>`), so the configurable rule is gone.
const V4: &str = r#"
    ALTER TABLE projects DROP COLUMN branch_template;
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

    /// A project row written under the v3 schema (which still has `branch_template`) must survive
    /// the v4 `DROP COLUMN` and stay readable through `Db`/`Project::from_row` afterwards. `Db` has
    /// no constructor from an existing connection, so the v3 state is staged on disk and reopened
    /// via `Db::open_at`, which runs the pending v4 migration on that existing data.
    #[test]
    fn v4_drops_branch_template_and_preserves_v3_rows() {
        let dir = std::env::temp_dir().join(format!(
            "monica-mig-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("v3.db");
        let _ = std::fs::remove_file(&path);

        {
            let mut conn = Connection::open(&path).unwrap();
            Migrations::new(vec![M::up(V1), M::up(V2), M::up(V3)])
                .to_latest(&mut conn)
                .unwrap();
            conn.execute(
                "INSERT INTO projects (id, name, repo, path, branch_template)
                 VALUES ('o/r', 'r', 'o/r', '/tmp/r', 'monica/{slug}')",
                [],
            )
            .unwrap();
        }

        let db = crate::Db::open_at(&path).unwrap();
        let project = db
            .get_project("o/r")
            .unwrap()
            .expect("v3 row must survive the v4 migration and read back via Project::from_row");
        assert_eq!(project.id, "o/r");
        assert_eq!(project.path.as_deref(), Some("/tmp/r"));

        let has_column: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM pragma_table_info('projects') WHERE name = 'branch_template'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 0, "branch_template column must be dropped");

        let version: i64 = db
            .conn()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);

        std::fs::remove_file(&path).ok();
    }
}
