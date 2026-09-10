use anyhow::Result;

use crate::prelude::TaskId;
use crate::RunTaskResult;

/// Runs whose agent tab the Workbench has yet to open. The tab layout is frontend-owned, so a Run
/// requested from another process (`monica task run`) reaches the screen only through a record
/// the desktop polls; the board's own Run goes through the same record so the two paths cannot
/// drift.
pub trait PendingLaunchStore {
    /// Record (or replace) the pending launch for `launch.task_run_id`.
    fn put_pending_launch(&mut self, launch: &RunTaskResult) -> Result<()>;
    /// Remove and return every pending launch in request order.
    fn take_pending_launches(&mut self) -> Result<Vec<RunTaskResult>>;
    /// Drop every pending launch for `task_id` without returning it.
    fn remove_pending_launches_for_task(&mut self, task_id: &TaskId) -> Result<()>;
}
