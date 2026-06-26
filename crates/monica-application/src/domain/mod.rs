//! Facade over the domain layer for use-case code.
//!
//! The pure aggregates and rules live in the `monica-domain` crate; this module re-exports them
//! alongside the application-resident types that were historically part of `monica_core::domain`
//! (CQRS query models, GitHub adapter DTOs, hook-lifecycle parsing). Existing `crate::domain::X`
//! paths keep resolving through here so use cases need no churn.

pub use monica_domain::*;

pub use crate::bench::{bench_runspace_id, PrepareTaskResult, RunTaskResult, TaskBench};
pub use crate::github::{
    GithubAuthStatus, GithubDeviceFlow, GithubIssue, GithubPullRequest, GithubPullRequestRef,
    GithubPullRequestStatus, PullRequestBranchSyncCandidate, PullRequestStatusSyncCandidate,
    PullRequestSyncResult, PullRequestSyncStatus,
};
pub use crate::lifecycle::{
    is_continuation_session_start, is_resume_session_start, is_session_starting_event,
    plan_file_path_from_payload, should_ignore_event, subagents_in_flight_after,
    transition_for_event, transition_is_generic_wait, transition_is_protected, wait_reason_for_tool,
    HookTransition,
};
pub use crate::observation::TaskRunObservation;
pub use crate::queries::TaskSummaryRow;
