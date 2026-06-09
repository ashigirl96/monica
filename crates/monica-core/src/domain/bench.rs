use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TaskBench {
    pub task_id: String,
    pub runspace_id: String,
    pub cwd: String,
    pub created: bool,
}
