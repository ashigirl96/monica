use anyhow::Result;

/// The per-task workbench (a runspace + its working directory). Composed into
/// [`WorkTransaction`](super::WorkTransaction) so run preparation can create the bench atomically
/// with the run it belongs to.
pub trait WorkbenchStore {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>>;
    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>>;
    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()>;
    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()>;
}
