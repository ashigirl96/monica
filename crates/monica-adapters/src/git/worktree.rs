use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use monica_application::{parse_owner_repo, GitGateway, TaskRun, WorktreeRef};

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
        Ok(parse_owner_repo(&url)?)
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

/// The repo/branch for `cwd` when it sits inside a linked worktree; `None` for the main checkout or
/// a non-repo path. Re-exposed to drivers through `monica-runtime` so the UI can label a terminal's
/// location without the driver naming this crate.
pub fn worktree_info(cwd: &Path) -> Option<WorktreeRef> {
    let output = git_command(cwd)
        .args([
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let mut lines = stdout.lines();
    let branch = lines.next()?.trim().to_string();
    let git_dir = PathBuf::from(lines.next()?.trim());
    let common_dir = PathBuf::from(lines.next()?.trim());
    // The main checkout reports the same dir for both; only linked worktrees diverge.
    if git_dir == common_dir {
        return None;
    }
    let repo = common_dir.parent()?.file_name()?.to_str()?.to_string();
    Some(WorktreeRef { repo, branch })
}

fn create_worktree(repo: &Path, worktree: &Path, branch: &str, base: &str) -> Result<()> {
    if let Some(parent) = worktree.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut command = git_command(repo);
    command.args(["worktree", "add"]);
    command.arg(worktree);
    if branch_exists(repo, branch)? {
        command.arg(branch);
    } else {
        let start_point = latest_remote_base(repo, base).unwrap_or_else(|| base.to_string());
        command.args(["-b", branch]).arg(start_point);
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
    // `git worktree list` includes the main working tree, so a run whose worktree_path points at
    // the checkout itself (e.g. legacy rows stamped from a session's cwd) would pass the
    // registered check and get ripped; never touch it.
    if is_same_path(repo, worktree) {
        return Ok(());
    }
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

fn is_same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
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

/// Branch new worktrees off the latest remote default branch so they don't inherit a stale
/// local base and conflict at merge time. Returns `origin/<base>` only after a successful fetch
/// that leaves the ref resolvable; otherwise `None`, so the caller falls back to the local base
/// and a Run is never blocked by an unreachable remote (offline, or a remote-less repo).
fn latest_remote_base(repo: &Path, base: &str) -> Option<String> {
    let fetched = git_command(repo)
        .args(["fetch", "origin", base])
        .output()
        .ok()?
        .status
        .success();
    if !fetched {
        return None;
    }
    let remote = format!("origin/{base}");
    let resolves = git_command(repo)
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("refs/remotes/{remote}"))
        .output()
        .ok()?
        .status
        .success();
    resolves.then_some(remote)
}

fn branch_exists(repo: &Path, branch: &str) -> Result<bool> {
    let output = git_command(repo)
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
    let output = git_command(repo)
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
    #[cfg(target_os = "macos")]
    {
        if let Some(rest) = path.strip_prefix("/var/") {
            needles.push(format!("worktree /private/var/{rest}"));
        } else if let Some(rest) = path.strip_prefix("/private/var/") {
            needles.push(format!("worktree /var/{rest}"));
        }
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| needles.iter().any(|needle| line == needle)))
}

fn git_command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    cmd
}

fn git(repo: &Path, args: &[&str], path_arg: Option<&Path>) -> Result<()> {
    let mut command = git_command(repo);
    command.args(args);
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

    use monica_application::{
        GitGateway, NewTask, NewTaskRun, Project, ProjectRepository, TaskKind, TaskRun,
        TaskRunStatus, TaskRunStore, TaskStatus, TaskStore,
    };
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use monica_storage_sqlite::SqliteStore;
    use crate::test_support::{init_repo, run_git, Tmp};

    use super::*;

    #[test]
    fn create_worktree_branches_off_latest_remote_base() {
        let root = Tmp::new("worktree-remote-base");
        let remote = root.path().join("remote.git");
        run_git(root.path(), &["init", "--bare", "-b", "main", "remote.git"]);

        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        run_git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
        run_git(&repo, &["push", "-u", "origin", "main"]);
        let stale = head_commit(&repo);

        // A second clone advances the remote default branch past the local checkout.
        let other = root.path().join("other");
        run_git(
            root.path(),
            &["clone", remote.to_str().unwrap(), other.to_str().unwrap()],
        );
        run_git(&other, &["config", "user.email", "monica@example.com"]);
        run_git(&other, &["config", "user.name", "Monica"]);
        fs::write(other.join("next.txt"), "next\n").unwrap();
        run_git(&other, &["add", "next.txt"]);
        run_git(&other, &["commit", "-m", "advance remote"]);
        run_git(&other, &["push", "origin", "main"]);
        let latest = head_commit(&other);

        let worktree = root.path().join("wt");
        create_worktree(&repo, &worktree, "feature", "main").unwrap();

        assert_ne!(latest, stale);
        assert_eq!(head_commit(&worktree), latest);
    }

    #[test]
    fn create_worktree_falls_back_to_local_base_without_remote() {
        let root = Tmp::new("worktree-no-remote");
        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let local = head_commit(&repo);

        let worktree = root.path().join("wt");
        create_worktree(&repo, &worktree, "feature", "main").unwrap();

        assert!(worktree.exists());
        assert_eq!(head_commit(&worktree), local);
    }

    fn head_commit(repo: &Path) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    #[cfg(unix)]
    #[test]
    fn close_issue_rips_dirty_worktree_prunes_metadata_and_keeps_run_record() {
        let root = Tmp::new("rip-close");
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
        let report = monica_application::close_issue(&mut db, &git, &item.id).unwrap();

        assert!(!worktree.exists());
        assert!(!worktree_registered(&repo, &worktree).unwrap());
        assert!(!branch_exists(&repo, "issue-42").unwrap());
        let closed = db.get_task(&item.id).unwrap().unwrap();
        assert_eq!(closed.status, TaskStatus::Closed);
        assert!(closed.closed_at.is_some());
        assert_eq!(db.list_task_runs_for_task(&item.id).unwrap().len(), 1);
        assert_eq!(report.task_runs, vec![run.id]);
        assert_eq!(report.removed_branches, vec!["issue-42"]);
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_never_rips_the_main_checkout() {
        let root = Tmp::new("main-checkout-guard");
        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        // A legacy lazily-created run could have recorded the main checkout as its
        // worktree_path; cleanup must leave it untouched.
        let mut run = task_run("run-1", "unused-branch", &repo);
        run.branch = None;

        cleanup_task_runs_with_rip(&repo, &[run], &write_fake_rip(root.path())).unwrap();

        assert!(repo.exists());
        assert!(repo.join(".git").exists());
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

    #[test]
    fn worktree_info_identifies_linked_worktrees_only() {
        let root = Tmp::new("worktree-info");
        let repo = root.path().join("my-repo");
        fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let worktree = root.path().join("wt");
        add_worktree(&repo, &worktree, "issue-42");

        let info = worktree_info(&worktree).unwrap();
        assert_eq!(info.repo, "my-repo");
        assert_eq!(info.branch, "issue-42");

        let nested = worktree.join("nested");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(worktree_info(&nested), Some(info));

        assert_eq!(worktree_info(&repo), None);
        assert_eq!(worktree_info(root.path()), None);
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
            terminal_tab_id: None,
            last_event_name: None,
            last_event_at: None,
            plan_file_path: None,
            pending_stop: false,
            metadata: monica_application::RawJson::empty_object(),
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
