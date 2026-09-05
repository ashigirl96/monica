use std::str::FromStr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestRef {
    pub repo: Option<String>,
    pub number: Option<i64>,
    pub url: Option<String>,
    pub status: Option<String>,
    pub is_open_or_draft: bool,
}

impl GithubPullRequestRef {
    pub fn status_is_open_or_draft(status: Option<&str>) -> bool {
        status
            .and_then(|s| GithubPullRequestStatus::from_str(s).ok())
            .is_some_and(GithubPullRequestStatus::is_open_or_draft)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubIssue {
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub state: GithubIssueState,
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum GithubIssueState {
    Open,
    Closed,
}

impl GithubIssueState {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// Where an issue lives. Sub-issues can cross repositories inside an organization, so a parent is
/// only identified by its number together with the repo that owns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueAddress {
    pub repo: String,
    pub number: i64,
}

/// An issue as returned by the bulk sync fetch. `parent` mirrors the GitHub Sub-issues link and
/// becomes `parent_task_id`. The children are not fetched: a sync re-reads every open task's issue,
/// so a tracked child always reports the same link from its own side. `linked_pull_requests` are
/// the PRs whose closing keyword points at this issue — the reverse lookup that reaches tasks the
/// branch pass cannot see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedIssue {
    pub number: i64,
    pub title: String,
    pub state: GithubIssueState,
    pub parent: Option<IssueAddress>,
    pub linked_pull_requests: Vec<GithubPullRequest>,
}

/// The issue ref of a task that is still open, so a forced sync must re-check it. One row per
/// external_ref: the same issue tracked by two tasks yields two entries, matching the per-ref
/// state rows the sync writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenIssueRef {
    pub external_ref_id: i64,
    pub task_id: String,
    pub repo: String,
    pub number: i64,
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum GithubPullRequestStatus {
    Draft,
    Open,
    Closed,
    Merged,
}

impl GithubPullRequestStatus {
    pub fn as_str(self) -> &'static str {
        self.into()
    }

    /// Draft and Open are work still in flight; Merged and Closed are settled history.
    pub fn is_open_or_draft(self) -> bool {
        matches!(
            self,
            GithubPullRequestStatus::Draft | GithubPullRequestStatus::Open
        )
    }

    /// Priority when one branch carries several PRs: prefer an active PR over a settled one.
    pub fn branch_rank(self) -> u8 {
        match self {
            GithubPullRequestStatus::Draft | GithubPullRequestStatus::Open => 3,
            GithubPullRequestStatus::Merged => 2,
            GithubPullRequestStatus::Closed => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullRequest {
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub status: GithubPullRequestStatus,
}

/// A pull request as returned by a repo-wide listing, carrying the head branch so the bulk sync can
/// match it back to a task. `updated_at` breaks ties when one branch has several PRs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPullRequest {
    pub number: i64,
    pub url: String,
    pub status: GithubPullRequestStatus,
    pub head_branch: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestBranchSyncCandidate {
    pub task_id: String,
    pub repo: String,
    pub branch: String,
}

/// A tracked PR whose recorded state is still in flight (no state row, unknown, draft, or open),
/// so a forced sync must re-check it. One row per external_ref: the same PR tracked by two tasks
/// yields two entries, matching the per-task state rows the sync writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnresolvedPullRequestRef {
    pub task_id: String,
    pub external_ref_id: i64,
    pub repo: String,
    pub number: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubAuthStatus {
    pub authenticated: bool,
    pub message: Option<String>,
}

