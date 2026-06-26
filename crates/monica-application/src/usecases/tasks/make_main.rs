use anyhow::Result;

use super::ports::{TaskRepository, TaskRunRepository};
use crate::TaskRunStatus;

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
pub fn make_main_by_terminal_tab<R>(repos: &R, terminal_tab_id: &str) -> Result<MakeMainOutcome>
where
    R: TaskRepository + TaskRunRepository,
{
    let Some(run) = repos.find_task_run_by_terminal_tab(terminal_tab_id)? else {
        return Ok(MakeMainOutcome::NotFound);
    };
    let Some(task) = repos.get_task(&run.task_id)? else {
        return Ok(MakeMainOutcome::NotFound);
    };
    if task.primary_task_run_id.as_deref() == Some(run.id.as_str()) {
        return Ok(MakeMainOutcome::AlreadyMain);
    }
    if let Some(current_id) = task.primary_task_run_id.as_deref() {
        if let Some(current) = repos.get_task_run(current_id)? {
            if matches!(
                current.status,
                TaskRunStatus::SettingUp | TaskRunStatus::Prepared
            ) {
                return Ok(MakeMainOutcome::PrimaryBusy);
            }
        }
    }
    repos.set_primary_task_run(&task.id, &run.id)?;
    Ok(MakeMainOutcome::Changed {
        task_id: task.id,
        task_run_id: run.id,
        status: run.status,
    })
}

/// The tab currently hosting the task's Main Run, if any — drives the Workbench tab indicator.
pub fn primary_terminal_tab<R>(repos: &R, task_id: &str) -> Result<Option<String>>
where
    R: TaskRepository + TaskRunRepository,
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
