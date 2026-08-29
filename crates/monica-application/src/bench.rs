use monica_domain::{RunspaceId, TaskId, TaskRunId};
use serde::Serialize;

pub fn bench_runspace_id(task_id: &TaskId) -> RunspaceId {
    RunspaceId::from_store(format!("bench-{task_id}"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskBench {
    pub task_id: TaskId,
    pub runspace_id: RunspaceId,
    pub cwd: String,
    pub created: bool,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrepareTaskResult {
    pub task_id: TaskId,
    pub task_run_id: TaskRunId,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunTaskResult {
    pub task_id: TaskId,
    pub task_run_id: TaskRunId,
    pub runspace_id: RunspaceId,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub initial_command: String,
}
