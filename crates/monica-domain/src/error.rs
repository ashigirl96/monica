use std::fmt;

/// Failures produced by the pure domain rules (id parsing, remote/issue-ref parsing, worktree
/// resolution). Kept anyhow-free so the domain crate stays dependency-light; outer layers absorb
/// it through `anyhow::Error: From<E: std::error::Error>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainError {
    InvalidTaskId(String),
    InvalidTaskRunId(String),
    MissingWorktreeLocation { project_id: String },
    UnparseableRemote(String),
    InvalidIssueNumber(String),
    MissingIssueRef(String),
    InvalidExplanationId(String),
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DomainError::InvalidTaskId(task_id) => {
                write!(f, "invalid task id (expected MON-<n>): {task_id:?}")
            }
            DomainError::InvalidTaskRunId(run_id) => {
                write!(f, "invalid task run id: {run_id:?}")
            }
            DomainError::MissingWorktreeLocation { project_id } => write!(
                f,
                "project {project_id} has neither path nor worktree_root; run `monica project \
                 init` in the repo or set `monica project set {project_id} worktree_root <path>`"
            ),
            DomainError::UnparseableRemote(url) => {
                write!(f, "could not parse owner/repo from git remote {url:?}")
            }
            DomainError::InvalidIssueNumber(raw) => {
                write!(f, "issue number must be a positive integer, got {raw:?}")
            }
            DomainError::MissingIssueRef(target) => {
                write!(f, "expected owner/repo#number, got {target:?}")
            }
            DomainError::InvalidExplanationId(id) => {
                write!(f, "invalid explanation id (expected expl-<n>): {id:?}")
            }
        }
    }
}

impl std::error::Error for DomainError {}
