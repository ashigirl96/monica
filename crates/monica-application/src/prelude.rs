//! Import surface for use-case code.
//!
//! The pure aggregates and rules live in the `monica-domain` crate; this module re-exports them
//! alongside the application-resident types that sit just outside the domain (CQRS query models,
//! GitHub adapter DTOs, hook-lifecycle parsing). Use cases import everything they need from
//! `crate::prelude` regardless of which side a given type lives on.

pub use monica_domain::*;

pub use crate::bench::{bench_runspace_id, PrepareTaskResult, RunTaskResult, TaskBench};
pub use crate::github::{
    GithubAuthStatus, GithubDeviceFlow, GithubIssue, GithubPullRequest, GithubPullRequestRef,
    GithubPullRequestStatus, PullRequestBranchSyncCandidate, PullRequestStatusSyncCandidate,
    PullRequestSyncResult, PullRequestSyncStatus,
};
pub use crate::observation::TaskRunObservation;
pub use crate::queries::TaskSummaryRow;
