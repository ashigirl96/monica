use monica_domain::{
    ClaudeConversationStatus, ClaudeSessionStatus, TaskRunStatus, TaskRunWaitReason,
};

use crate::ports::ClaudeTranscriptRecord;

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
    /// An Agent Runtime-created terminal session exists and its Claude launch is underway; the Workbench
    /// adopts a tab bound to it. Purely observational — missing this event never blocks the
    /// session (recovery is MVP3's job).
    ClaudeSessionOpened {
        runspace_id: String,
        tab_id: String,
        session_id: String,
        claude_session_id: String,
        cwd: String,
        title: Option<String>,
    },
    AwaitingUserInput {
        task_id: Option<String>,
        task_run_id: Option<String>,
        reason: Option<TaskRunWaitReason>,
        task_title: Option<String>,
    },
    /// A Claude Runtime session's observable state moved (hook-driven). Ended is derived:
    /// `session_status == ended` wins over whatever the conversation last did.
    ClaudeSessionStateChanged {
        claude_session_id: String,
        tab_id: String,
        session_status: ClaudeSessionStatus,
        conversation_status: ClaudeConversationStatus,
        wait_reason: Option<TaskRunWaitReason>,
        subagents_running: bool,
    },
    /// New transcript records read after a completed turn (assistant text / tool uses).
    ClaudeSessionMessages {
        claude_session_id: String,
        records: Vec<ClaudeTranscriptRecord>,
    },
}

/// A driver-provided side-channel for [`ApplicationEvent`]s. `Send + Sync` so a sink built from a
/// cheap handle (e.g. a cloned Tauri `AppHandle`) can be carried into the scheduler / daemon /
/// run-execution threads that each open their own thread-local façade.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: ApplicationEvent);
}
