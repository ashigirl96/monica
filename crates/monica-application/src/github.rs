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

    /// The recorded status as a value. `None` covers both "never synced" and a column written by an
    /// older build with a status this one no longer knows — callers treat the two the same.
    pub fn parsed_status(&self) -> Option<GithubPullRequestStatus> {
        self.status
            .as_deref()
            .and_then(|s| GithubPullRequestStatus::from_str(s).ok())
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueAddress {
    pub repo: String,
    pub number: i64,
}

/// An issue GitHub reports as blocking another one. Carries GitHub's own answer about the blocker
/// rather than a link into Monica, so a blocker no task tracks is still decidable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueBlocker {
    pub address: IssueAddress,
    pub state: GithubIssueState,
    pub closed_by_merged_pull_request: bool,
}

impl IssueBlocker {
    pub fn new(
        address: IssueAddress,
        state: GithubIssueState,
        closing_pull_requests: &[GithubPullRequest],
    ) -> Self {
        Self {
            address,
            state,
            closed_by_merged_pull_request: closing_pull_requests
                .iter()
                .any(|pr| pr.status == GithubPullRequestStatus::Merged),
        }
    }

    /// The start gate's rule: upstream work is done once GitHub closed the issue or merged a pull
    /// request that closes it. The merged-PR arm matters because a PR merges before automation
    /// closes the issue it references, and the downstream task is unblocked at the merge.
    pub fn is_cleared(&self) -> bool {
        self.state == GithubIssueState::Closed || self.closed_by_merged_pull_request
    }

    /// `owner/repo#number`. The repo is always spelled out because a blocker can live in another
    /// repository, and the gate's message and `monica task status` must not disagree.
    pub fn label(&self) -> String {
        format!("{}#{}", self.address.repo, self.address.number)
    }
}

/// An issue as returned by the bulk sync fetch. `parent` mirrors the GitHub Sub-issues link and
/// becomes `parent_task_id`. The children are not fetched: a sync re-reads every open task's issue,
/// so a tracked child always reports the same link from its own side. `linked_pull_requests` are
/// the PRs whose closing keyword points at this issue — the reverse lookup that reaches tasks the
/// branch pass cannot see. `blockers` mirrors GitHub's blocked-by edges and feeds the start gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedIssue {
    pub number: i64,
    pub title: String,
    pub state: GithubIssueState,
    pub parent: Option<IssueAddress>,
    pub linked_pull_requests: Vec<GithubPullRequest>,
    pub blockers: Vec<IssueBlocker>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn address() -> IssueAddress {
        IssueAddress { repo: "owner/repo".to_string(), number: 7 }
    }

    fn pull_request(status: GithubPullRequestStatus) -> GithubPullRequest {
        GithubPullRequest {
            repo: "owner/repo".to_string(),
            number: 11,
            url: "https://github.com/owner/repo/pull/11".to_string(),
            status,
        }
    }

    #[test]
    fn a_blocker_is_cleared_once_the_issue_closes_or_a_closing_pull_request_merges() {
        for (state, merged, expected) in [
            (GithubIssueState::Open, false, false),
            (GithubIssueState::Open, true, true),
            (GithubIssueState::Closed, false, true),
            (GithubIssueState::Closed, true, true),
        ] {
            let blocker = IssueBlocker {
                address: address(),
                state,
                closed_by_merged_pull_request: merged,
            };
            assert_eq!(
                blocker.is_cleared(),
                expected,
                "state={state:?} merged_pr={merged}"
            );
        }
    }

    #[test]
    fn only_a_merged_closing_pull_request_counts() {
        let unmerged = [
            GithubPullRequestStatus::Open,
            GithubPullRequestStatus::Draft,
            GithubPullRequestStatus::Closed,
        ]
        .map(pull_request);
        let blocker = IssueBlocker::new(address(), GithubIssueState::Open, &unmerged);
        assert!(!blocker.closed_by_merged_pull_request);

        let with_merge = [
            pull_request(GithubPullRequestStatus::Closed),
            pull_request(GithubPullRequestStatus::Merged),
        ];
        let blocker = IssueBlocker::new(address(), GithubIssueState::Open, &with_merge);
        assert!(blocker.closed_by_merged_pull_request);
    }

    #[test]
    fn a_blocker_label_always_carries_its_repo() {
        let blocker = IssueBlocker::new(address(), GithubIssueState::Open, &[]);
        assert_eq!(
            blocker.label(),
            "owner/repo#7",
            "a blocker can live in another repo, so a bare #number would be ambiguous"
        );
    }
}
