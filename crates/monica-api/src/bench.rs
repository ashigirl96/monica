use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TaskBench {
    pub task_id: String,
    pub runspace_id: String,
    pub cwd: String,
    pub created: bool,
    pub env: Vec<(String, String)>,
}

impl From<monica_application::TaskBench> for TaskBench {
    fn from(value: monica_application::TaskBench) -> Self {
        Self {
            task_id: value.task_id.into(),
            runspace_id: value.runspace_id.into(),
            cwd: value.cwd,
            created: value.created,
            env: value.env,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PrepareTaskResult {
    pub task_id: String,
    pub task_run_id: String,
    pub branch: String,
}

impl From<monica_application::PrepareTaskResult> for PrepareTaskResult {
    fn from(value: monica_application::PrepareTaskResult) -> Self {
        Self {
            task_id: value.task_id.into(),
            task_run_id: value.task_run_id.into(),
            branch: value.branch,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RunTaskResult {
    pub task_id: String,
    pub task_run_id: String,
    pub runspace_id: String,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub initial_command: String,
}

impl From<monica_application::RunTaskResult> for RunTaskResult {
    fn from(value: monica_application::RunTaskResult) -> Self {
        Self {
            task_id: value.task_id.into(),
            task_run_id: value.task_run_id.into(),
            runspace_id: value.runspace_id.into(),
            cwd: value.cwd,
            env: value.env,
            initial_command: value.initial_command,
        }
    }
}

/// What the Workbench needs to move a freshly attached tab into its task's runspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AttachTabResult {
    pub task_id: String,
    pub task_run_id: String,
    pub runspace_id: String,
    pub env: Vec<(String, String)>,
}

/// A live tab-driven run and the bench runspace its task owns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TabTaskBinding {
    pub terminal_tab_id: String,
    pub task_id: String,
    pub runspace_id: String,
}

impl From<monica_application::TabTaskBinding> for TabTaskBinding {
    fn from(value: monica_application::TabTaskBinding) -> Self {
        Self {
            terminal_tab_id: value.terminal_tab_id,
            task_id: value.task_id.into(),
            runspace_id: value.runspace_id.into(),
        }
    }
}
