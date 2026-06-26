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
