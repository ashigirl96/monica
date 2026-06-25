use std::path::PathBuf;

use crate::error::DomainError;
use crate::project::Project;

pub fn monica_number(task_id: &str) -> Result<i64, DomainError> {
    task_id
        .strip_prefix("MON-")
        .and_then(|n| n.parse::<i64>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| DomainError::InvalidTaskId(task_id.to_string()))
}

/// The git branch a run works on: the linked GitHub issue number (`issue-9`), or the task's
/// MON number when no issue is linked (`mon-1`). Both forms are already git-ref- and path-safe,
/// so no further sanitization is needed before they reach a branch ref or worktree directory.
pub fn branch_name(github_issue_number: Option<i64>, monica_number: i64) -> String {
    match github_issue_number {
        Some(n) => format!("issue-{n}"),
        None => format!("mon-{monica_number}"),
    }
}

/// Where `issue run` places a worktree. The directory name is the full branch with `/` and any
/// non-`[A-Za-z0-9._-]` char replaced by `-`, so distinct branches never collapse to the same path.
/// Resolution order is: explicit `project.worktree_root`, otherwise `<project.path>/.worktrees`.
/// A project with neither cannot run until one of those is configured.
pub fn worktree_path_for(project: &Project, branch: &str) -> Result<PathBuf, DomainError> {
    let root = match &project.worktree_root {
        Some(root) => PathBuf::from(root),
        None => {
            let path = project.path.as_deref().ok_or_else(|| {
                DomainError::MissingWorktreeLocation {
                    project_id: project.id.clone(),
                }
            })?;
            PathBuf::from(path).join(".worktrees")
        }
    };
    Ok(root.join(sanitize_path_component(branch)))
}

pub(super) fn sanitize_path_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monica_number_requires_positive_mon_id() {
        assert_eq!(monica_number("MON-12").unwrap(), 12);
        assert!(monica_number("MON-0").is_err());
        assert!(monica_number("mon-1").is_err());
        assert!(monica_number("MON-x").is_err());
        assert!(monica_number("run-1").is_err());
    }

    #[test]
    fn branch_name_prefers_issue_number() {
        assert_eq!(branch_name(Some(9), 1), "issue-9");
        assert_eq!(branch_name(None, 1), "mon-1");
    }

    #[test]
    fn worktree_path_resolution_order() {
        let mut project = Project::from_repo("owner/repo");
        project.path = Some("/repo".to_string());
        assert_eq!(
            worktree_path_for(&project, "mon-1").unwrap(),
            PathBuf::from("/repo/.worktrees/mon-1")
        );

        project.worktree_root = Some("/worktrees".to_string());
        assert_eq!(
            worktree_path_for(&project, "mon-1").unwrap(),
            PathBuf::from("/worktrees/mon-1"),
            "explicit worktree_root wins over <path>/.worktrees"
        );

        project.path = None;
        project.worktree_root = None;
        assert!(worktree_path_for(&project, "mon-1").is_err());
    }

    #[test]
    fn worktree_directory_name_is_sanitized() {
        let mut project = Project::from_repo("owner/repo");
        project.path = Some("/repo".to_string());
        assert_eq!(
            worktree_path_for(&project, "feature/foo bar").unwrap(),
            PathBuf::from("/repo/.worktrees/feature-foo-bar"),
            "slashes and spaces must not create nested or ambiguous paths"
        );
        assert_eq!(sanitize_path_component("a.b_c-d"), "a.b_c-d");
    }
}
