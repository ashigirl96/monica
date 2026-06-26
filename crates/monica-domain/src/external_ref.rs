use serde::{Deserialize, Serialize};

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
pub enum RefType {
    GithubIssue,
    GithubPullRequest,
}

impl RefType {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// A reference to an item living in an external system (e.g. a GitHub issue).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExternalRef {
    pub id: i64,
    pub task_id: String,
    pub ref_type: RefType,
    pub repo: Option<String>,
    pub number: Option<i64>,
    pub url: Option<String>,
    pub created_at: String,
}

impl ExternalRef {
    pub fn new(
        task_id: impl Into<String>,
        ref_type: RefType,
        repo: Option<String>,
        number: Option<i64>,
        url: Option<String>,
    ) -> Self {
        Self {
            id: 0,
            task_id: task_id.into(),
            ref_type,
            repo,
            number,
            url,
            created_at: String::new(),
        }
    }
}
