use anyhow::Result;
use rusqlite::{params, Connection};

use crate::sqlite::SqliteStore;
use monica_application::WorkbenchStore;

pub(super) fn get_bench_for_task(
    conn: &Connection,
    task_id: &str,
) -> Result<Option<(String, String)>> {
    let mut stmt =
        conn.prepare("SELECT runspace_id, cwd FROM \"_TaskToRunspace\" WHERE task_id = ?1")?;
    let mut rows = stmt.query(params![task_id])?;
    match rows.next()? {
        Some(row) => Ok(Some((row.get(0)?, row.get(1)?))),
        None => Ok(None),
    }
}

pub(super) fn list_bench_runspace_map(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT runspace_id, task_id FROM \"_TaskToRunspace\"")?;
    let mut rows = stmt.query([])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        items.push((row.get(0)?, row.get(1)?));
    }
    Ok(items)
}

pub(super) fn create_bench(
    conn: &Connection,
    task_id: &str,
    runspace_id: &str,
    cwd: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO \"_TaskToRunspace\" (task_id, runspace_id, cwd) VALUES (?1, ?2, ?3)",
        params![task_id, runspace_id, cwd],
    )?;
    Ok(())
}

pub(super) fn update_bench_cwd(conn: &Connection, task_id: &str, cwd: &str) -> Result<()> {
    conn.execute(
        "UPDATE \"_TaskToRunspace\" SET cwd = ?1 WHERE task_id = ?2",
        params![cwd, task_id],
    )?;
    Ok(())
}

impl WorkbenchStore for SqliteStore {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>> {
        get_bench_for_task(self.conn(), task_id)
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>> {
        list_bench_runspace_map(self.conn())
    }

    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()> {
        create_bench(self.conn(), task_id, runspace_id, cwd)
    }

    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()> {
        update_bench_cwd(self.conn(), task_id, cwd)
    }
}
