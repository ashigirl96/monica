use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TaskBench {
    pub task_id: String,
    pub runspace_id: String,
    pub cwd: String,
    pub created: bool,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct PrepareTaskResult {
    pub task_id: String,
    pub task_run_id: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RunTaskResult {
    pub task_id: String,
    pub task_run_id: String,
    pub runspace_id: String,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub initial_command: String,
}
