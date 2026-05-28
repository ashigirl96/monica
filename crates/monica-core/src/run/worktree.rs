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
    let mut command = Command::new("git");
    command.arg("-C").arg(repo).args(["worktree", "add"]);
    command.arg(worktree);
    if branch_exists(repo, branch)? {
        command.arg(branch);
    } else {
        command.args(["-b", branch, base]);
    }
    let output = command
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

fn branch_exists(repo: &Path, branch: &str) -> Result<bool> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .output()
        .context("failed to run git; install git or check the project path")?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            Err(anyhow!(
                "git show-ref failed: {}",
                if stderr.is_empty() {
                    "no error output"
                } else {
                    stderr
                }
            ))
        }
    }
}
