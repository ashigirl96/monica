use std::collections::HashMap;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, TransactionBehavior};

pub(crate) struct Migration {
    version: &'static str,
    name: &'static str,
    sql: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/migrations_generated.rs"));

const MIGRATIONS_TABLE_DDL: &str = "
    CREATE TABLE IF NOT EXISTS _monica_migrations (
        version    TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
";

pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    let has_mgr_table = has_table(conn, "_monica_migrations")?;
    let user_table_count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
        |r| r.get(0),
    )?;

    if user_table_count > 0 && !has_mgr_table {
        bail!(
            "Legacy database detected (found {user_table_count} tables but no _monica_migrations). \
             Delete the database file and restart."
        );
    }

    conn.execute_batch(MIGRATIONS_TABLE_DDL)?;

    let applied = load_applied(conn)?;

    let known: HashMap<&str, &Migration> = MIGRATIONS.iter().map(|m| (m.version, m)).collect();
    for (version, stored_checksum) in &applied {
        match known.get(version.as_str()) {
            None => bail!(
                "Database contains unknown migration {version}. \
                 Was this database used with a newer version of Monica?"
            ),
            Some(m) => {
                let expected = fnv1a_hex(m.sql);
                if *stored_checksum != expected {
                    bail!("Migration {version} ({}) has been modified after application", m.name);
                }
            }
        }
    }

    let pending: Vec<&Migration> = MIGRATIONS
        .iter()
        .filter(|m| !applied.contains_key(m.version))
        .collect();

    if pending.is_empty() {
        return Ok(());
    }

    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    for m in pending {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(m.sql)
            .with_context(|| format!("failed to apply migration {} ({})", m.version, m.name))?;
        tx.execute(
            "INSERT INTO _monica_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![m.version, m.name, fnv1a_hex(m.sql)],
        )?;
        tx.commit()?;
    }

    Ok(())
}

fn has_table(conn: &Connection, name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        params![name],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

fn load_applied(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT version, checksum FROM _monica_migrations")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut map = HashMap::new();
    for row in rows {
        let (version, checksum): (String, String) = row?;
        map.insert(version, checksum);
    }
    Ok(map)
}

fn fnv1a_hex(s: &str) -> String {
    const BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x00000100000001B3;
    let mut hash = BASIS;
    for byte in s.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_db_applies_all_migrations() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        migrate(&mut conn).unwrap();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_monica_migrations' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        let expected = vec![
            "events",
            "external_ref_syncs",
            "external_refs",
            "github_pull_request_branch_syncs",
            "github_pull_request_ref_states",
            "mon_counter",
            "projects",
            "task_run_counter",
            "task_runs",
            "tasks",
            "terminal_runspaces",
            "terminal_tabs",
        ];
        assert_eq!(tables, expected);

        let indexes: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert!(indexes.contains(&"external_refs_github_pr_unique".to_string()));
        assert!(indexes.contains(&"github_pr_ref_states_refresh_idx".to_string()));
        assert!(indexes.contains(&"github_pr_branch_syncs_retry_idx".to_string()));
        assert!(indexes.contains(&"terminal_tabs_runspace_idx".to_string()));
    }

    #[test]
    fn idempotent_migration() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
    }

    #[test]
    fn checksum_tamper_detection() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        migrate(&mut conn).unwrap();

        conn.execute(
            "UPDATE _monica_migrations SET checksum = 'deadbeef' WHERE rowid = 1",
            [],
        )
        .unwrap();

        let err = migrate(&mut conn).unwrap_err();
        assert!(
            err.to_string().contains("modified after application"),
            "expected checksum error, got: {err}"
        );
    }

    #[test]
    fn legacy_db_detection() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE tasks (id TEXT PRIMARY KEY)")
            .unwrap();

        let err = migrate(&mut conn).unwrap_err();
        assert!(
            err.to_string().contains("Legacy database"),
            "expected legacy DB error, got: {err}"
        );
    }

    #[test]
    fn fnv1a_hex_deterministic() {
        assert_eq!(fnv1a_hex("hello"), fnv1a_hex("hello"));
        assert_ne!(fnv1a_hex("hello"), fnv1a_hex("world"));
    }
}
