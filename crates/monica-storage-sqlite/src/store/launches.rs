use anyhow::Result;
use rusqlite::{params, Connection};

use crate::SqliteStore;
use monica_application::{PendingLaunchStore, RunTaskResult};
use monica_domain::{RunspaceId, TaskId, TaskRunId};

use super::SET_NOW;

const LAUNCH_COLUMNS: &str = "task_run_id, task_id, runspace_id, cwd, env_json, initial_command";

pub(super) fn put_pending_launch(conn: &Connection, launch: &RunTaskResult) -> Result<()> {
    let env_json = serde_json::to_string(&launch.env)?;
    conn.execute(
        &format!(
            "INSERT INTO task_run_launches ({LAUNCH_COLUMNS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(task_run_id) DO UPDATE SET
               task_id = excluded.task_id,
               runspace_id = excluded.runspace_id,
               cwd = excluded.cwd,
               env_json = excluded.env_json,
               initial_command = excluded.initial_command,
               created_at = {SET_NOW}"
        ),
        params![
            launch.task_run_id.as_str(),
            launch.task_id.as_str(),
            launch.runspace_id.as_str(),
            launch.cwd,
            env_json,
            launch.initial_command,
        ],
    )?;
    Ok(())
}

pub(super) fn take_pending_launches(conn: &mut Connection) -> Result<Vec<RunTaskResult>> {
    let tx = conn.transaction()?;
    let launches = {
        let mut stmt = tx.prepare(&format!(
            "SELECT {LAUNCH_COLUMNS} FROM task_run_launches ORDER BY created_at, task_run_id"
        ))?;
        let mut rows = stmt.query([])?;
        let mut launches = Vec::new();
        while let Some(row) = rows.next()? {
            let env_json: String = row.get(4)?;
            launches.push(RunTaskResult {
                task_run_id: TaskRunId::from_store(row.get(0)?),
                task_id: TaskId::from_store(row.get(1)?),
                runspace_id: RunspaceId::from_store(row.get(2)?),
                cwd: row.get(3)?,
                env: serde_json::from_str(&env_json)?,
                initial_command: row.get(5)?,
            });
        }
        launches
    };
    tx.execute("DELETE FROM task_run_launches", [])?;
    tx.commit()?;
    Ok(launches)
}

impl PendingLaunchStore for SqliteStore {
    fn put_pending_launch(&mut self, launch: &RunTaskResult) -> Result<()> {
        put_pending_launch(self.conn(), launch)
    }

    fn take_pending_launches(&mut self) -> Result<Vec<RunTaskResult>> {
        take_pending_launches(self.conn_mut())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(run: &str, command: &str) -> RunTaskResult {
        RunTaskResult {
            task_id: TaskId::from_store("MON-1".to_string()),
            task_run_id: TaskRunId::from_store(run.to_string()),
            runspace_id: RunspaceId::from_store("bench-MON-1".to_string()),
            cwd: "/wt".to_string(),
            env: vec![
                ("MONICA_TASK_ID".to_string(), "MON-1".to_string()),
                ("MONICA_TASK_RUN_ID".to_string(), run.to_string()),
            ],
            initial_command: command.to_string(),
        }
    }

    #[test]
    fn put_then_take_round_trips_and_drains() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.put_pending_launch(&launch("run-1", "claude")).unwrap();

        let taken = store.take_pending_launches().unwrap();
        assert_eq!(taken, vec![launch("run-1", "claude")]);
        assert!(store.take_pending_launches().unwrap().is_empty());
    }

    #[test]
    fn put_for_the_same_run_replaces_the_earlier_request() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.put_pending_launch(&launch("run-1", "claude")).unwrap();
        store
            .put_pending_launch(&launch("run-1", "claude --resume s1"))
            .unwrap();

        let taken = store.take_pending_launches().unwrap();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].initial_command, "claude --resume s1");
    }

    #[test]
    fn take_returns_launches_in_request_order() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.put_pending_launch(&launch("run-2", "claude")).unwrap();
        store
            .conn()
            .execute(
                "UPDATE task_run_launches SET created_at = '2000-01-01T00:00:00.000Z'",
                [],
            )
            .unwrap();
        store.put_pending_launch(&launch("run-1", "claude")).unwrap();

        let ids: Vec<String> = store
            .take_pending_launches()
            .unwrap()
            .into_iter()
            .map(|l| l.task_run_id.to_string())
            .collect();
        assert_eq!(ids, vec!["run-2", "run-1"]);
    }
}
