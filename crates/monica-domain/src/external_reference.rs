use serde::{Deserialize, Serialize};

use super::project::Provider;

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
    Issue,
    PullRequest,
}

impl RefType {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// A persisted, provider-agnostic reference to an item living in an external system. `provider`
/// records which system it lives in; `ref_type` records what kind of item it is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExternalReference {
    pub id: i64,
    pub task_id: String,
    pub provider: Provider,
    pub ref_type: RefType,
    pub repo: Option<String>,
    pub number: Option<i64>,
    pub url: Option<String>,
    pub created_at: String,
}

impl ExternalReference {
    pub fn new(
        task_id: impl Into<String>,
        provider: Provider,
        ref_type: RefType,
        repo: Option<String>,
        number: Option<i64>,
        url: Option<String>,
    ) -> Self {
        Self {
            id: 0,
            task_id: task_id.into(),
            provider,
            ref_type,
            repo,
            number,
            url,
            created_at: String::new(),
        }
    }
}

/// A provider-agnostic snapshot of an issue fetched from a provider gateway. The provider-specific
/// I/O DTO is converted into this at the adapter boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalIssue {
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_type_round_trips_through_provider_agnostic_strings() {
        assert_eq!(RefType::Issue.as_str(), "issue");
        assert_eq!(RefType::PullRequest.as_str(), "pull_request");
        assert_eq!("issue".parse::<RefType>().unwrap(), RefType::Issue);
        assert_eq!(
            "pull_request".parse::<RefType>().unwrap(),
            RefType::PullRequest
        );
        assert!("github_issue".parse::<RefType>().is_err());
    }

    #[test]
    fn new_defaults_id_and_created_at() {
        let r = ExternalReference::new(
            "MON-1",
            Provider::Github,
            RefType::Issue,
            Some("owner/repo".to_string()),
            Some(42),
            Some("https://example.com/42".to_string()),
        );
        assert_eq!(r.id, 0);
        assert!(r.created_at.is_empty());
        assert_eq!(r.provider, Provider::Github);
        assert_eq!(r.ref_type, RefType::Issue);
        assert_eq!(r.number, Some(42));
    }
}
