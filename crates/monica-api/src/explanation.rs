use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExplanationMode {
    Diff,
    Topic,
}

impl From<monica_domain::ExplanationMode> for ExplanationMode {
    fn from(value: monica_domain::ExplanationMode) -> Self {
        match value {
            monica_domain::ExplanationMode::Diff => Self::Diff,
            monica_domain::ExplanationMode::Topic => Self::Topic,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Explanation {
    pub id: String,
    pub title: String,
    pub summary: Option<String>,
    pub mode: ExplanationMode,
    pub provider_session_id: String,
    pub terminal_session_id: String,
    pub created_at: String,
}

impl From<monica_domain::Explanation> for Explanation {
    fn from(value: monica_domain::Explanation) -> Self {
        Self {
            id: value.id.into_string(),
            title: value.title,
            summary: value.summary,
            mode: value.mode.into(),
            provider_session_id: value.provider_session_id,
            terminal_session_id: value.terminal_session_id,
            created_at: value.created_at,
        }
    }
}
