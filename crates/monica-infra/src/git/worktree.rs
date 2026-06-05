use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use monica_core::{parse_owner_repo, GitGateway, TaskRun};

#[derive(Debug, Default, Clone, Copy)]
pub struct GitCliGateway;

impl GitGateway for GitCliGateway {
    fn create_worktree(
        &self,
        repo: &Path,
        worktree: &Path,
        branch: &str,
        base: &str,
    ) -> Result<()> {
        create_worktree(repo, worktree, branch, base)
    }

    fn cleanup_task_runs(&self, repo: &Path, runs: &[TaskRun]) -> Result<Vec<String>> {
        cleanup_task_runs(repo, runs)
    }

    fn detect_repo(&self) -> Result<String> {
        let output = Command::new("git")
            .args(["remote", "get-url", "origin"])
            .output()
            .context("failed to run git; install git or pass owner/repo explicitly")?;
        if !output.status.success() {
            return Err(anyhow!(
                "could not read `git remote get-url origin`; run inside a repo or pass owner/repo explicitly"
            ));
        }
        let url = String::from_utf8(output.stdout).context("git remote url was not valid UTF-8")?;
        parse_owner_repo(&url)
    }

    fn detect_default_branch(&self, repo: &str) -> Option<String> {
        if self.detect_repo().ok().as_deref() != Some(repo) {
            return None;
        }

        let output = Command::new("git")
            .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let branch = String::from_utf8(output.stdout).ok()?;
        parse_origin_head_branch(&branch)
    }
}

fn create_worktree(repo: &Path, worktree: &Path, branch: &str, base: &str) -> Result<()> {
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
        return Err(anyhow!(
            "git worktree add failed: {}",
            command_stderr(&output.stderr)
        ));
    }
    Ok(())
}

fn cleanup_task_runs(repo: &Path, runs: &[TaskRun]) -> Result<Vec<String>> {
    let mut removed_branches = Vec::new();

    for run in runs {
        if let Some(worktree_path) = run.worktree_path.as_deref() {
            let worktree = Path::new(worktree_path);
            if worktree.exists() {
                git(repo, ["worktree", "remove"].as_slice(), Some(worktree)).with_context(
                    || {
                        format!(
                            "failed to remove worktree for {} at {}",
                            run.id,
                            worktree.display()
                        )
                    },
                )?;
            } else if worktree_registered(repo, worktree)? {
                git(
                    repo,
                    ["worktree", "remove", "--force"].as_slice(),
                    Some(worktree),
                )
                .with_context(|| {
                    format!(
                        "failed to remove stale worktree metadata for {} at {}",
                        run.id,
                        worktree.display()
                    )
                })?;
            }
        }
        if let Some(branch) = run.branch.as_deref() {
            if !removed_branches.iter().any(|b| b == branch) && branch_exists(repo, branch)? {
                git(repo, ["branch", "-D", branch].as_slice(), None)
                    .with_context(|| format!("failed to delete branch {branch} for {}", run.id))?;
                removed_branches.push(branch.to_string());
            }
        }
    }
    Ok(removed_branches)
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
        _ => Err(anyhow!(
            "git show-ref failed: {}",
            command_stderr(&output.stderr)
        )),
    }
}

fn worktree_registered(repo: &Path, worktree: &Path) -> Result<bool> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .context("failed to run git; install git or check the project path")?;
    if !output.status.success() {
        return Err(anyhow!(
            "git worktree list failed: {}",
            command_stderr(&output.stderr)
        ));
    }

    let path = worktree.display().to_string();
    let mut needles = vec![format!("worktree {path}")];
    if let Some(rest) = path.strip_prefix("/var/") {
        needles.push(format!("worktree /private/var/{rest}"));
    } else if let Some(rest) = path.strip_prefix("/private/var/") {
        needles.push(format!("worktree /var/{rest}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| needles.iter().any(|needle| line == needle)))
}

fn git(repo: &Path, args: &[&str], path_arg: Option<&Path>) -> Result<()> {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo).args(args);
    if let Some(path) = path_arg {
        command.arg(path);
    }
    let output = command
        .output()
        .context("failed to run git; install git or check the project path")?;
    if !output.status.success() {
        return Err(anyhow!(
            "git {} failed: {}",
            args.join(" "),
            command_stderr(&output.stderr)
        ));
    }
    Ok(())
}

fn parse_origin_head_branch(value: &str) -> Option<String> {
    value
        .trim()
        .strip_prefix("origin/")
        .filter(|branch| !branch.is_empty())
        .map(ToString::to_string)
}

fn command_stderr(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        "no error output".to_string()
    } else {
        stderr.to_string()
    }
}
