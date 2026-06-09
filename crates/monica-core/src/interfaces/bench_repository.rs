use anyhow::Result;

pub trait BenchRepository {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>>;
    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>>;
    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()>;
    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()>;
}
