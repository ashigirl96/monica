use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::db::Db;
use crate::model::{NewTaskRun, TaskRun, TaskRunStatus, TaskStatus};

use super::{SET_NOW, TASK_RUN_COLUMNS};

impl Db {
    pub fn update_task_run_status(
        &self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        self.conn().execute(
            &format!(
                "UPDATE task_runs SET status = ?1, updated_at = {SET_NOW} \
                 WHERE id = ?2 AND task_id = ?3"
            ),
            params![status.as_str(), task_run_id, task_id],
        )?;
        Ok(())
    }

    /// Apply hook-driven task and task-run status changes in one transaction. The task-run update
    /// is additionally scoped by `task_id`, so a task run that does not
    /// belong to this task (e.g. a mismatched env var) is never touched even if the id exists.
    pub fn apply_hook_status(
        &mut self,
        task_id: &str,
        task_run_id: Option<&str>,
        task_status: Option<TaskStatus>,
        task_run_status: Option<TaskRunStatus>,
    ) -> Result<()> {
        let tx = self.conn_mut().transaction()?;
        if let Some(status) = task_status {
            let affected = tx.execute(
                &format!("UPDATE tasks SET status = ?1, updated_at = {SET_NOW} WHERE id = ?2"),
                params![status.as_str(), task_id],
            )?;
            if affected == 0 {
                return Err(anyhow!("task not found: {task_id}"));
            }
        }
        if let (Some(task_run_id), Some(status)) = (task_run_id, task_run_status) {
            tx.execute(
                &format!(
                    "UPDATE task_runs SET status = ?1, updated_at = {SET_NOW} \
                     WHERE id = ?2 AND task_id = ?3"
                ),
                params![status.as_str(), task_run_id, task_id],
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
             WHERE id = ?2",
            params![TaskStatus::Active.as_str(), new.task_id],
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
                Some(row) => TaskRun::from_row(row)?,
                None => return Err(anyhow!("inserted task run {id} not found")),
            }
        };
        tx.commit()?;
        Ok(run)
    }

    /// Settle a task run to a terminal status (`running` / `failed`), updating both the run and
    /// its task in one transaction so the pair can never drift.
    pub fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        let task_status = match status {
            TaskRunStatus::Failed => TaskStatus::Failed,
            TaskRunStatus::SettingUp | TaskRunStatus::Running | TaskRunStatus::Stopped => {
                TaskStatus::Active
            }
        };
        let status = status.as_str();
        let tx = self.conn_mut().transaction()?;
        let run_affected = tx.execute(
            "UPDATE task_runs
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![status, task_run_id],
        )?;
        if run_affected == 0 {
            return Err(anyhow!("task run not found: {task_run_id}"));
        }
        let item_affected = tx.execute(
            "UPDATE tasks
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![task_status.as_str(), task_id],
        )?;
        if item_affected == 0 {
            return Err(anyhow!("task not found: {task_id}"));
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

    pub fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {TASK_RUN_COLUMNS} FROM task_runs WHERE id = ?1"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(TaskRun::from_row(row)?)),
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
            runs.push(TaskRun::from_row(row)?);
        }
        Ok(runs)
    }
}
