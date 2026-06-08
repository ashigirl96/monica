use std::collections::{HashMap, HashSet};

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction};

const LEGACY_SQUASHED_SCHEMA_VERSION: i64 = 1;
const MIGRATION_HISTORY_TABLE: &str = "monica_schema_migrations";
const MIGRATION_HISTORY_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS monica_schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
"#;

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/sqlite_migrations.rs"));

const MONICA_INDEXES: &[&str] = &[
    "terminal_tabs_runspace_idx",
    "terminal_tabs_workspace_idx",
    "github_pr_branch_syncs_retry_idx",
    "github_pr_ref_states_refresh_idx",
    "external_refs_github_pr_unique",
];

const CURRENT_SCHEMA_INDEXES: &[&str] = &[
    "terminal_tabs_runspace_idx",
    "github_pr_branch_syncs_retry_idx",
    "github_pr_ref_states_refresh_idx",
    "external_refs_github_pr_unique",
];

const MONICA_TABLES: &[&str] = &[
    MIGRATION_HISTORY_TABLE,
    "terminal_tabs",
    "terminal_runspaces",
    "terminal_workspaces",
    "github_pull_request_branch_syncs",
    "github_pull_request_ref_states",
    "external_ref_syncs",
    "agent_sessions",
    "events",
    "external_refs",
    "task_runs",
    "runs",
    "tasks",
    "work_items",
    "projects",
    "agent_session_counter",
    "task_run_counter",
    "run_counter",
    "mon_counter",
    "monica_schema",
];

const CURRENT_SCHEMA_SMOKE_QUERIES: &[&str] = &[
    "SELECT version, applied_at FROM monica_schema LIMIT 0",
    "SELECT n FROM mon_counter LIMIT 0",
    "SELECT n FROM task_run_counter LIMIT 0",
    "SELECT id, kind, status, phase, title, body, project_id, labels, details_json, source_json, deleted_at, created_at, updated_at FROM tasks LIMIT 0",
    "SELECT id, task_id, agent, branch, worktree_path, status, wait_reason, settings_path, provider_session_id, last_event_name, last_event_at, metadata_json, created_at, updated_at FROM task_runs LIMIT 0",
    "SELECT id, task_id, task_run_id, kind, payload_json, created_at FROM events LIMIT 0",
    "SELECT id, task_id, ref_type, repo, number, url, created_at FROM external_refs LIMIT 0",
    "SELECT id, name, provider, repo, path, default_branch, worktree_root, setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude, created_at, updated_at FROM projects LIMIT 0",
    "SELECT task_id, source_ref_id, target_ref_type, last_synced_at, last_error, next_retry_at, created_at, updated_at FROM external_ref_syncs LIMIT 0",
    "SELECT external_ref_id, status, synced_at, last_error, next_retry_at, created_at, updated_at FROM github_pull_request_ref_states LIMIT 0",
    "SELECT task_id, repo, branch, last_synced_at, last_error, next_retry_at, created_at, updated_at FROM github_pull_request_branch_syncs LIMIT 0",
    "SELECT id, sort_order, is_active, created_at FROM terminal_runspaces LIMIT 0",
    "SELECT id, runspace_id, cwd, title, sort_order, is_active, created_at FROM terminal_tabs LIMIT 0",
];

/// Apply embedded Atlas-generated SQL migrations. `monica_schema` is retained only as a
/// compatibility marker for databases created by the one-shot squashed schema bootstrap.
pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    if migration_history_exists(conn)? {
        apply_pending_migrations(conn)?;
        return validate_current_schema(conn);
    }

    match marker_version(conn)? {
        Some(LEGACY_SQUASHED_SCHEMA_VERSION) => {
            baseline_legacy_squashed_schema(conn)?;
            apply_pending_migrations(conn)?;
            validate_current_schema(conn)
        }
        Some(version) => {
            bail!("database schema version {version} is not supported by this Monica build")
        }
        None if has_monica_owned_objects(conn)? => reset_monica_schema(conn),
        None => {
            apply_pending_migrations(conn)?;
            validate_current_schema(conn)
        }
    }
}

fn apply_pending_migrations(conn: &mut Connection) -> Result<()> {
    if MIGRATIONS.is_empty() {
        bail!("no SQLite migrations are embedded in this Monica build");
    }

    ensure_migration_history_table(conn)?;
    let applied = applied_migrations(conn)?;
    validate_applied_migrations(&applied)?;
    let pending = MIGRATIONS
        .iter()
        .filter(|migration| !applied.contains_key(&migration.version))
        .collect::<Vec<_>>();
    if pending.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    for migration in pending {
        tx.execute_batch(migration.sql)
            .with_context(|| format!("failed to apply SQLite migration {}", migration.name))?;
        record_migration(&tx, migration)?;
        write_marker_version(&tx, migration.version)?;
    }
    validate_current_schema(&tx)?;
    tx.commit().context("failed to commit SQLite migrations")
}

fn baseline_legacy_squashed_schema(conn: &mut Connection) -> Result<()> {
    let initial = initial_migration()?;
    ensure_migration_history_table(conn)?;
    let tx = conn.transaction()?;
    record_migration(&tx, initial)?;
    write_marker_version(&tx, initial.version)?;
    tx.commit()
        .context("failed to mark legacy SQLite schema baseline")
}

fn reset_monica_schema(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    for index in MONICA_INDEXES {
        tx.execute(&format!("DROP INDEX IF EXISTS {index}"), [])?;
    }
    for table in MONICA_TABLES {
        tx.execute(&format!("DROP TABLE IF EXISTS {table}"), [])?;
    }
    tx.commit()
        .context("failed to commit recreated database schema")?;
    apply_pending_migrations(conn)?;
    validate_current_schema(conn)
}

fn ensure_migration_history_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(MIGRATION_HISTORY_TABLE_SQL)
        .context("failed to create SQLite migration history table")
}

fn migration_history_exists(conn: &Connection) -> Result<bool> {
    table_exists(conn, MIGRATION_HISTORY_TABLE)
}

fn applied_migrations(conn: &Connection) -> Result<HashMap<i64, String>> {
    let mut stmt = conn
        .prepare("SELECT version, checksum FROM monica_schema_migrations")
        .context("failed to prepare SQLite migration history query")?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .context("failed to read SQLite migration history")?;
    let mut applied = HashMap::new();
    for row in rows {
        let (version, checksum) = row.context("failed to read SQLite migration history row")?;
        applied.insert(version, checksum);
    }
    Ok(applied)
}

fn validate_applied_migrations(applied: &HashMap<i64, String>) -> Result<()> {
    let known_versions = MIGRATIONS
        .iter()
        .map(|migration| migration.version)
        .collect::<HashSet<_>>();
    for version in applied.keys() {
        if !known_versions.contains(version) {
            bail!("database migration version {version} is not known by this Monica build");
        }
    }
    for migration in MIGRATIONS {
        if let Some(checksum) = applied.get(&migration.version) {
            let expected = migration_checksum(migration.sql);
            if checksum != &expected {
                bail!(
                    "database migration {} checksum changed after it was applied",
                    migration.name
                );
            }
        }
    }
    Ok(())
}

fn record_migration(tx: &Transaction<'_>, migration: &Migration) -> Result<()> {
    tx.execute(
        "INSERT INTO monica_schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
        (
            migration.version,
            migration.name,
            migration_checksum(migration.sql),
        ),
    )
    .with_context(|| format!("failed to record SQLite migration {}", migration.name))?;
    Ok(())
}

fn write_marker_version(tx: &Transaction<'_>, version: i64) -> Result<()> {
    tx.execute(
        "INSERT OR REPLACE INTO monica_schema (version) VALUES (?1)",
        [version],
    )?;
    Ok(())
}

fn marker_version(conn: &Connection) -> Result<Option<i64>> {
    if !table_exists(conn, "monica_schema")? {
        return Ok(None);
    }
    conn.query_row(
        "SELECT version FROM monica_schema ORDER BY version DESC LIMIT 1",
        [],
        |row| row.get(0),
    )
    .optional()
    .context("failed to read Monica schema marker")
}

fn has_monica_owned_objects(conn: &Connection) -> Result<bool> {
    for name in MONICA_TABLES.iter().chain(MONICA_INDEXES.iter()) {
        if object_exists(conn, name)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn object_exists(conn: &Connection, name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name = ?1 AND type IN ('table', 'index')",
        [name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
        [name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn validate_current_schema(conn: &Connection) -> Result<()> {
    for query in CURRENT_SCHEMA_SMOKE_QUERIES {
        conn.prepare(query)
            .with_context(|| format!("current Monica schema is missing required shape: {query}"))?;
    }
    for index in CURRENT_SCHEMA_INDEXES {
        if !object_exists(conn, index)? {
            bail!("current Monica schema is missing required index: {index}");
        }
    }
    Ok(())
}

fn initial_migration() -> Result<&'static Migration> {
    MIGRATIONS
        .first()
        .context("no initial SQLite migration is embedded in this Monica build")
}

#[cfg(test)]
fn latest_migration_version() -> Result<i64> {
    MIGRATIONS
        .last()
        .map(|migration| migration.version)
        .context("no SQLite migrations are embedded in this Monica build")
}

fn migration_checksum(sql: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in sql.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count_table_rows(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    fn migration_history_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM monica_schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    fn seed_legacy_squashed_schema(conn: &mut Connection) {
        conn.execute_batch(initial_migration().unwrap().sql)
            .unwrap();
        let tx = conn.transaction().unwrap();
        write_marker_version(&tx, LEGACY_SQUASHED_SCHEMA_VERSION).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn fresh_database_applies_embedded_migrations() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();

        for table in [
            "monica_schema",
            "mon_counter",
            "task_run_counter",
            "tasks",
            "task_runs",
            "events",
            "external_refs",
            "projects",
            "external_ref_syncs",
            "github_pull_request_ref_states",
            "github_pull_request_branch_syncs",
            "terminal_runspaces",
            "terminal_tabs",
            "monica_schema_migrations",
        ] {
            assert!(table_exists(&conn, table).unwrap(), "{table} should exist");
        }
        for index in [
            "external_refs_github_pr_unique",
            "github_pr_ref_states_refresh_idx",
            "github_pr_branch_syncs_retry_idx",
            "terminal_tabs_runspace_idx",
        ] {
            assert!(object_exists(&conn, index).unwrap(), "{index} should exist");
        }

        assert_eq!(migration_history_count(&conn), MIGRATIONS.len() as i64);
        assert_eq!(
            marker_version(&conn).unwrap(),
            Some(latest_migration_version().unwrap())
        );
        validate_current_schema(&conn).unwrap();
    }

    #[test]
    fn legacy_database_without_marker_is_recreated() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE mon_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE work_items (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              status TEXT NOT NULL,
              title TEXT NOT NULL
            );
            INSERT INTO work_items (id, kind, status, title)
            VALUES ('MON-legacy', 'development', 'active', 'legacy');
            "#,
        )
        .unwrap();

        migrate(&mut conn).unwrap();

        assert!(!table_exists(&conn, "work_items").unwrap());
        assert!(table_exists(&conn, "tasks").unwrap());
        assert_eq!(count_table_rows(&conn, "tasks"), 0);
        assert_eq!(migration_history_count(&conn), MIGRATIONS.len() as i64);
        assert_eq!(
            marker_version(&conn).unwrap(),
            Some(latest_migration_version().unwrap())
        );
    }

    #[test]
    fn legacy_squashed_schema_is_baselined_and_keeps_existing_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        seed_legacy_squashed_schema(&mut conn);
        conn.execute(
            "INSERT INTO tasks (id, kind, status, title)
             VALUES ('MON-keep', 'development', 'inbox', 'keep')",
            [],
        )
        .unwrap();

        migrate(&mut conn).unwrap();

        let title: String = conn
            .query_row("SELECT title FROM tasks WHERE id = 'MON-keep'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "keep");
        assert_eq!(migration_history_count(&conn), MIGRATIONS.len() as i64);
        assert_eq!(
            marker_version(&conn).unwrap(),
            Some(latest_migration_version().unwrap())
        );
    }

    #[test]
    fn unsupported_marker_fails_without_resetting_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        seed_legacy_squashed_schema(&mut conn);
        conn.execute(
            "INSERT INTO tasks (id, kind, status, title)
             VALUES ('MON-keep', 'development', 'inbox', 'keep')",
            [],
        )
        .unwrap();
        conn.execute("UPDATE monica_schema SET version = 999", [])
            .unwrap();

        let err = migrate(&mut conn).unwrap_err();

        assert!(format!("{err:#}").contains("database schema version 999 is not supported"));
        assert_eq!(count_table_rows(&conn, "tasks"), 1);
        assert_eq!(marker_version(&conn).unwrap(), Some(999));
    }

    #[test]
    fn current_marker_validates_required_schema_shape() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE monica_schema (
              version    INTEGER PRIMARY KEY,
              applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            INSERT INTO monica_schema (version, applied_at)
            VALUES (1, '2026-06-08T00:00:00.000Z');
            "#,
        )
        .unwrap();

        let err = migrate(&mut conn).unwrap_err();

        assert!(format!("{err:#}").contains("current Monica schema is missing required shape"));
    }

    #[test]
    fn changed_applied_migration_checksum_is_rejected() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute(
            "UPDATE monica_schema_migrations SET checksum = 'changed' WHERE version = ?1",
            [initial_migration().unwrap().version],
        )
        .unwrap();

        let err = migrate(&mut conn).unwrap_err();

        assert!(format!("{err:#}").contains("checksum changed after it was applied"));
    }

    #[test]
    fn non_monica_tables_are_left_alone() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
            INSERT INTO notes (body) VALUES ('keep me');
            "#,
        )
        .unwrap();

        migrate(&mut conn).unwrap();

        let body: String = conn
            .query_row("SELECT body FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(body, "keep me");
        assert!(table_exists(&conn, "tasks").unwrap());
    }
}
