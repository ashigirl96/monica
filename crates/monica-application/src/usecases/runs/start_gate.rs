use crate::github::IssueBlocker;
use crate::ports::GithubIssueSyncStore;
use crate::prelude::TaskId;
use crate::{ApplicationError, ApplicationResult};

/// The blockers GitHub still reported as unfinished as of the last sync. Freshness is bounded by
/// that sync: the gate mirrors GitHub rather than asking it, so a blocked-by edge added seconds ago
/// is invisible until the next one.
fn unresolved_blockers<R>(repos: &R, task_id: &TaskId) -> ApplicationResult<Vec<IssueBlocker>>
where
    R: GithubIssueSyncStore + ?Sized,
{
    Ok(repos
        .list_task_blockers(task_id.as_str())?
        .into_iter()
        .filter(|blocker| !blocker.is_cleared())
        .collect())
}

/// Refuse to start work on a task whose upstream issues are neither closed nor closed by a merged
/// pull request. Called where a fresh run is born rather than at a facade entry, so every way into
/// a first run — `monica task run`, the board's Run, the board's Prepare — passes it.
pub fn ensure_start_gate_open<R>(repos: &R, task_id: &TaskId) -> ApplicationResult<()>
where
    R: GithubIssueSyncStore + ?Sized,
{
    let blocking = unresolved_blockers(repos, task_id)?;
    if blocking.is_empty() {
        return Ok(());
    }
    let blockers = blocking
        .iter()
        .map(IssueBlocker::label)
        .collect::<Vec<_>>()
        .join(", ");
    Err(ApplicationError::conflict(format!(
        "task {task_id} is blocked by {blockers}; land them first or force the run"
    )))
}
