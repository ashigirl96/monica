use serde::{Deserialize, Serialize};

/// An opaque JSON document the domain carries but never interprets (task details, hook payloads,
/// run metadata). Storing it as raw text keeps `monica-domain` free of any `serde_json` dependency:
/// interpreting the contents is an outer-layer concern (the infra store parses it, the API layer
/// projects it). It serializes transparently as its inner string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RawJson(pub String);

impl RawJson {
    /// The empty JSON object `{}` — the default for a task with no extra details.
    pub fn empty_object() -> Self {
        Self("{}".to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl From<String> for RawJson {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for RawJson {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl AsRef<str> for RawJson {
    fn as_ref(&self) -> &str {
        &self.0
    }
}
