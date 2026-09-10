use crate::ports::{PendingLaunchStore, TaskRunStore, TaskStore};
use crate::prelude::{TaskId, TaskRunStatus, TaskStatus};
use crate::usecases::tasks::primary_run;
use crate::{ApplicationResult, RunTaskResult};

/// Whether a worktree-mode Run must prepare a fresh run before launching. A prepared primary
/// launches as it stands and a stopped one with a recorded session resumes; everything else goes
/// through worktree creation and setup first.
pub fn worktree_run_needs_fresh_run<R>(repos: &R, task_id: &TaskId) -> ApplicationResult<bool>
where
    R: TaskStore + TaskRunStore,
{
    Ok(super::run_task::needs_new_run(primary_run(repos, task_id)?.as_ref()))
}

/// Drain the pending launches, keeping only those that can still be opened. A run that has since
/// failed, been claimed by a session, or disappeared has no tab to open; a task closed while the
/// launch waited keeps its run `Prepared` but has lost its worktree. Both are dropped rather than
/// left to fire later.
pub fn take_launchable_pending_launches<R>(repos: &mut R) -> ApplicationResult<Vec<RunTaskResult>>
where
    R: PendingLaunchStore + TaskRunStore + TaskStore,
{
    let mut launchable = Vec::new();
    for launch in repos.take_pending_launches()? {
        let Some(run) = repos.get_task_run(&launch.task_run_id)? else {
            continue;
        };
        if run.status != TaskRunStatus::Prepared && run.resumable_session().is_none() {
            continue;
        }
        let task_open = repos
            .get_task(&launch.task_id)?
            .is_some_and(|task| task.status != TaskStatus::Closed);
        if task_open {
            launchable.push(launch);
        }
    }
    Ok(launchable)
}
