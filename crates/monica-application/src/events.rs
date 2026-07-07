use monica_domain::{TaskRunStatus, TaskRunWaitReason};

/// Domain-level notifications a use case emits as a side effect of a state change. Each driver
/// renders them in its own medium (Tauri event, OS notification, log) through an [`EventSink`],
/// so application code never reaches for `AppHandle` or `osascript` directly.
///
/// High-frequency PTY byte/exit streams are NOT modelled here — they stay in the desktop's ptyd
/// adapter as raw webview events.
#[derive(Debug, Clone)]
pub enum ApplicationEvent {
    TaskRunStatusChanged {
        task_id: String,
        task_run_id: String,
        status: TaskRunStatus,
    },
    PullRequestSyncCompleted {
        synced_count: u32,
    },
    AwaitingUserInput {
        task_id: Option<String>,
        task_run_id: Option<String>,
        reason: Option<TaskRunWaitReason>,
        task_title: Option<String>,
    },
}

/// A driver-provided side-channel for [`ApplicationEvent`]s. `Send + Sync` so a sink built from a
/// cheap handle (e.g. a cloned Tauri `AppHandle`) can be carried into the scheduler / daemon /
/// run-execution threads that each open their own thread-local façade.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: ApplicationEvent);
}
