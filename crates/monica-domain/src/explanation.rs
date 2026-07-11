use std::path::Path;

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
    pub repo_name: Option<String>,
}

pub fn repo_name_from_cwd(cwd: &str) -> Option<String> {
    if cwd.is_empty() || cwd == "~" {
        return None;
    }
    let path = Path::new(cwd);
    let mut stripped = path;
    for ancestor in path.ancestors() {
        if ancestor.file_name().is_some_and(|n| n == ".worktrees") {
            stripped = ancestor.parent()?;
            break;
        }
    }
    stripped.file_name().map(|n| n.to_string_lossy().into_owned())
}

#[derive(Debug, Clone)]
pub struct NewExplanation {
    pub title: String,
    pub summary: Option<String>,
    pub mode: ExplanationMode,
    pub provider_session_id: String,
    pub terminal_session_id: String,
    pub repo_name: Option<String>,
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

    #[test]
    fn repo_name_normal_path() {
        assert_eq!(
            repo_name_from_cwd("/Users/user/repos/monica"),
            Some("monica".to_string())
        );
    }

    #[test]
    fn repo_name_worktree_path() {
        assert_eq!(
            repo_name_from_cwd("/Users/user/repos/monica/.worktrees/357"),
            Some("monica".to_string())
        );
        assert_eq!(
            repo_name_from_cwd("/Users/user/repos/monica/.worktrees/issue-363"),
            Some("monica".to_string())
        );
    }

    #[test]
    fn repo_name_empty() {
        assert_eq!(repo_name_from_cwd(""), None);
    }

    #[test]
    fn repo_name_tilde() {
        assert_eq!(repo_name_from_cwd("~"), None);
    }

    #[test]
    fn repo_name_root() {
        assert_eq!(repo_name_from_cwd("/"), None);
    }

    #[test]
    fn repo_name_simple() {
        assert_eq!(repo_name_from_cwd("/tmp"), Some("tmp".to_string()));
    }
}
