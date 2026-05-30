use std::path::PathBuf;

use anyhow::{anyhow, Result};

use crate::Project;

pub fn monica_number(task_id: &str) -> Result<i64> {
    task_id
        .strip_prefix("MON-")
        .and_then(|n| n.parse::<i64>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| anyhow!("invalid task id (expected MON-<n>): {task_id:?}"))
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
pub(super) fn worktree_path_for(project: &Project, branch: &str) -> Result<PathBuf> {
    let root = match &project.worktree_root {
        Some(root) => PathBuf::from(root),
        None => {
            let path = project.path.as_deref().ok_or_else(|| {
                anyhow!(
                    "project {} has neither path nor worktree_root; run `monica project init` \
                     in the repo or set `monica project set {} worktree_root <path>`",
                    project.id,
                    project.id
                )
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
