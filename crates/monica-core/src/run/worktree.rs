use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Context, Result};

pub(super) fn create_worktree(
    repo: &Path,
    worktree: &Path,
    branch: &str,
    base: &str,
) -> Result<()> {
    if let Some(parent) = worktree.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "add"])
        .arg(worktree)
        .args(["-b", branch, base])
        .output()
        .context("failed to run git; install git or check the project path")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        return Err(anyhow!(
            "git worktree add failed: {}",
            if stderr.is_empty() {
                "no error output"
            } else {
                stderr
            }
        ));
    }
    Ok(())
}
