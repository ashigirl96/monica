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

/// An issue as returned by the bulk sync fetch. `parent` and `sub_issues` mirror the GitHub
/// Sub-issues links; #464 turns them into `parent_task_id` and nothing reads them yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedIssue {
    pub number: i64,
    pub title: String,
    pub state: GithubIssueState,
    pub parent: Option<i64>,
    pub sub_issues: Vec<i64>,
}

/// The issue ref of a task that is still open, so a forced sync must re-check it. One row per
/// external_ref: the same issue tracked by two tasks yields two entries, matching the per-ref
/// state rows the sync writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenIssueRef {
    pub task_id: String,
    pub external_ref_id: i64,
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

/// Which refs a GitHub sync covers. `Task` narrows every pass to one task's refs before any
/// request goes out, so the issue pass asks for one number instead of every tracked one. The PR
/// pass still lists the task's repo: branch matching has no PR number to query by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GithubSyncScope {
    All,
    Task(String),
}

impl GithubSyncScope {
    pub fn covers(&self, task_id: &str) -> bool {
        match self {
            GithubSyncScope::All => true,
            GithubSyncScope::Task(scoped) => scoped == task_id,
        }
    }
}

/// One field's move from its cached value to the freshly fetched one. `previous` is `None` when
/// nothing was cached yet — a first fetch rather than a change of an established value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldChange<T> {
    pub previous: Option<T>,
    pub current: T,
}

impl<T: PartialEq> FieldChange<T> {
    /// `Some` only when the fetched value differs from what was cached, so callers can push the
    /// result straight into a change list without re-testing.
    pub fn detect(previous: Option<T>, current: T) -> Option<Self> {
        if previous.as_ref() == Some(&current) {
            return None;
        }
        Some(Self { previous, current })
    }
}

/// What a sync actually altered for one issue ref. Only refs with at least one changed field are
/// reported; an unchanged ref leaves no entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueSyncChange {
    pub task_id: String,
    pub repo: String,
    pub number: i64,
    pub title: Option<FieldChange<String>>,
    pub state: Option<FieldChange<GithubIssueState>>,
}

/// What a sync altered for one pull-request ref. `newly_linked` marks a PR the branch pass
/// discovered and attached to the task for the first time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestSyncChange {
    pub task_id: String,
    pub repo: String,
    pub number: i64,
    pub status: Option<FieldChange<GithubPullRequestStatus>>,
    pub newly_linked: bool,
}

impl IssueSyncChange {
    /// The one place that decides whether a fetched issue moved. Both the SQLite store and the
    /// test fake go through it, so the two cannot disagree about what counts as a change.
    pub fn detect(
        issue_ref: &OpenIssueRef,
        issue: &FetchedIssue,
        previous_title: Option<String>,
        previous_state: Option<GithubIssueState>,
    ) -> Option<Self> {
        let title = FieldChange::detect(previous_title, issue.title.clone());
        let state = FieldChange::detect(previous_state, issue.state);
        (title.is_some() || state.is_some()).then(|| Self {
            task_id: issue_ref.task_id.clone(),
            repo: issue_ref.repo.clone(),
            number: issue_ref.number,
            title,
            state,
        })
    }
}

impl PullRequestSyncChange {
    /// The PR counterpart of [`IssueSyncChange::detect`]. A newly linked PR is always worth
    /// reporting even when its status is the one it was born with.
    pub fn detect(
        task_id: &str,
        pull_request: &GithubPullRequest,
        previous_status: Option<GithubPullRequestStatus>,
        newly_linked: bool,
    ) -> Option<Self> {
        let status = FieldChange::detect(previous_status, pull_request.status);
        (newly_linked || status.is_some()).then(|| Self {
            task_id: task_id.to_string(),
            repo: pull_request.repo.clone(),
            number: pull_request.number,
            status,
            newly_linked,
        })
    }
}

/// What one pass of the sync did. `failed_repos` is the load-bearing field: a repo whose fetch
/// failed is skipped rather than recorded as empty, so its cached state survives — which means a
/// caller that ignores this cannot tell "nothing needed refreshing" from "nothing could be
/// refreshed".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncPassOutcome<C> {
    pub synced_count: u32,
    pub changes: Vec<C>,
    pub failed_repos: Vec<String>,
}

// Hand-written: `derive(Default)` would demand `C: Default`, which `Vec<C>` never needs.
impl<C> Default for SyncPassOutcome<C> {
    fn default() -> Self {
        Self {
            synced_count: 0,
            changes: Vec::new(),
            failed_repos: Vec::new(),
        }
    }
}

/// Both passes combined, as the CLI and the completion event see them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GithubSyncReport {
    pub synced_count: u32,
    pub issue_changes: Vec<IssueSyncChange>,
    pub pull_request_changes: Vec<PullRequestSyncChange>,
    /// Repos the sync could not reach, deduplicated across both passes.
    pub failed_repos: Vec<String>,
}

impl GithubSyncReport {
    /// One per moved field, so an issue whose title and state both moved counts twice — the report
    /// owns this number rather than leaving each renderer to derive it from its own output.
    pub fn changed_count(&self) -> usize {
        self.issue_changes
            .iter()
            .map(|change| usize::from(change.title.is_some()) + usize::from(change.state.is_some()))
            .sum::<usize>()
            + self.pull_request_changes.len()
    }
}
