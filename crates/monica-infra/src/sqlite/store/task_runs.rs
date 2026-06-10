use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::sqlite::SqliteStore;
use monica_core::{NewTaskRun, TaskRun, TaskRunObservation, TaskRunStatus, TaskStatus};

use super::{SET_NOW, TASK_RUN_COLUMNS};

impl SqliteStore {
    pub fn update_task_run_status(
        &self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        self.conn().execute(
            &format!(
                "UPDATE task_runs SET status = ?1, wait_reason = NULL, updated_at = {SET_NOW} \
                 WHERE id = ?2 AND task_id = ?3"
            ),
            params![status.as_str(), task_run_id, task_id],
        )?;
        Ok(())
    }

    /// Apply a hook observation to a task run. TaskRun is the lifecycle source of truth; the owning
    /// task is only kept in `in_progress` while a non-deleted, non-done run is being observed.
    pub fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        let metadata = observation
            .metadata
            .map(serde_json::to_string)
            .transpose()?;
        let status = observation.status.map(|s| s.as_str());
        let update_wait_reason = observation.wait_reason.is_some();
        let wait_reason = observation.wait_reason.flatten().map(|r| r.as_str());
        let tx = self.conn_mut().transaction()?;
        let affected = tx.execute(
            &format!(
                "UPDATE task_runs
                    SET status = COALESCE(?1, status),
                        wait_reason = CASE WHEN ?2 THEN ?3 ELSE wait_reason END,
                        last_event_name = COALESCE(?4, last_event_name),
                        last_event_at = ?5,
                        provider_session_id = COALESCE(?6, provider_session_id),
                        terminal_tab_id = COALESCE(?7, terminal_tab_id),
                        metadata_json = COALESCE(?8, metadata_json),
                        updated_at = {SET_NOW}
                  WHERE id = ?9"
            ),
            params![
                status,
                update_wait_reason,
                wait_reason,
                observation.event_name,
                observation.at,
                observation.provider_session_id,
                observation.terminal_tab_id,
                metadata,
                task_run_id
            ],
        )?;
        if affected == 0 {
            return Err(anyhow!("task run not found: {task_run_id}"));
        }
        if status.is_some() {
            tx.execute(
                &format!(
                    "UPDATE tasks
                        SET status = ?1,
                            updated_at = {SET_NOW}
                      WHERE id = (SELECT task_id FROM task_runs WHERE id = ?2)
                        AND status != ?3
                        AND deleted_at IS NULL"
                ),
                params![
                    TaskStatus::InProgress.as_str(),
                    task_run_id,
                    TaskStatus::Done.as_str()
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
        let agent = new.agent.map(|a| a.as_str());
        let setting_up = TaskRunStatus::SettingUp.as_str();

        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO task_run_counter DEFAULT VALUES", [])?;
        let id = format!("run-{}", tx.last_insert_rowid());
        tx.execute(
            "INSERT INTO task_runs (id, task_id, agent, branch, worktree_path, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                new.task_id,
                agent,
                new.branch,
                new.worktree_path,
                setting_up,
            ],
        )?;
        let affected = tx.execute(
            "UPDATE tasks
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2 AND deleted_at IS NULL",
            params![TaskStatus::InProgress.as_str(), new.task_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("task not found: {}", new.task_id));
        }

        let run = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {TASK_RUN_COLUMNS} FROM task_runs WHERE id = ?1"
            ))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => crate::sqlite::row::task_run_from_row(row)?,
                None => return Err(anyhow!("inserted task run {id} not found")),
            }
        };
        tx.commit()?;
        Ok(run)
    }

    /// Settle a task run, updating both the run and its task in one transaction so the pair can
    /// never drift. Run failures stay at the run layer; the task remains `in_progress`.
    pub fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        let status = status.as_str();
        let tx = self.conn_mut().transaction()?;
        let run_affected = tx.execute(
            "UPDATE task_runs
               SET status = ?1,
                   wait_reason = NULL,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2 AND task_id = ?3",
            params![status, task_run_id, task_id],
        )?;
        if run_affected == 0 {
            return Err(anyhow!("task run not found: {task_run_id}"));
        }
        let item_affected = tx.execute(
            "UPDATE tasks
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2 AND deleted_at IS NULL AND status != ?3",
            params![
                TaskStatus::InProgress.as_str(),
                task_id,
                TaskStatus::Done.as_str()
            ],
        )?;
        if item_affected == 0 {
            let exists: i64 = tx.query_row(
                "SELECT count(*) FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
                params![task_id],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(anyhow!("task not found: {task_id}"));
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Recording `settings_path` is not a status transition, so it stays out of `finish_task_run` and
    /// runs as a single UPDATE on its own.
    pub fn set_task_run_settings_path(&self, task_run_id: &str, settings_path: &str) -> Result<()> {
        let affected = self.conn().execute(
            "UPDATE task_runs
               SET settings_path = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![settings_path, task_run_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("task run not found: {task_run_id}"));
        }
        Ok(())
    }

    pub fn set_task_run_worktree_path(&self, task_run_id: &str, worktree_path: &str) -> Result<()> {
        let affected = self.conn().execute(
            &format!(
                "UPDATE task_runs
                   SET worktree_path = ?1, updated_at = {SET_NOW}
                 WHERE id = ?2"
            ),
            params![worktree_path, task_run_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("task run not found: {task_run_id}"));
        }
        Ok(())
    }

    pub fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {TASK_RUN_COLUMNS} FROM task_runs WHERE id = ?1"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(crate::sqlite::row::task_run_from_row(row)?)),
            None => Ok(None),
        }
    }

    /// Latest run observed for a Claude session. Scoped to a task so an (unlikely) session id
    /// collision across tasks cannot cross-link runs.
    pub fn find_task_run_by_session(
        &self,
        task_id: &str,
        provider_session_id: &str,
    ) -> Result<Option<TaskRun>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {TASK_RUN_COLUMNS} FROM task_runs
             WHERE task_id = ?1 AND provider_session_id = ?2
             ORDER BY created_at DESC, CAST(SUBSTR(id, 5) AS INTEGER) DESC
             LIMIT 1"
        ))?;
        let mut rows = stmt.query(params![task_id, provider_session_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(crate::sqlite::row::task_run_from_row(row)?)),
            None => Ok(None),
        }
    }

    /// Latest run whose Claude session was observed in the given Workbench tab. Restarting
    /// `claude` in the same tab leaves stale tab ids on older runs, so newest wins.
    pub fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {TASK_RUN_COLUMNS} FROM task_runs
             WHERE terminal_tab_id = ?1
             ORDER BY created_at DESC, CAST(SUBSTR(id, 5) AS INTEGER) DESC
             LIMIT 1"
        ))?;
        let mut rows = stmt.query(params![terminal_tab_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(crate::sqlite::row::task_run_from_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_task_runs_for_task(&self, task_id: &str) -> Result<Vec<TaskRun>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {TASK_RUN_COLUMNS} FROM task_runs
             WHERE task_id = ?1
             ORDER BY created_at, CAST(SUBSTR(id, 5) AS INTEGER)"
        ))?;
        let mut rows = stmt.query(params![task_id])?;
        let mut runs = Vec::new();
        while let Some(row) = rows.next()? {
            runs.push(crate::sqlite::row::task_run_from_row(row)?);
        }
        Ok(runs)
    }
}
