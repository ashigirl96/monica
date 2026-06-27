use std::path::Path;

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
    fn cleanup_task_runs(&self, repo: &Path, runs: &[TaskRun]) -> Result<Vec<String>>;
    fn detect_repo(&self) -> Result<String>;
    fn detect_default_branch(&self, repo: &str) -> Option<String>;
}
