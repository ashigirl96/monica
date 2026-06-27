use monica_domain::{TaskRunStatus, TaskRunWaitReason};

/// A decoded hook observation applied to an existing [`TaskRun`](monica_domain::TaskRun). The
/// provider payload has already been interpreted into typed fields by the adapter decoder and the
/// domain state machine; the raw text is carried only for verbatim storage, never re-parsed.
#[derive(Debug, Clone, Copy)]
pub struct TaskRunObservation<'a> {
    pub status: Option<TaskRunStatus>,
    pub wait_reason: Option<Option<TaskRunWaitReason>>,
    /// The opaque provider event name, stored as `last_event_name` for display/debug only.
    pub event_label: Option<&'a str>,
    pub at: &'a str,
    pub provider_session_id: Option<&'a str>,
    pub terminal_tab_id: Option<&'a str>,
    /// The trimmed raw hook payload, stored verbatim into `metadata_json`. `None` leaves the column.
    pub metadata_raw: Option<&'a str>,
    /// The plan file an `ExitPlanMode` surfaced. Sticky in the store (COALESCE): `None` never wipes a
    /// path already recorded.
    pub plan_file_path: Option<&'a str>,
    /// A turn-complete arrived while a subagent was still in flight: the store holds the run
    /// (`pending_stop = 1`) instead of demoting it to "your turn".
    pub hold_stop: bool,
    /// The last subagent finished: the store releases a held turn-complete, firing the deferred
    /// transition atomically.
    pub release_stop: bool,
}
