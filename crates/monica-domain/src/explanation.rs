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
pub enum ExplanationMode {
    Topic,
    Diff,
}

impl ExplanationMode {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Explanation {
    pub id: String,
    pub title: String,
    pub mode: ExplanationMode,
    pub artifact_path: String,
    pub provider_session_id: String,
    pub terminal_session_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewExplanation {
    pub title: String,
    pub mode: ExplanationMode,
    pub provider_session_id: String,
    pub terminal_session_id: String,
}

pub fn is_safe_explanation_id(value: &str) -> bool {
    let Some(number) = value.strip_prefix("exp-") else {
        return false;
    };
    !number.is_empty()
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explanation_ids_are_canonical_positive_counters() {
        for valid in ["exp-1", "exp-42"] {
            assert!(is_safe_explanation_id(valid), "{valid}");
        }
        for invalid in ["", "exp-", "exp-0", "exp-01", "exp--1", "EXP-1", "../exp-1"] {
            assert!(!is_safe_explanation_id(invalid), "{invalid}");
        }
    }
}
