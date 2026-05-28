use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

use crate::model::NewRun;
use crate::{paths, Db, Project, RefType, Status};

const SETUP_SCRIPT_REL: &str = ".monica/setup.sh";
const SETUP_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Extract the numeric part of a `MON-<n>` work item id.
pub fn monica_number(work_item_id: &str) -> Result<i64> {
    work_item_id
        .strip_prefix("MON-")
        .and_then(|n| n.parse::<i64>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| anyhow!("invalid work item id (expected MON-<n>): {work_item_id:?}"))
}

/// The git branch a run works on: the linked GitHub issue number (`issue-9`), or the work item's
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
fn worktree_path_for(project: &Project, branch: &str) -> Result<PathBuf> {
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

fn sanitize_path_component(value: &str) -> String {
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

/// Outcome of running (or skipping) a worktree's `.monica/setup.sh`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupOutcome {
    /// No `.monica/setup.sh` in the worktree; setup was skipped.
    Skipped,
    Succeeded,
    Failed {
        code: Option<i32>,
        timed_out: bool,
    },
}

impl SetupOutcome {
    pub fn is_failure(&self) -> bool {
        matches!(self, SetupOutcome::Failed { .. })
    }
}

/// Environment handed to `.monica/setup.sh`.
pub struct SetupEnv {
    pub monica_id: String,
    pub run_id: String,
    pub project_id: String,
    pub branch: String,
    pub worktree: String,
}

/// Run the worktree's `.monica/setup.sh` (if present), streaming stdout+stderr to `log_path` and
/// enforcing `timeout`. Absent script → [`SetupOutcome::Skipped`]. The script is executed directly
/// so its shebang and executable bit (committed by convention) are honored.
pub fn run_setup_script(
    worktree: &Path,
    log_path: &Path,
    env: &SetupEnv,
    timeout: Duration,
) -> Result<SetupOutcome> {
    let script = worktree.join(SETUP_SCRIPT_REL);
    if !script.is_file() {
        write_log(
            log_path,
            &format!("monica: no {SETUP_SCRIPT_REL}; setup skipped\n"),
        )?;
        return Ok(SetupOutcome::Skipped);
    }

    let log = File::create(log_path)
        .with_context(|| format!("failed to create {}", log_path.display()))?;
    let log_err = log.try_clone()?;

    let mut command = Command::new(&script);
    #[cfg(unix)]
    command.process_group(0);

    let spawned = command
        .current_dir(worktree)
        .env("MONICA_ID", &env.monica_id)
        .env("MONICA_RUN_ID", &env.run_id)
        .env("MONICA_PROJECT_ID", &env.project_id)
        .env("MONICA_BRANCH", &env.branch)
        .env("MONICA_WORKTREE", &env.worktree)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            append_log(
                log_path,
                &format!("monica: failed to spawn {SETUP_SCRIPT_REL}: {e}\n"),
            )?;
            return Ok(SetupOutcome::Failed {
                code: None,
                timed_out: false,
            });
        }
    };

    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(if status.success() {
                SetupOutcome::Succeeded
            } else {
                SetupOutcome::Failed {
                    code: status.code(),
                    timed_out: false,
                }
            });
        }
        if start.elapsed() >= timeout {
            terminate_setup_process_tree(child.id())?;
            // The script may have exited on its own between the `try_wait` above and now; if so,
            // honor its real status rather than reporting a spurious timeout.
            if let Ok(status) = child.wait() {
                if status.success() {
                    return Ok(SetupOutcome::Succeeded);
                }
            }
            append_log(
                log_path,
                &format!("monica: setup timed out after {timeout:?}; killed\n"),
            )?;
            return Ok(SetupOutcome::Failed {
                code: None,
                timed_out: true,
            });
        }
        thread::sleep(SETUP_POLL_INTERVAL);
    }
}

fn terminate_setup_process_tree(pid: u32) -> Result<()> {
    #[cfg(unix)]
    {
        let pgid = format!("-{pid}");
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(&pgid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(&pgid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        Ok(())
    }

    #[cfg(not(unix))]
    {
        let pid = pid.to_string();
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID"])
            .arg(&pid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        Ok(())
    }
}

fn write_log(log_path: &Path, note: &str) -> Result<()> {
    fs::write(log_path, note).with_context(|| format!("failed to write {}", log_path.display()))
}

fn append_log(log_path: &Path, note: &str) -> Result<()> {
    OpenOptions::new()
        .append(true)
        .open(log_path)
        .and_then(|mut f| f.write_all(note.as_bytes()))
        .with_context(|| format!("failed to append to {}", log_path.display()))
}

/// What `run_issue` did, for the caller to render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    pub work_item_id: String,
    pub run_id: String,
    pub branch: String,
    pub worktree_path: String,
    pub status: Status,
    pub setup: SetupOutcome,
    pub log_path: String,
}

/// Connect a work item to its repo's execution environment: resolve the project, generate the
/// branch, create the git worktree, record a [`crate::Run`] (`setting_up`), run `.monica/setup.sh`,
/// and settle the run + work item to `running` / `failed`.
///
/// The worktree is created first; only once it exists is a run recorded. A failure before the run
/// is recorded leaves the work item untouched (`ready`). Once the run is recorded, every subsequent
/// failure is converted to a best-effort `failed` settle so neither the run nor the work item is
/// left stranded in `setting_up`.
pub fn run_issue(db: &mut Db, work_item_id: &str) -> Result<RunReport> {
    let item = db
        .get_work_item(work_item_id)?
        .ok_or_else(|| anyhow!("work item not found: {work_item_id}"))?;

    let project_id = item.project_id.clone().ok_or_else(|| {
        anyhow!(
            "{work_item_id} is not linked to a project; run `monica project init` in the repo, \
             then re-track the issue"
        )
    })?;
    let project = db
        .get_project(&project_id)?
        .ok_or_else(|| anyhow!("project not found: {project_id}"))?;
    let repo_path = project.path.clone().ok_or_else(|| {
        anyhow!("project {project_id} has no checkout path; run `monica project init` in the repo")
    })?;

    let github_issue_number = latest_github_issue_number(db, work_item_id)?;
    let mon = monica_number(work_item_id)?;
    let branch = branch_name(github_issue_number, mon);
    let worktree_path = worktree_path_for(&project, &branch)?;

    if worktree_path.exists() {
        return Err(anyhow!(
            "worktree already exists at {}; {work_item_id} appears to have been run already \
             (remove it with `git worktree remove` to re-run)",
            worktree_path.display()
        ));
    }

    create_worktree(
        Path::new(&repo_path),
        &worktree_path,
        &branch,
        &project.default_branch,
    )?;

    let worktree_str = worktree_path.to_string_lossy().into_owned();
    let run = db.start_run(NewRun {
        work_item_id: work_item_id.to_string(),
        agent: Some(project.agent_default),
        branch: Some(branch.clone()),
        worktree_path: Some(worktree_str.clone()),
    })?;

    // The work item is now `setting_up`. Any failure from here must settle it to `failed`, never
    // leave it stranded — so an error from setup_phase is caught and converted before propagating.
    let setup = match setup_phase(&run.id, work_item_id, &worktree_path, &project, &branch) {
        Ok(setup) => setup,
        Err(e) => {
            // Best effort: if this settle also fails there is nothing more we can do.
            let _ = db.finish_run(&run.id, work_item_id, Status::Failed);
            return Err(e);
        }
    };

    let status = if setup.outcome.is_failure() {
        Status::Failed
    } else {
        Status::Running
    };
    db.finish_run(&run.id, work_item_id, status)?;

    Ok(RunReport {
        work_item_id: work_item_id.to_string(),
        run_id: run.id,
        branch,
        worktree_path: worktree_str,
        status,
        setup: setup.outcome,
        log_path: setup.log_path,
    })
}

struct SetupResult {
    outcome: SetupOutcome,
    log_path: String,
}

/// The fallible, DB-free steps between `start_run` and the final settle: create the run directory
/// and run `.monica/setup.sh`. Kept separate so the caller can guarantee a `failed` settle on any
/// error here.
fn setup_phase(
    run_id: &str,
    work_item_id: &str,
    worktree_path: &Path,
    project: &Project,
    branch: &str,
) -> Result<SetupResult> {
    let run_dir = paths::run_dir(run_id)?;
    fs::create_dir_all(&run_dir)
        .with_context(|| format!("failed to create {}", run_dir.display()))?;
    let log_path = run_dir.join("setup.log");
    let env = SetupEnv {
        monica_id: work_item_id.to_string(),
        run_id: run_id.to_string(),
        project_id: project.id.clone(),
        branch: branch.to_string(),
        worktree: worktree_path.to_string_lossy().into_owned(),
    };
    let timeout = Duration::from_secs(project.setup_timeout_sec.max(0) as u64);
    let outcome = run_setup_script(worktree_path, &log_path, &env, timeout)?;
    Ok(SetupResult {
        outcome,
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

fn latest_github_issue_number(db: &Db, work_item_id: &str) -> Result<Option<i64>> {
    let refs = db.list_external_refs(work_item_id)?;
    Ok(refs
        .into_iter()
        .rfind(|r| r.ref_type == RefType::GithubIssue)
        .and_then(|r| r.number))
}

fn create_worktree(repo: &Path, worktree: &Path, branch: &str, base: &str) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ExternalRef, NewWorkItem, RefType, WorkItemKind};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_tmp(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!(
            "monica-test-{tag}-{}-{nanos}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// A temp directory cleaned up on drop.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            Tmp(unique_tmp(tag))
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn set_exec(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).unwrap();
    }
    #[cfg(not(unix))]
    fn set_exec(_path: &Path) {}

    fn write_setup(worktree: &Path, body: &str) {
        let dir = worktree.join(".monica");
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("setup.sh");
        fs::write(&script, body).unwrap();
        set_exec(&script);
    }

    fn sample_env() -> SetupEnv {
        SetupEnv {
            monica_id: "MON-1".to_string(),
            run_id: "run-1".to_string(),
            project_id: "ashigirl96/monica".to_string(),
            branch: "issue-9".to_string(),
            worktree: "/tmp/wt".to_string(),
        }
    }

    // ---- monica_number ----

    #[test]
    fn monica_number_parses_and_rejects() {
        assert_eq!(monica_number("MON-1").unwrap(), 1);
        assert_eq!(monica_number("MON-42").unwrap(), 42);
        assert!(monica_number("MON-0").is_err());
        assert!(monica_number("MON-abc").is_err());
        assert!(monica_number("42").is_err());
        assert!(monica_number("").is_err());
    }

    // ---- branch_name ----

    #[test]
    fn branch_name_uses_issue_number_or_falls_back_to_mon() {
        assert_eq!(branch_name(Some(9), 1), "issue-9");
        assert_eq!(branch_name(Some(18), 42), "issue-18");
        assert_eq!(branch_name(None, 1), "mon-1");
        assert_eq!(branch_name(None, 42), "mon-42");
    }

    // ---- sanitize_path_component ----

    #[test]
    fn sanitize_path_component_replaces_slashes_and_odd_chars() {
        assert_eq!(sanitize_path_component("issue-9"), "issue-9");
        assert_eq!(sanitize_path_component("a/b"), "a-b");
        assert_eq!(sanitize_path_component("feat/x y#9"), "feat-x-y-9");
        assert_eq!(
            sanitize_path_component("keep.dot_under-dash"),
            "keep.dot_under-dash"
        );
    }

    // ---- worktree_path_for ----

    #[test]
    fn worktree_path_uses_explicit_root() {
        let mut project = Project::from_repo("ashigirl96/monica");
        project.worktree_root = Some("/custom/root".to_string());
        let path = worktree_path_for(&project, "issue-9").unwrap();
        assert_eq!(path, Path::new("/custom/root/issue-9"));
    }

    #[test]
    fn worktree_path_defaults_under_project_path() {
        let mut project = Project::from_repo("ashigirl96/monica");
        project.path = Some("/tmp/monica".to_string());
        let path = worktree_path_for(&project, "issue-9").unwrap();
        assert_eq!(path, Path::new("/tmp/monica/.worktrees/issue-9"));
    }

    #[test]
    fn worktree_path_requires_project_path_or_explicit_root() {
        let project = Project::from_repo("ashigirl96/monica");
        let err = worktree_path_for(&project, "issue-9").unwrap_err();
        assert!(
            format!("{err:#}").contains("has neither path nor worktree_root"),
            "{err:#}"
        );
    }

    // ---- run_setup_script (no git, no MONICA_HOME) ----

    #[test]
    fn setup_skipped_when_no_script() {
        let wt = Tmp::new("setup-skip");
        let log = wt.path().join("setup.log");
        let outcome =
            run_setup_script(wt.path(), &log, &sample_env(), Duration::from_secs(5)).unwrap();
        assert_eq!(outcome, SetupOutcome::Skipped);
        assert!(fs::read_to_string(&log).unwrap().contains("skipped"));
    }

    #[test]
    fn setup_succeeds_and_captures_env() {
        let wt = Tmp::new("setup-ok");
        write_setup(
            wt.path(),
            "#!/usr/bin/env bash\necho \"id=$MONICA_ID branch=$MONICA_BRANCH run=$MONICA_RUN_ID\"\n",
        );
        let log = wt.path().join("setup.log");
        let outcome =
            run_setup_script(wt.path(), &log, &sample_env(), Duration::from_secs(5)).unwrap();
        assert_eq!(outcome, SetupOutcome::Succeeded);
        let captured = fs::read_to_string(&log).unwrap();
        assert!(captured.contains("id=MON-1"), "{captured}");
        assert!(captured.contains("branch=issue-9"), "{captured}");
        assert!(captured.contains("run=run-1"), "{captured}");
    }

    #[test]
    fn setup_failure_reports_exit_code() {
        let wt = Tmp::new("setup-fail");
        write_setup(wt.path(), "#!/usr/bin/env bash\nexit 3\n");
        let log = wt.path().join("setup.log");
        let outcome =
            run_setup_script(wt.path(), &log, &sample_env(), Duration::from_secs(5)).unwrap();
        assert_eq!(
            outcome,
            SetupOutcome::Failed {
                code: Some(3),
                timed_out: false
            }
        );
    }

    #[test]
    fn setup_times_out_and_is_killed() {
        let wt = Tmp::new("setup-timeout");
        write_setup(wt.path(), "#!/usr/bin/env bash\nsleep 5\n");
        let log = wt.path().join("setup.log");
        let start = Instant::now();
        let outcome =
            run_setup_script(wt.path(), &log, &sample_env(), Duration::from_millis(200)).unwrap();
        assert_eq!(
            outcome,
            SetupOutcome::Failed {
                code: None,
                timed_out: true
            }
        );
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "timeout must kill the script well before it would finish"
        );
        assert!(fs::read_to_string(&log).unwrap().contains("timed out"));
    }

    #[cfg(unix)]
    #[test]
    fn setup_timeout_kills_descendant_processes() {
        let wt = Tmp::new("setup-timeout-tree");
        let marker = "monica_descendant_group_kill_test";
        write_setup(
            wt.path(),
            &format!("#!/usr/bin/env bash\n(\n  exec -a {marker} sleep 9999\n) &\nsleep 5\n"),
        );
        let mut child = {
            let mut command = Command::new(wt.path().join(".monica/setup.sh"));
            command.process_group(0);
            command
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        };

        let mut saw_descendant = false;
        for _ in 0..20 {
            if Command::new("pgrep")
                .args(["-q", "-f", marker])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                saw_descendant = true;
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(saw_descendant, "setup should spawn descendant process");
        let running = Command::new("pgrep")
            .args(["-q", "-f", marker])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if running {
            terminate_setup_process_tree(child.id()).unwrap();
        } else {
            panic!("descendant did not persist long enough to assert termination behavior");
        }
        thread::sleep(Duration::from_millis(200));
        let running = Command::new("pgrep")
            .args(["-q", "-f", marker])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(
            !running,
            "background process should be terminated by process-group kill"
        );
        assert!(
            !child.wait().unwrap().success(),
            "killing the process group should terminate setup helper"
        );
    }

    // ---- run_issue integration (real git + temp MONICA_HOME) ----

    fn run_git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &Path, setup_sh: Option<&str>) {
        run_git(dir, &["init", "-b", "main"]);
        run_git(dir, &["config", "user.email", "test@example.com"]);
        run_git(dir, &["config", "user.name", "Monica Test"]);
        fs::write(dir.join("README.md"), "# test\n").unwrap();
        if let Some(body) = setup_sh {
            write_setup(dir, body);
        }
        run_git(dir, &["add", "-A"]);
        run_git(dir, &["commit", "-m", "init"]);
    }

    fn tracked_item(db: &mut Db, title: &str, gh: Option<i64>) -> String {
        let mut item = NewWorkItem::new(WorkItemKind::Development, title);
        item.status = Status::Ready;
        item.project_id = Some("ashigirl96/monica".to_string());
        let external = ExternalRef::new(
            String::new(),
            RefType::GithubIssue,
            Some("ashigirl96/monica".to_string()),
            gh,
            None,
        );
        db.insert_work_item_with_ref(item, external).unwrap().id
    }

    fn db_with_project(repo: &Path) -> Db {
        let db = Db::open_in_memory().unwrap();
        let mut project = Project::from_repo("ashigirl96/monica");
        project.path = Some(repo.to_string_lossy().into_owned());
        db.upsert_project(&project).unwrap();
        db
    }

    #[test]
    fn run_issue_happy_path() {
        let _env = paths::test_env_guard();
        let home = Tmp::new("home");
        std::env::set_var("MONICA_HOME", home.path());
        let repo = Tmp::new("repo");
        init_repo(
            repo.path(),
            Some("#!/usr/bin/env bash\necho \"hello $MONICA_ID $MONICA_BRANCH\"\n"),
        );

        let mut db = db_with_project(repo.path());
        let id = tracked_item(&mut db, "Add feature X", Some(9));

        let report = run_issue(&mut db, &id).unwrap();

        assert_eq!(report.status, Status::Running);
        assert_eq!(report.setup, SetupOutcome::Succeeded);
        assert_eq!(report.branch, "issue-9");
        assert!(Path::new(&report.worktree_path)
            .join(".monica/setup.sh")
            .exists());

        let log = fs::read_to_string(&report.log_path).unwrap();
        assert!(log.contains("hello MON-1 issue-9"), "{log}");

        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Running
        );
        assert_eq!(
            db.get_run(&report.run_id).unwrap().unwrap().status,
            Status::Running
        );

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn run_issue_skips_setup_when_absent() {
        let _env = paths::test_env_guard();
        let home = Tmp::new("home");
        std::env::set_var("MONICA_HOME", home.path());
        let repo = Tmp::new("repo");
        init_repo(repo.path(), None);

        let mut db = db_with_project(repo.path());
        let id = tracked_item(&mut db, "no setup", None);

        let report = run_issue(&mut db, &id).unwrap();
        assert_eq!(report.setup, SetupOutcome::Skipped);
        assert_eq!(report.status, Status::Running);
        assert_eq!(report.branch, "mon-1");

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn run_issue_marks_failed_when_setup_fails() {
        let _env = paths::test_env_guard();
        let home = Tmp::new("home");
        std::env::set_var("MONICA_HOME", home.path());
        let repo = Tmp::new("repo");
        init_repo(repo.path(), Some("#!/usr/bin/env bash\nexit 1\n"));

        let mut db = db_with_project(repo.path());
        let id = tracked_item(&mut db, "failing setup", Some(7));

        let report = run_issue(&mut db, &id).unwrap();
        assert_eq!(report.status, Status::Failed);
        assert!(report.setup.is_failure());
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Failed
        );
        assert_eq!(
            db.get_run(&report.run_id).unwrap().unwrap().status,
            Status::Failed
        );

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn run_issue_rejects_rerun_when_worktree_exists() {
        let _env = paths::test_env_guard();
        let home = Tmp::new("home");
        std::env::set_var("MONICA_HOME", home.path());
        let repo = Tmp::new("repo");
        init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"));

        let mut db = db_with_project(repo.path());
        let id = tracked_item(&mut db, "once", Some(9));

        run_issue(&mut db, &id).unwrap();
        let err = run_issue(&mut db, &id).unwrap_err();
        assert!(
            format!("{err:#}").contains("worktree already exists"),
            "{err:#}"
        );
        // The first run's terminal state must survive the rejected rerun, and no phantom second
        // run may be recorded (the guard fires before `start_run`).
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Running
        );
        assert!(db.get_run("run-2").unwrap().is_none());

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn run_issue_failure_after_start_run_settles_failed() {
        let _env = paths::test_env_guard();
        let home = Tmp::new("home");
        std::env::set_var("MONICA_HOME", home.path());
        let repo = Tmp::new("repo");
        init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"));

        let mut db = db_with_project(repo.path());
        let id = tracked_item(&mut db, "stuck guard", Some(9));

        // Block `runs/run-1` creation: place a regular file where the run dir must go, so
        // create_dir_all fails *after* start_run has moved the work item to setting_up.
        let runs = home.path().join("runs");
        fs::create_dir_all(&runs).unwrap();
        fs::write(runs.join("run-1"), "x").unwrap();

        let result = run_issue(&mut db, &id);
        assert!(result.is_err(), "internal failure must propagate");
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Failed,
            "work item must not be stranded in setting_up"
        );
        assert_eq!(
            db.get_run("run-1").unwrap().unwrap().status,
            Status::Failed,
            "run must be settled to failed"
        );

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn run_issue_errors_without_project() {
        let mut db = Db::open_in_memory().unwrap();
        let id = db
            .insert_work_item(NewWorkItem::new(WorkItemKind::Development, "orphan"))
            .unwrap()
            .id;
        assert!(run_issue(&mut db, &id).is_err());
        assert!(run_issue(&mut db, "MON-999").is_err());
    }

    #[test]
    fn run_issue_errors_when_project_has_no_path() {
        let mut db = Db::open_in_memory().unwrap();
        // A project exists but its checkout path was never set (no `project init` in the repo yet).
        db.upsert_project(&Project::from_repo("ashigirl96/monica"))
            .unwrap();
        let id = tracked_item(&mut db, "no path", None);
        let err = run_issue(&mut db, &id).unwrap_err();
        assert!(format!("{err:#}").contains("no checkout path"), "{err:#}");
    }
}
