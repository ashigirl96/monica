use anyhow::Result;
use rusqlite::{params, Connection};

use crate::SqliteStore;
use monica_application::WorkbenchStore;
use monica_domain::{CloseHold, CloseHoldRelease, RunspaceId, TaskId};

pub(super) fn get_bench_for_task(
    conn: &Connection,
    task_id: &TaskId,
) -> Result<Option<(RunspaceId, String)>> {
    let mut stmt =
        conn.prepare("SELECT runspace_id, cwd FROM \"_TaskToRunspace\" WHERE task_id = ?1")?;
    let mut rows = stmt.query(params![task_id.as_str()])?;
    match rows.next()? {
        Some(row) => Ok(Some((RunspaceId::from_store(row.get(0)?), row.get(1)?))),
        None => Ok(None),
    }
}

pub(super) fn list_bench_runspace_map(conn: &Connection) -> Result<Vec<(RunspaceId, TaskId)>> {
    let mut stmt = conn.prepare("SELECT runspace_id, task_id FROM \"_TaskToRunspace\"")?;
    let mut rows = stmt.query([])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        items.push((RunspaceId::from_store(row.get(0)?), TaskId::from_store(row.get(1)?)));
    }
    Ok(items)
}

pub(super) fn create_bench(
    conn: &Connection,
    task_id: &TaskId,
    runspace_id: &RunspaceId,
    cwd: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO \"_TaskToRunspace\" (task_id, runspace_id, cwd) VALUES (?1, ?2, ?3)",
        params![task_id.as_str(), runspace_id.as_str(), cwd],
    )?;
    Ok(())
}

pub(super) fn update_bench_cwd(conn: &Connection, task_id: &TaskId, cwd: &str) -> Result<()> {
    conn.execute(
        "UPDATE \"_TaskToRunspace\" SET cwd = ?1 WHERE task_id = ?2",
        params![cwd, task_id.as_str()],
    )?;
    Ok(())
}

pub(super) fn delete_bench_for_task(conn: &Connection, task_id: &TaskId) -> Result<()> {
    conn.execute(
        "DELETE FROM \"_TaskToRunspace\" WHERE task_id = ?1",
        params![task_id.as_str()],
    )?;
    Ok(())
}

pub(super) fn list_close_holds(conn: &Connection) -> Result<Vec<CloseHold>> {
    let mut stmt = conn.prepare(
        "SELECT task_id, terminal_tab_id, terminal_session_id, release_on
           FROM task_close_holds ORDER BY task_id",
    )?;
    let mut rows = stmt.query([])?;
    let mut holds = Vec::new();
    while let Some(row) = rows.next()? {
        let release: String = row.get(3)?;
        holds.push(CloseHold {
            task_id: TaskId::from_store(row.get(0)?),
            terminal_tab_id: row.get(1)?,
            terminal_session_id: row.get(2)?,
            release: release.parse::<CloseHoldRelease>()?,
        });
    }
    Ok(holds)
}

pub(super) fn replace_close_hold(
    conn: &Connection,
    task_id: &TaskId,
    hold: Option<&CloseHold>,
) -> Result<()> {
    match hold {
        Some(hold) => conn.execute(
            "INSERT OR REPLACE INTO task_close_holds
               (task_id, terminal_tab_id, terminal_session_id, release_on)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                task_id.as_str(),
                hold.terminal_tab_id,
                hold.terminal_session_id,
                hold.release.as_str()
            ],
        )?,
        None => conn.execute(
            "DELETE FROM task_close_holds WHERE task_id = ?1",
            params![task_id.as_str()],
        )?,
    };
    Ok(())
}

impl WorkbenchStore for SqliteStore {
    fn get_bench_for_task(&self, task_id: &TaskId) -> Result<Option<(RunspaceId, String)>> {
        get_bench_for_task(self.conn(), task_id)
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(RunspaceId, TaskId)>> {
        list_bench_runspace_map(self.conn())
    }

    fn create_bench(
        &mut self,
        task_id: &TaskId,
        runspace_id: &RunspaceId,
        cwd: &str,
    ) -> Result<()> {
        create_bench(self.conn(), task_id, runspace_id, cwd)
    }

    fn update_bench_cwd(&self, task_id: &TaskId, cwd: &str) -> Result<()> {
        update_bench_cwd(self.conn(), task_id, cwd)
    }

    fn delete_bench_for_task(&self, task_id: &TaskId) -> Result<()> {
        delete_bench_for_task(self.conn(), task_id)
    }

    fn list_close_holds(&self) -> Result<Vec<CloseHold>> {
        list_close_holds(self.conn())
    }

    fn replace_close_hold(&self, task_id: &TaskId, hold: Option<&CloseHold>) -> Result<()> {
        replace_close_hold(self.conn(), task_id, hold)
    }
}
