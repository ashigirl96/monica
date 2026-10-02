use anyhow::Result;

use monica_domain::{CloseHold, RunspaceId, TaskId};

/// The per-task workbench (a runspace + its working directory). Composed into
/// [`WorkTransaction`](super::WorkTransaction) so run preparation can create the bench atomically
/// with the run it belongs to.
pub trait WorkbenchStore {
    fn get_bench_for_task(&self, task_id: &TaskId) -> Result<Option<(RunspaceId, String)>>;
    fn list_bench_runspace_map(&self) -> Result<Vec<(RunspaceId, TaskId)>>;
    fn create_bench(
        &mut self,
        task_id: &TaskId,
        runspace_id: &RunspaceId,
        cwd: &str,
    ) -> Result<()>;
    fn update_bench_cwd(&self, task_id: &TaskId, cwd: &str) -> Result<()>;
    fn delete_bench_for_task(&self, task_id: &TaskId) -> Result<()>;
    fn list_close_holds(&self) -> Result<Vec<CloseHold>>;
    /// `None` drops whatever hold the task had.
    fn replace_close_hold(&self, task_id: &TaskId, hold: Option<&CloseHold>) -> Result<()>;
}
