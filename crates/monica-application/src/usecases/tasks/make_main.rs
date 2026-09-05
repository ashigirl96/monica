use super::ports::{TaskRunStore, TaskStore};
use crate::prelude::{Task, TaskId, TaskRunId, TaskRunStatus};
use crate::ApplicationResult;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MakeMainOutcome {
    Changed {
        task_id: String,
        task_run_id: String,
        status: TaskRunStatus,
    },
    AlreadyMain,
    /// The current primary is mid-prepare; displacing it would orphan the prepared run and break
    /// `prepare_claude_for_run`'s prepared-primary contract.
    PrimaryBusy,
    NotFound,
}

/// Promote the run whose Claude session lives in the given Workbench tab to its task's Main Run.
/// Tabs without an observed run (a plain shell, claude never started) resolve to `NotFound` so the
/// caller can treat the action as a no-op.
pub fn make_main_by_terminal_tab<R>(repos: &R, terminal_tab_id: &str) -> ApplicationResult<MakeMainOutcome>
where
    R: TaskStore + TaskRunStore,
{
    let Some(run) = repos.find_task_run_by_terminal_tab(terminal_tab_id)? else {
        return Ok(MakeMainOutcome::NotFound);
    };
    let Some(task) = repos.get_task(&run.task_id)? else {
        return Ok(MakeMainOutcome::NotFound);
    };
    if task.primary_task_run_id.as_ref() == Some(&run.id) {
        return Ok(MakeMainOutcome::AlreadyMain);
    }
    if primary_mid_prepare(repos, &task)?.is_some() {
        return Ok(MakeMainOutcome::PrimaryBusy);
    }
    repos.set_primary_task_run(&task.id, &run.id)?;
    Ok(MakeMainOutcome::Changed {
        task_id: task.id.into(),
        task_run_id: run.id.into(),
        status: run.status,
    })
}

/// The task's primary when it must not be displaced: a run still mid-prepare (`SettingUp` or
/// `Prepared`). Pointing the task elsewhere would orphan the prepared worktree and break
/// `prepare_claude_for_run`'s prepared-primary contract. `None` when the slot is free to take.
pub(super) fn primary_mid_prepare<R>(repos: &R, task: &Task) -> ApplicationResult<Option<TaskRunId>>
where
    R: TaskRunStore + ?Sized,
{
    let Some(current_id) = task.primary_task_run_id.as_ref() else {
        return Ok(None);
    };
    let Some(current) = repos.get_task_run(current_id)? else {
        return Ok(None);
    };
    Ok(matches!(
        current.status,
        TaskRunStatus::SettingUp | TaskRunStatus::Prepared
    )
    .then(|| current_id.clone()))
}

/// The tab currently hosting the task's Main Run, if any — drives the Workbench tab indicator.
pub fn primary_terminal_tab<R>(repos: &R, task_id: &TaskId) -> ApplicationResult<Option<String>>
where
    R: TaskStore + TaskRunStore,
{
    let Some(task) = repos.get_task(task_id)? else {
        return Ok(None);
    };
    let Some(primary_id) = task.primary_task_run_id else {
        return Ok(None);
    };
    Ok(repos
        .get_task_run(&primary_id)?
        .and_then(|run| run.terminal_tab_id))
}
