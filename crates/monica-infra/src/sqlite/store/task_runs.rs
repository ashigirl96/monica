use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::sqlite::SqliteStore;
use monica_core::{
    transition_is_generic_wait, HookTransition, NewTaskRun, TaskRun, TaskRunObservation,
    TaskRunRepository, TaskRunStatus, TaskRunWaitReason, TaskStatus,
};

use super::{SET_NOW, TASK_RUN_COLUMNS};

/// Keep the owning task pinned to in_progress while a run progresses. Returns false when no
/// row changed (deleted task, done task, or missing id).
fn keep_task_in_progress(tx: &rusqlite::Transaction<'_>, task_id: &str) -> Result<bool> {
    let affected = tx.execute(
        &format!(
            "UPDATE tasks SET status = ?1, updated_at = {SET_NOW}
             WHERE id = ?2 AND deleted_at IS NULL AND status != ?3"
        ),
        params![
            TaskStatus::InProgress.as_str(),
            task_id,
            TaskStatus::Done.as_str()
        ],
    )?;
    Ok(affected > 0)
}

fn require_task_exists(tx: &rusqlite::Transaction<'_>, task_id: &str) -> Result<()> {
    let exists: i64 = tx.query_row(
        "SELECT count(*) FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
        params![task_id],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Err(anyhow!("task not found: {task_id}"));
    }
    Ok(())
}

impl SqliteStore {
    /// Sessions and tabs are pinned to runs by hook observations, so "latest" means the most
    /// recent observation, not creation order: resuming an old session in a tab must beat a
    /// newer-created run whose stamp is stale.
    fn find_latest_observed_task_run(
        &self,
        filter: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Option<TaskRun>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {TASK_RUN_COLUMNS} FROM task_runs
             WHERE {filter}
             ORDER BY last_event_at DESC, created_at DESC,
                      CAST(SUBSTR(id, 5) AS INTEGER) DESC
             LIMIT 1"
        ))?;
        let mut rows = stmt.query(params)?;
        match rows.next()? {
            Some(row) => Ok(Some(crate::sqlite::row::task_run_from_row(row)?)),
            None => Ok(None),
        }
    }
}

impl TaskRunRepository for SqliteStore {
    /// Apply a hook observation to a task run. TaskRun is the lifecycle source of truth; the owning
    /// task is only kept in `in_progress` while a non-deleted, non-done run is being observed.
    ///
    /// The status/wait_reason CASE guards re-enforce `transition_is_protected` atomically: hooks
    /// run in separate processes, so the caller's snapshot check alone cannot stop a late Stop
    /// from resurrecting a run that SessionEnd (or terminal-exit settlement) just stopped.
    fn record_task_run_observation(
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
        let generic_wait = match (observation.status, observation.wait_reason) {
            (Some(status), Some(wait_reason)) => transition_is_generic_wait(HookTransition {
                status,
                wait_reason,
            }),
            _ => false,
        };
        let failed = TaskRunStatus::Failed.as_str();
        let stopped = TaskRunStatus::Stopped.as_str();
        let ask_user_question = TaskRunWaitReason::AskUserQuestion.as_str();
        let exit_plan_mode = TaskRunWaitReason::ExitPlanMode.as_str();
        let protected = format!(
            "status = '{failed}'
             OR (?10 AND (status = '{stopped}'
                          OR wait_reason IN ('{ask_user_question}', '{exit_plan_mode}')))"
        );
        let tx = self.conn_mut().transaction()?;
        let affected = tx.execute(
            &format!(
                "UPDATE task_runs
                    SET status = CASE WHEN {protected} THEN status
                                      ELSE COALESCE(?1, status) END,
                        wait_reason = CASE WHEN {protected} THEN wait_reason
                                           WHEN ?2 THEN ?3 ELSE wait_reason END,
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
                task_run_id,
                generic_wait
            ],
        )?;
        if affected == 0 {
            return Err(anyhow!("task run not found: {task_run_id}"));
        }
        if status.is_some() {
            let task_id: String = tx.query_row(
                "SELECT task_id FROM task_runs WHERE id = ?1",
                params![task_run_id],
                |row| row.get(0),
            )?;
            // Hooks may observe runs of deleted tasks; that stays a silent no-op.
            keep_task_in_progress(&tx, &task_id)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
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
        if !keep_task_in_progress(&tx, &new.task_id)? {
            require_task_exists(&tx, &new.task_id)?;
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
    fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        let status = status.as_str();
        let tx = self.conn_mut().transaction()?;
        let run_affected = tx.execute(
            &format!(
                "UPDATE task_runs
                   SET status = ?1,
                       wait_reason = NULL,
                       updated_at = {SET_NOW}
                 WHERE id = ?2 AND task_id = ?3"
            ),
            params![status, task_run_id, task_id],
        )?;
        if run_affected == 0 {
            return Err(anyhow!("task run not found: {task_run_id}"));
        }
        if !keep_task_in_progress(&tx, task_id)? {
            require_task_exists(&tx, task_id)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Recording `settings_path` is not a status transition, so it stays out of `finish_task_run` and
    /// runs as a single UPDATE on its own.
    fn set_task_run_settings_path(&self, task_run_id: &str, settings_path: &str) -> Result<()> {
        let affected = self.conn().execute(
            &format!(
                "UPDATE task_runs
                   SET settings_path = ?1, updated_at = {SET_NOW}
                 WHERE id = ?2"
            ),
            params![settings_path, task_run_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("task run not found: {task_run_id}"));
        }
        Ok(())
    }

    fn set_task_run_worktree_path(&self, task_run_id: &str, worktree_path: &str) -> Result<()> {
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

    fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
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
    fn find_task_run_by_session(
        &self,
        task_id: &str,
        provider_session_id: &str,
    ) -> Result<Option<TaskRun>> {
        self.find_latest_observed_task_run(
            "task_id = ?1 AND provider_session_id = ?2",
            params![task_id, provider_session_id],
        )
    }

    /// Latest run whose Claude session was observed in the given Workbench tab. Restarting
    /// `claude` in the same tab leaves stale tab ids on older runs, so the most recently
    /// observed run wins.
    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>> {
        self.find_latest_observed_task_run("terminal_tab_id = ?1", params![terminal_tab_id])
    }

    fn list_task_runs_for_task(&self, task_id: &str) -> Result<Vec<TaskRun>> {
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
