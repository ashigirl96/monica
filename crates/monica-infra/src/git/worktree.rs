use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use monica_core::{parse_owner_repo, GitGateway, TaskRun};

const RIP_COMMAND: &str = "/opt/homebrew/bin/rip";

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
    cleanup_task_runs_with_rip(repo, runs, Path::new(RIP_COMMAND))
}

fn cleanup_task_runs_with_rip(repo: &Path, runs: &[TaskRun], rip: &Path) -> Result<Vec<String>> {
    let mut removed_branches = Vec::new();

    for run in runs {
        if let Some(worktree_path) = run.worktree_path.as_deref() {
            let worktree = Path::new(worktree_path);
            cleanup_worktree(repo, run, worktree, rip)?;
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

fn cleanup_worktree(repo: &Path, run: &TaskRun, worktree: &Path, rip: &Path) -> Result<()> {
    let registered = worktree_registered(repo, worktree)?;
    let needs_prune = if worktree.exists() {
        if !registered {
            return Err(anyhow!(
                "refusing to delete unregistered worktree for {} at {}",
                run.id,
                worktree.display()
            ));
        }
        rip_worktree(rip, worktree).with_context(|| {
            format!(
                "failed to rip worktree for {} at {}",
                run.id,
                worktree.display()
            )
        })?;
        true
    } else {
        registered
    };
    if needs_prune {
        prune_worktrees(repo).with_context(|| {
            format!(
                "failed to prune worktree metadata for {} at {}",
                run.id,
                worktree.display()
            )
        })?;
        ensure_worktree_unregistered(repo, run, worktree)?;
    }
    Ok(())
}

fn rip_worktree(rip: &Path, worktree: &Path) -> Result<()> {
    if !rip.is_file() {
        return Err(anyhow!(
            "rip command is required to delete Monica worktrees; expected {}",
            rip.display()
        ));
    }
    let output = Command::new(rip).arg(worktree).output().with_context(|| {
        format!(
            "failed to run {}; install rip at {RIP_COMMAND}",
            rip.display()
        )
    })?;
    if !output.status.success() {
        return Err(anyhow!(
            "{} {} failed: {}",
            rip.display(),
            worktree.display(),
            command_stderr(&output.stderr)
        ));
    }
    Ok(())
}

fn prune_worktrees(repo: &Path) -> Result<()> {
    git(
        repo,
        ["worktree", "prune", "--expire", "now"].as_slice(),
        None,
    )
}

fn ensure_worktree_unregistered(repo: &Path, run: &TaskRun, worktree: &Path) -> Result<()> {
    if worktree_registered(repo, worktree)? {
        return Err(anyhow!(
            "worktree metadata still registered for {} at {}",
            run.id,
            worktree.display()
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use monica_core::{
        GitGateway, NewTask, NewTaskRun, Project, TaskKind, TaskRun, TaskRunStatus, TaskStatus,
    };
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use crate::sqlite::SqliteStore;
    use crate::test_support::{init_repo, Tmp};

    use super::*;

    #[cfg(unix)]
    #[test]
    fn delete_issue_rips_dirty_worktree_prunes_metadata_and_keeps_run_record() {
        let root = Tmp::new("rip-delete");
        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let worktree = root.path().join("worktree");
        add_worktree(&repo, &worktree, "issue-42");
        fs::write(worktree.join("dirty.txt"), "dirty\n").unwrap();

        let mut db = SqliteStore::open_in_memory().unwrap();
        let mut project = Project::from_repo("owner/repo");
        project.path = Some(repo.to_string_lossy().into_owned());
        project.default_branch = "main".to_string();
        db.upsert_project(&project).unwrap();
        let mut task = NewTask::new(TaskKind::Development, "dirty worktree");
        task.status = TaskStatus::Ready;
        task.project_id = Some(project.id.clone());
        let item = db.insert_task(task).unwrap();
        let run = db
            .start_task_run(NewTaskRun {
                task_id: item.id.clone(),
                agent: None,
                branch: Some("issue-42".to_string()),
                worktree_path: Some(worktree.to_string_lossy().into_owned()),
            })
            .unwrap();

        let git = TestGit {
            rip: write_fake_rip(root.path()),
        };
        let report = monica_core::delete_issue(&mut db, &git, &item.id).unwrap();

        assert!(!worktree.exists());
        assert!(!worktree_registered(&repo, &worktree).unwrap());
        assert!(!branch_exists(&repo, "issue-42").unwrap());
        assert!(db.get_task(&item.id).unwrap().is_none());
        assert_eq!(db.list_task_runs_for_task(&item.id).unwrap().len(), 1);
        assert_eq!(report.task_runs, vec![run.id]);
        assert_eq!(report.removed_branches, vec!["issue-42"]);
    }

    #[test]
    fn cleanup_fails_before_mutating_when_rip_is_missing() {
        let root = Tmp::new("missing-rip");
        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let worktree = root.path().join("worktree");
        add_worktree(&repo, &worktree, "issue-42");
        let run = task_run("run-1", "issue-42", &worktree);

        let err = cleanup_task_runs_with_rip(&repo, &[run], &root.path().join("missing-rip"))
            .unwrap_err();

        assert!(format!("{err:#}").contains("rip command is required to delete Monica worktrees"));
        assert!(worktree.exists());
        assert!(worktree_registered(&repo, &worktree).unwrap());
        assert!(branch_exists(&repo, "issue-42").unwrap());
    }

    #[test]
    fn cleanup_prunes_stale_worktree_metadata_without_rip() {
        let root = Tmp::new("stale-worktree");
        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let worktree = root.path().join("worktree");
        add_worktree(&repo, &worktree, "issue-42");
        fs::remove_dir_all(&worktree).unwrap();
        let run = task_run("run-1", "issue-42", &worktree);

        let removed =
            cleanup_task_runs_with_rip(&repo, &[run], &root.path().join("missing-rip")).unwrap();

        assert_eq!(removed, vec!["issue-42"]);
        assert!(!worktree_registered(&repo, &worktree).unwrap());
        assert!(!branch_exists(&repo, "issue-42").unwrap());
    }

    struct TestGit {
        rip: PathBuf,
    }

    impl GitGateway for TestGit {
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
            cleanup_task_runs_with_rip(repo, runs, &self.rip)
        }

        fn detect_repo(&self) -> Result<String> {
            Ok("owner/repo".to_string())
        }

        fn detect_default_branch(&self, _repo: &str) -> Option<String> {
            Some("main".to_string())
        }
    }

    fn task_run(id: &str, branch: &str, worktree: &Path) -> TaskRun {
        TaskRun {
            id: id.to_string(),
            task_id: "MON-1".to_string(),
            agent: None,
            branch: Some(branch.to_string()),
            worktree_path: Some(worktree.to_string_lossy().into_owned()),
            status: TaskRunStatus::Running,
            wait_reason: None,
            settings_path: None,
            provider_session_id: None,
            last_event_name: None,
            last_event_at: None,
            metadata: serde_json::json!({}),
            created_at: "2026-06-02T00:00:00.000Z".to_string(),
            updated_at: "2026-06-02T00:00:00.000Z".to_string(),
        }
    }

    #[cfg(unix)]
    fn write_fake_rip(dir: &Path) -> PathBuf {
        let path = dir.join("rip");
        fs::write(
            &path,
            r#"#!/bin/sh
set -eu
graveyard="${0}.graveyard"
mkdir -p "$graveyard"
for target in "$@"; do
  base=$(basename "$target")
  rm -rf "$graveyard/$base"
  mv "$target" "$graveyard/$base"
done
"#,
        )
        .unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    fn add_worktree(repo: &Path, worktree: &Path, branch: &str) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["worktree", "add", "-b", branch])
            .arg(worktree)
            .arg("main")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git worktree add failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
