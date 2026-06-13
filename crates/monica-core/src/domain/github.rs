use std::str::FromStr;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct GithubPullRequestRef {
    pub repo: Option<String>,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub number: Option<i64>,
    pub url: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubIssue {
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GithubPullRequestStatus {
    Draft,
    Open,
    Closed,
    Merged,
}

impl GithubPullRequestStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            GithubPullRequestStatus::Draft => "draft",
            GithubPullRequestStatus::Open => "open",
            GithubPullRequestStatus::Closed => "closed",
            GithubPullRequestStatus::Merged => "merged",
        }
    }

    /// Draft and Open are work still in flight; Merged and Closed are settled history.
    pub fn is_open_or_draft(self) -> bool {
        matches!(
            self,
            GithubPullRequestStatus::Draft | GithubPullRequestStatus::Open
        )
    }
}

impl FromStr for GithubPullRequestStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "draft" => GithubPullRequestStatus::Draft,
            "open" => GithubPullRequestStatus::Open,
            "closed" => GithubPullRequestStatus::Closed,
            "merged" => GithubPullRequestStatus::Merged,
            other => return Err(anyhow!("unknown GitHub pull request status: {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullRequest {
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub status: GithubPullRequestStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestBranchSyncCandidate {
    pub task_id: String,
    pub repo: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestStatusSyncCandidate {
    pub task_id: String,
    pub external_ref_id: i64,
    pub repo: String,
    pub number: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestSyncStatus {
    Idle,
    Synced,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestSyncResult {
    pub status: PullRequestSyncStatus,
    pub task_id: Option<String>,
    pub pull_request_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct GithubAuthStatus {
    pub authenticated: bool,
    pub source: String,
    pub login: Option<String>,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub access_expires_at: Option<i64>,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub refresh_expires_at: Option<i64>,
    pub reauth_required: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GithubDeviceFlow {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at: i64,
    pub interval: u64,
    #[serde(skip_serializing)]
    pub device_code: String,
}

impl PullRequestSyncResult {
    pub fn idle() -> Self {
        Self {
            status: PullRequestSyncStatus::Idle,
            task_id: None,
            pull_request_count: 0,
            error: None,
        }
    }

    pub fn synced(task_id: impl Into<String>, pull_request_count: usize) -> Self {
        Self {
            status: PullRequestSyncStatus::Synced,
            task_id: Some(task_id.into()),
            pull_request_count,
            error: None,
        }
    }

    pub fn failed(task_id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            status: PullRequestSyncStatus::Failed,
            task_id: Some(task_id.into()),
            pull_request_count: 0,
            error: Some(error.into()),
        }
    }
}
