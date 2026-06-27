use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};

use crate::sqlite::SqliteStore;
use monica_application::{
    plan_file_path_from_payload, subagents_in_flight_after, transition_is_generic_wait,
    HookTransition, NewTaskRun, TaskRun, TaskRunObservation, TaskRunStatus, TaskRunStore,
    TaskRunWaitReason, TaskStatus,
};

use super::{sql_literal_list, SET_NOW, TASK_RUN_COLUMNS};

/// Keep the owning task pinned to in_progress while a run progresses. Returns false when no
/// row changed (closed task or missing id).
fn keep_task_in_progress(conn: &Connection, task_id: &str) -> Result<bool> {
    let affected = conn.execute(
        &format!(
            "UPDATE tasks SET status = ?1, updated_at = {SET_NOW}
             WHERE id = ?2 AND status != ?3"
        ),
        params![
            TaskStatus::InProgress.as_str(),
            task_id,
            TaskStatus::Closed.as_str()
        ],
    )?;
    Ok(affected > 0)
}

fn require_task_exists(conn: &Connection, task_id: &str) -> Result<()> {
    let exists: i64 = conn.query_row(
        "SELECT count(*) FROM tasks WHERE id = ?1",
        params![task_id],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Err(anyhow!("task not found: {task_id}"));
    }
    Ok(())
}

/// Sessions and tabs are pinned to runs by hook observations, so "latest" means the most
/// recent observation, not creation order: resuming an old session in a tab must beat a
/// newer-created run whose stamp is stale.
pub(super) fn find_latest_observed_task_run(
    conn: &Connection,
    filter: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Option<TaskRun>> {
    let mut stmt = conn.prepare(&format!(
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

/// Runs that believe a terminal tab is still driving them: Running, WaitingForUser, or a
/// SettingUp run already claimed by a Claude session. These feed the orphan sweep — when
/// such a run's tab has no live session left, no hook or Exit broadcast is coming for it.
pub(super) fn list_driven_task_runs_with_tab(conn: &Connection) -> Result<Vec<TaskRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_RUN_COLUMNS} FROM task_runs
         WHERE terminal_tab_id IS NOT NULL
           AND (status IN ('{}', '{}')
                OR (status = '{}' AND provider_session_id IS NOT NULL))",
        TaskRunStatus::Running.as_str(),
        TaskRunStatus::WaitingForUser.as_str(),
        TaskRunStatus::SettingUp.as_str(),
    ))?;
    let mut rows = stmt.query([])?;
    let mut runs = Vec::new();
    while let Some(row) = rows.next()? {
        runs.push(crate::sqlite::row::task_run_from_row(row)?);
    }
    Ok(runs)
}

/// Settle a run as Stopped because its terminal died, but only while it is still live.
/// The status precondition lives in the WHERE clause so a SessionEnd → Stopped hook landing
/// concurrently can never be overwritten; `Ok(false)` means someone else settled it first
/// and the caller has nothing to announce.
pub(super) fn settle_task_run_if_live_in(
    conn: &Connection,
    task_run_id: &str,
    task_id: &str,
) -> Result<bool> {
    let affected = conn.execute(
        &format!(
            "UPDATE task_runs
               SET status = '{}',
                   wait_reason = NULL,
                   pending_stop = 0,
                   updated_at = {SET_NOW}
             WHERE id = ?1 AND task_id = ?2
               AND (status IN ('{}', '{}')
                    OR (status = '{}' AND provider_session_id IS NOT NULL))",
            TaskRunStatus::Stopped.as_str(),
            TaskRunStatus::Running.as_str(),
            TaskRunStatus::WaitingForUser.as_str(),
            TaskRunStatus::SettingUp.as_str(),
        ),
        params![task_run_id, task_id],
    )?;
    if affected > 0 {
        // A closed task's runs still deserve their tombstone (same silent no-op as hook
        // observations); erroring here would roll the settlement back and leave the run
        // live forever.
        keep_task_in_progress(conn, task_id)?;
    }
    Ok(affected > 0)
}

/// Apply a hook observation to a task run. TaskRun is the lifecycle source of truth; the owning
/// task is only kept in `in_progress` while a non-closed run is being observed.
///
/// The status/wait_reason CASE guards re-enforce `transition_is_protected` atomically: hooks
/// run in separate processes, so the caller's snapshot check alone cannot stop a late Stop
/// from resurrecting a run that SessionEnd (or terminal-exit settlement) just stopped.
pub(super) fn record_task_run_observation_in(
    conn: &Connection,
    task_run_id: &str,
    observation: TaskRunObservation<'_>,
) -> Result<()> {
    let metadata = observation
        .metadata
        .map(serde_json::to_string)
        .transpose()?;
    // Kept sticky via COALESCE in the UPDATE: a later hook yields None and must not wipe the path.
    let plan_file_path = plan_file_path_from_payload(observation.metadata);
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
    let terminal_verdict = observation.status.is_some_and(TaskRunStatus::is_terminal);
    // `background_tasks` (carried on every Stop/SubagentStop) is the source of truth for the
    // subagent guard — no derived counter to drift. A `Stop` arriving while a subagent is still
    // in flight is held; the `SubagentStop` that leaves nothing in flight releases the deferred
    // transition. `subagents_in_flight_after` excludes a SubagentStop's own (still-listed) agent.
    let hold_stop = observation.event_name == Some("Stop")
        && subagents_in_flight_after(observation.event_name, observation.metadata);
    let release_stop = observation.event_name == Some("SubagentStop")
        && !subagents_in_flight_after(observation.event_name, observation.metadata);
    let tool_waits =
        sql_literal_list(TaskRunWaitReason::TOOL_WAITS.iter().map(|r| r.as_str()));
    // `?6 IS NULL OR provider_session_id IS ?6` scopes the generic-wait guards to events
    // from the run's recorded session (or anonymous ones); a session the run never saw is
    // fresh evidence of life and passes through. A terminal verdict (?11) is scoped the
    // other way: it belongs to the session that died, so it is refused when it arrives
    // from a session that is not the run's current one.
    let stopped = TaskRunStatus::Stopped.as_str();
    let waiting_for_user = TaskRunStatus::WaitingForUser.as_str();
    let running = TaskRunStatus::Running.as_str();
    let awaiting_prompt = TaskRunWaitReason::AwaitingPrompt.as_str();
    let protected = format!(
        "(?11 AND ?6 IS NOT NULL
              AND provider_session_id IS NOT NULL
              AND provider_session_id != ?6)
         OR (?10 AND (?6 IS NULL OR provider_session_id IS ?6)
                 AND (status = '{stopped}'
                      OR (status = '{waiting_for_user}'
                          AND wait_reason IN ({tool_waits}))))
         OR ?12",
    );
    let affected = conn.execute(
        &format!(
            "UPDATE task_runs
                SET status = CASE WHEN {protected} THEN status
                                  WHEN ?13 AND pending_stop = 1
                                  THEN '{waiting_for_user}'
                                  ELSE COALESCE(?1, status) END,
                    wait_reason = CASE WHEN {protected} THEN wait_reason
                                       WHEN ?13 AND pending_stop = 1
                                       THEN '{awaiting_prompt}'
                                       WHEN ?2 THEN ?3 ELSE wait_reason END,
                    last_event_name = COALESCE(?4, last_event_name),
                    last_event_at = ?5,
                    -- a protected straggler must not re-stamp its dead session over the
                    -- successor's id, or its next straggler would look same-session
                    provider_session_id = CASE WHEN {protected} THEN provider_session_id
                                               ELSE COALESCE(?6, provider_session_id) END,
                    terminal_tab_id = COALESCE(?7, terminal_tab_id),
                    pending_stop = CASE
                        WHEN ?12 AND status = '{running}' THEN 1
                        WHEN ?13 THEN 0
                        WHEN NOT ({protected}) AND ?1 IS NOT NULL THEN 0
                        ELSE pending_stop END,
                    metadata_json = COALESCE(?8, metadata_json),
                    plan_file_path = COALESCE(?14, plan_file_path),
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
            generic_wait,
            terminal_verdict,
            hold_stop,
            release_stop,
            plan_file_path
        ],
    )?;
    if affected == 0 {
        return Err(anyhow!("task run not found: {task_run_id}"));
    }
    if status.is_some() {
        let task_id: String = conn.query_row(
            "SELECT task_id FROM task_runs WHERE id = ?1",
            params![task_run_id],
            |row| row.get(0),
        )?;
        // Hooks may observe runs of closed tasks; that stays a silent no-op.
        keep_task_in_progress(conn, &task_id)?;
    }
    Ok(())
}

pub(super) fn start_task_run_in(conn: &Connection, new: NewTaskRun) -> Result<TaskRun> {
    let agent = new.agent.map(|a| a.as_str());
    let setting_up = TaskRunStatus::SettingUp.as_str();

    conn.execute("INSERT INTO task_run_counter DEFAULT VALUES", [])?;
    let id = format!("run-{}", conn.last_insert_rowid());
    conn.execute(
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
    if !keep_task_in_progress(conn, &new.task_id)? {
        require_task_exists(conn, &new.task_id)?;
    }

    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_RUN_COLUMNS} FROM task_runs WHERE id = ?1"
    ))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(crate::sqlite::row::task_run_from_row(row)?),
        None => Err(anyhow!("inserted task run {id} not found")),
    }
}

/// Settle a task run, updating both the run and its task in one transaction so the pair can
/// never drift. Run failures stay at the run layer; the task remains `in_progress`.
pub(super) fn finish_task_run_in(
    conn: &Connection,
    task_run_id: &str,
    task_id: &str,
    status: TaskRunStatus,
) -> Result<()> {
    let status = status.as_str();
    let run_affected = conn.execute(
        &format!(
            "UPDATE task_runs
               SET status = ?1,
                   wait_reason = NULL,
                   pending_stop = 0,
                   updated_at = {SET_NOW}
             WHERE id = ?2 AND task_id = ?3"
        ),
        params![status, task_run_id, task_id],
    )?;
    if run_affected == 0 {
        return Err(anyhow!("task run not found: {task_run_id}"));
    }
    if !keep_task_in_progress(conn, task_id)? {
        require_task_exists(conn, task_id)?;
    }
    Ok(())
}

/// Recording `settings_path` is not a status transition, so it stays out of `finish_task_run` and
/// runs as a single UPDATE on its own.
pub(super) fn set_task_run_settings_path(
    conn: &Connection,
    task_run_id: &str,
    settings_path: &str,
) -> Result<()> {
    let affected = conn.execute(
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

pub(super) fn set_task_run_worktree_path(
    conn: &Connection,
    task_run_id: &str,
    worktree_path: &str,
) -> Result<()> {
    let affected = conn.execute(
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

pub(super) fn get_task_run(conn: &Connection, id: &str) -> Result<Option<TaskRun>> {
    let mut stmt = conn.prepare(&format!(
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
pub(super) fn find_task_run_by_session(
    conn: &Connection,
    task_id: &str,
    provider_session_id: &str,
) -> Result<Option<TaskRun>> {
    find_latest_observed_task_run(
        conn,
        "task_id = ?1 AND provider_session_id = ?2",
        params![task_id, provider_session_id],
    )
}

/// Latest run whose Claude session was observed in the given Workbench tab. Restarting
/// `claude` in the same tab leaves stale tab ids on older runs, so the most recently
/// observed run wins.
pub(super) fn find_task_run_by_terminal_tab(
    conn: &Connection,
    terminal_tab_id: &str,
) -> Result<Option<TaskRun>> {
    find_latest_observed_task_run(conn, "terminal_tab_id = ?1", params![terminal_tab_id])
}

pub(super) fn list_task_runs_for_task(conn: &Connection, task_id: &str) -> Result<Vec<TaskRun>> {
    let mut stmt = conn.prepare(&format!(
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

/// Atomic claim of a still-`prepared`, unclaimed run for a session. The status + NULL guard lives
/// in the WHERE clause, so of two near-simultaneous SessionStarts only the one whose UPDATE lands
/// (1 row) wins; the other sees 0 rows. `last_event_at` is left to the observation that follows.
pub(super) fn claim_prepared_run(
    conn: &Connection,
    task_run_id: &str,
    provider_session_id: &str,
) -> Result<bool> {
    let affected = conn.execute(
        &format!(
            "UPDATE task_runs
               SET provider_session_id = ?2, updated_at = {SET_NOW}
             WHERE id = ?1
               AND status = '{}'
               AND provider_session_id IS NULL",
            TaskRunStatus::Prepared.as_str(),
        ),
        params![task_run_id, provider_session_id],
    )?;
    Ok(affected == 1)
}

impl TaskRunStore for SqliteStore {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
        let tx = self.conn_mut().transaction()?;
        let run = start_task_run_in(&tx, new)?;
        tx.commit()?;
        Ok(run)
    }

    fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        let tx = self.conn_mut().transaction()?;
        finish_task_run_in(&tx, task_run_id, task_id, status)?;
        tx.commit()?;
        Ok(())
    }

    fn set_task_run_settings_path(&self, task_run_id: &str, settings_path: &str) -> Result<()> {
        set_task_run_settings_path(self.conn(), task_run_id, settings_path)
    }

    fn set_task_run_worktree_path(&self, task_run_id: &str, worktree_path: &str) -> Result<()> {
        set_task_run_worktree_path(self.conn(), task_run_id, worktree_path)
    }

    fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
        get_task_run(self.conn(), id)
    }

    fn find_task_run_by_session(
        &self,
        task_id: &str,
        provider_session_id: &str,
    ) -> Result<Option<TaskRun>> {
        find_task_run_by_session(self.conn(), task_id, provider_session_id)
    }

    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>> {
        find_task_run_by_terminal_tab(self.conn(), terminal_tab_id)
    }

    fn list_task_runs_for_task(&self, task_id: &str) -> Result<Vec<TaskRun>> {
        list_task_runs_for_task(self.conn(), task_id)
    }

    fn list_driven_task_runs_with_tab(&self) -> Result<Vec<TaskRun>> {
        list_driven_task_runs_with_tab(self.conn())
    }

    fn settle_task_run_if_live(&mut self, task_run_id: &str, task_id: &str) -> Result<bool> {
        let tx = self.conn_mut().transaction()?;
        let settled = settle_task_run_if_live_in(&tx, task_run_id, task_id)?;
        tx.commit()?;
        Ok(settled)
    }

    fn claim_prepared_run(&self, task_run_id: &str, provider_session_id: &str) -> Result<bool> {
        claim_prepared_run(self.conn(), task_run_id, provider_session_id)
    }

    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        let tx = self.conn_mut().transaction()?;
        record_task_run_observation_in(&tx, task_run_id, observation)?;
        tx.commit()?;
        Ok(())
    }
}
