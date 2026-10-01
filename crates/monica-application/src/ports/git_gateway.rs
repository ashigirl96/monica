use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::prelude::TaskRun;

/// The repo + branch a linked git worktree belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeRef {
    pub repo: String,
    pub branch: String,
}

pub trait GitGateway {
    fn create_worktree(&self, repo: &Path, worktree: &Path, branch: &str, base: &str)
        -> Result<()>;
    /// Detach each run's worktree from git and delete its branch. The worktree directory is only
    /// moved aside (into `.trash/` beside it); [`Self::reap_worktree_trash`] deletes it for real.
    fn cleanup_task_runs(&self, repo: &Path, runs: &[TaskRun]) -> Result<Vec<String>>;
    /// Start deleting everything moved aside beside any of `worktrees` (past or present — the
    /// caller passes every path it has ever recorded). Returns immediately; the deletion runs
    /// detached and failures are only logged, since whatever is left waits for the next reap.
    fn reap_worktree_trash(&self, worktrees: &[PathBuf]);
    /// Whether `worktree` holds changes (untracked files included) that cleanup would trash. A
    /// missing directory or the main checkout itself has nothing cleanup would lose.
    fn worktree_has_uncommitted_changes(&self, repo: &Path, worktree: &Path) -> Result<bool>;
    /// Whether deleting `branch` loses commits: its tip is reachable from no remote-tracking ref,
    /// or — in a repo without remotes — from no `default_branch`. A missing branch loses nothing.
    fn branch_has_unpublished_commits(
        &self,
        repo: &Path,
        branch: &str,
        default_branch: &str,
    ) -> Result<bool>;
    fn detect_repo(&self) -> Result<String>;
    fn detect_default_branch(&self, repo: &str) -> Option<String>;
}
