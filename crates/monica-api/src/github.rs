use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct GithubPullRequestRef {
    pub repo: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub number: Option<i64>,
    pub url: Option<String>,
    pub status: Option<String>,
    pub is_open_or_draft: bool,
}

impl From<monica_application::GithubPullRequestRef> for GithubPullRequestRef {
    fn from(value: monica_application::GithubPullRequestRef) -> Self {
        Self {
            repo: value.repo,
            number: value.number,
            url: value.url,
            status: value.status,
            is_open_or_draft: value.is_open_or_draft,
        }
    }
}

/// The open/closed state of a tracked issue, kept as an enum across the boundary so the frontend
/// gets a `"open" | "closed"` union instead of a bare string it has to compare by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GithubIssueState {
    Open,
    Closed,
}

impl From<monica_application::GithubIssueState> for GithubIssueState {
    fn from(value: monica_application::GithubIssueState) -> Self {
        match value {
            monica_application::GithubIssueState::Open => Self::Open,
            monica_application::GithubIssueState::Closed => Self::Closed,
        }
    }
}
