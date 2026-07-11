use serde::{Deserialize, Serialize};

use crate::ids::ExplanationId;

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
pub enum ExplanationMode {
    Diff,
    Topic,
}

impl ExplanationMode {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Explanation {
    pub id: ExplanationId,
    pub title: String,
    pub summary: Option<String>,
    pub mode: ExplanationMode,
    pub provider_session_id: String,
    pub terminal_session_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct NewExplanation {
    pub title: String,
    pub summary: Option<String>,
    pub mode: ExplanationMode,
    pub provider_session_id: String,
    pub terminal_session_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_round_trip() {
        for mode in [ExplanationMode::Diff, ExplanationMode::Topic] {
            let s = mode.as_str();
            let parsed: ExplanationMode = s.parse().unwrap();
            assert_eq!(parsed, mode);
        }
    }

    #[test]
    fn mode_parse_invalid() {
        assert!("invalid".parse::<ExplanationMode>().is_err());
    }
}
