use monica_domain::{TaskRunStatus, TaskRunWaitReason};
use serde_json::Value;

/// A provider/hook observation applied to an existing [`TaskRun`](monica_domain::TaskRun). Carries
/// the raw hook `metadata` as a borrowed `serde_json::Value` for the store and lifecycle rules to
/// interpret, which is why it lives in the application layer rather than the JSON-free domain.
#[derive(Debug, Clone, Copy)]
pub struct TaskRunObservation<'a> {
    pub status: Option<TaskRunStatus>,
    pub wait_reason: Option<Option<TaskRunWaitReason>>,
    pub event_name: Option<&'a str>,
    pub at: &'a str,
    pub provider_session_id: Option<&'a str>,
    pub terminal_tab_id: Option<&'a str>,
    pub metadata: Option<&'a Value>,
}
