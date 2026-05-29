use std::fs;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::agent::{hook_command, shell_quote_single, AgentSessionMode, RunReport};
use super::branch::{branch_name, monica_number, sanitize_path_component, worktree_path_for};
use super::issue::{run_issue, run_issue_with_session_mode};
use super::setup::{run_setup_script, terminate_setup_process_tree, SetupEnv, SetupOutcome};
use crate::model::{ExternalRef, NewRun, NewWorkItem, RefType, WorkItemKind};
use crate::paths;
use crate::test_support::Tmp;
use crate::{delete_issue, launch_agent, Agent, AgentLaunch, Db, Project, Status};

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

// ---- shell_quote_single / hook_command ----

#[test]
fn shell_quote_single_wraps_and_escapes() {
    assert_eq!(shell_quote_single("foo"), "'foo'");
    assert_eq!(
        shell_quote_single("/Users/me/bin/monica"),
        "'/Users/me/bin/monica'"
    );
    // Spaces survive intact because the whole token is single-quoted.
    assert_eq!(shell_quote_single("/My Apps/monica"), "'/My Apps/monica'");
    // An embedded single quote is closed, escaped, and reopened — this is the standard
    // sh-safe form because single-quoted strings cannot contain `'` directly.
    assert_eq!(shell_quote_single("o'malley"), "'o'\\''malley'");
    assert_eq!(shell_quote_single(""), "''");
}

#[test]
fn hook_command_uses_current_exe_and_is_resolvable_without_path() {
    let cmd = hook_command();
    // The exe path must be embedded as a single-quoted token so claude's `sh -c` does not
    // depend on PATH lookup; the subcommand is always `hook claude`.
    assert!(
        cmd.ends_with("' hook claude"),
        "must end with single-quoted exe + ` hook claude`, got {cmd}"
    );
    assert!(cmd.starts_with('\''), "must start with `'`, got {cmd}");
    // Strip the suffix and the outer quotes to get the path token. It must be non-empty —
    // either the test binary's path or the bare-`monica` fallback. Empty would mean a hook
    // command of `'' hook claude`, which would silently expand to nothing useful.
    let path = cmd
        .strip_suffix("' hook claude")
        .and_then(|s| s.strip_prefix('\''))
        .expect("shape already asserted");
    assert!(
        !path.is_empty(),
        "exe path token must be non-empty in {cmd}"
    );
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
    let outcome = run_setup_script(wt.path(), &log, &sample_env(), Duration::from_secs(5)).unwrap();
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
    let outcome = run_setup_script(wt.path(), &log, &sample_env(), Duration::from_secs(5)).unwrap();
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
    let outcome = run_setup_script(wt.path(), &log, &sample_env(), Duration::from_secs(5)).unwrap();
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
    // Observe the descendant through sentinel files in the test's own tmp dir rather than by
    // name via `pgrep`: a global, name-keyed process search cannot tell this run's descendant
    // from one leaked by an earlier run, so a single stray orphan would fail every later run.
    // `ready` proves the descendant launched; `survived` is written only if it outlives the
    // grace period, so a process-group kill that reaches it leaves `survived` absent.
    let wt = Tmp::new("setup-timeout-tree");
    let ready = wt.path().join("ready");
    let survived = wt.path().join("survived");
    write_setup(
            wt.path(),
            "#!/usr/bin/env bash\n(\n  touch \"$MONICA_READY\"\n  sleep 1\n  touch \"$MONICA_SURVIVED\"\n) &\nsleep 5\n",
        );
    let mut child = {
        let mut command = Command::new(wt.path().join(".monica/setup.sh"));
        command.process_group(0);
        command
            .env("MONICA_READY", &ready)
            .env("MONICA_SURVIVED", &survived)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };

    let mut saw_descendant = false;
    for _ in 0..40 {
        if ready.exists() {
            saw_descendant = true;
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(saw_descendant, "setup should spawn descendant process");

    terminate_setup_process_tree(child.id()).unwrap();
    assert!(
        !child.wait().unwrap().success(),
        "killing the process group should terminate setup helper"
    );

    // Wait past the descendant's grace period (`sleep 1`); a survivor would have written
    // `survived` by now, so its absence is what proves the group kill reached the descendant.
    thread::sleep(Duration::from_millis(1200));
    assert!(
        !survived.exists(),
        "descendant must be terminated by the process-group kill before it touches survived"
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

fn init_repo(dir: &Path, setup_sh: Option<&str>, prompt_md: Option<&str>) {
    run_git(dir, &["init", "-b", "main"]);
    run_git(dir, &["config", "user.email", "test@example.com"]);
    run_git(dir, &["config", "user.name", "Monica Test"]);
    fs::write(dir.join("README.md"), "# test\n").unwrap();
    if let Some(body) = setup_sh {
        write_setup(dir, body);
    }
    if let Some(body) = prompt_md {
        let monica = dir.join(".monica");
        fs::create_dir_all(&monica).unwrap();
        fs::write(monica.join("prompt.md"), body).unwrap();
    }
    run_git(dir, &["add", "-A"]);
    run_git(dir, &["commit", "-m", "init"]);
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .status()
        .unwrap()
        .success()
}

fn worktree_registered(repo: &Path, worktree: &Path) -> bool {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git worktree list failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let path = worktree.display().to_string();
    let mut needles = vec![format!("worktree {path}")];
    if let Some(rest) = path.strip_prefix("/var/") {
        needles.push(format!("worktree /private/var/{rest}"));
    } else if let Some(rest) = path.strip_prefix("/private/var/") {
        needles.push(format!("worktree /var/{rest}"));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| needles.iter().any(|needle| line == needle))
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
        None,
    );

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "Add feature X", Some(9));

    let report = run_issue(&mut db, &id, None).unwrap();

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
    init_repo(repo.path(), None, None);

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "no setup", None);

    let report = run_issue(&mut db, &id, None).unwrap();
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
    init_repo(repo.path(), Some("#!/usr/bin/env bash\nexit 1\n"), None);

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "failing setup", Some(7));

    let report = run_issue(&mut db, &id, None).unwrap();
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
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "once", Some(9));

    run_issue(&mut db, &id, None).unwrap();
    let err = run_issue(&mut db, &id, None).unwrap_err();
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
fn run_issue_continue_reuses_existing_worktree_with_new_run() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(
        repo.path(),
        Some("#!/usr/bin/env bash\nprintf 'setup %s\\n' \"$MONICA_RUN_ID\" >> setup-count.txt\n"),
        Some("hello prompt body\n"),
    );

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "continue session", Some(9));

    let first = run_issue(&mut db, &id, None).unwrap();
    assert_eq!(first.run_id, "run-1");
    assert_eq!(
        fs::read_to_string(Path::new(&first.worktree_path).join("setup-count.txt")).unwrap(),
        "setup run-1\n"
    );
    db.finish_run(&first.run_id, &id, Status::Stopped).unwrap();

    let report = run_issue_with_session_mode(
        &mut db,
        &id,
        Some(Agent::Claude),
        AgentSessionMode::Continue,
    )
    .unwrap();

    assert_eq!(report.run_id, "run-2");
    assert_eq!(report.setup, SetupOutcome::ReusedWorktree);
    assert_eq!(report.worktree_path, first.worktree_path);
    assert_eq!(
        fs::read_to_string(Path::new(&report.worktree_path).join("setup-count.txt")).unwrap(),
        "setup run-1\n",
        "reconnect must not run .monica/setup.sh again"
    );
    assert!(fs::read_to_string(&report.log_path)
        .unwrap()
        .contains("reusing existing worktree"));

    let launch = report.agent_launch.as_ref().unwrap();
    let settings_path = report.settings_path.as_deref().unwrap();
    assert_eq!(launch.args[0], "--settings");
    assert_eq!(launch.args[1], settings_path);
    assert_eq!(launch.args[2], "--continue");
    assert_eq!(
        launch.args.len(),
        3,
        "reconnect must not pass the initial prompt as a positional arg"
    );
    assert_eq!(env_value(launch, "MONICA_ID"), Some(id.as_str()));
    assert_eq!(env_value(launch, "MONICA_RUN_ID"), Some("run-2"));

    let prompt_txt = home.path().join("runs").join("run-2").join("prompt.txt");
    assert_eq!(fs::read_to_string(&prompt_txt).unwrap(), "");
    assert_eq!(
        db.get_run(&first.run_id).unwrap().unwrap().status,
        Status::Stopped
    );
    assert_eq!(
        db.get_run(&report.run_id).unwrap().unwrap().status,
        Status::Running
    );

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn run_issue_continue_uses_recorded_worktree_after_project_config_changes() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "continue after config change", Some(9));
    let first = run_issue(&mut db, &id, None).unwrap();
    db.finish_run(&first.run_id, &id, Status::Stopped).unwrap();

    let changed_root = home.path().join("changed-root");
    db.set_project_field(
        "ashigirl96/monica",
        "worktree_root",
        &changed_root.to_string_lossy(),
    )
    .unwrap();
    let changed_project = db.get_project("ashigirl96/monica").unwrap().unwrap();
    let recomputed = worktree_path_for(&changed_project, "issue-9").unwrap();
    assert_ne!(
        recomputed,
        Path::new(&first.worktree_path),
        "test must exercise a config change that would recompute a different worktree path"
    );

    let report = run_issue_with_session_mode(
        &mut db,
        &id,
        Some(Agent::Claude),
        AgentSessionMode::Continue,
    )
    .unwrap();

    assert_eq!(report.worktree_path, first.worktree_path);
    assert_eq!(
        report.agent_launch.as_ref().unwrap().cwd,
        first.worktree_path
    );
    assert_eq!(
        db.get_run(&report.run_id)
            .unwrap()
            .unwrap()
            .worktree_path
            .as_deref(),
        Some(first.worktree_path.as_str())
    );

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn run_issue_fork_resumes_parent_session_in_existing_worktree() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), None, Some("initial prompt\n"));

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "fork session", Some(9));
    let first = run_issue(&mut db, &id, None).unwrap();
    db.finish_run(&first.run_id, &id, Status::Stopped).unwrap();

    let report = run_issue_with_session_mode(
        &mut db,
        &id,
        Some(Agent::Claude),
        AgentSessionMode::Fork {
            session_id: "session-123".to_string(),
        },
    )
    .unwrap();
    let launch = report.agent_launch.as_ref().unwrap();
    let settings_path = report.settings_path.as_deref().unwrap();

    assert_eq!(
        launch.args,
        vec![
            "--settings".to_string(),
            settings_path.to_string(),
            "--fork-session".to_string(),
            "--resume".to_string(),
            "session-123".to_string(),
        ]
    );
    assert_eq!(launch.cwd, first.worktree_path);
    assert_eq!(env_value(launch, "MONICA_RUN_ID"), Some("run-2"));

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn run_issue_reconnect_requires_existing_worktree_and_claude() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), None, None);

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "missing worktree", Some(9));

    let err = run_issue_with_session_mode(
        &mut db,
        &id,
        Some(Agent::Claude),
        AgentSessionMode::Continue,
    )
    .unwrap_err();
    assert!(format!("{err:#}").contains("no recorded worktree"));
    assert!(db.get_run("run-1").unwrap().is_none());

    let err =
        run_issue_with_session_mode(&mut db, &id, None, AgentSessionMode::Continue).unwrap_err();
    assert!(format!("{err:#}").contains("require"), "{err:#}");

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn delete_issue_cleans_worktree_and_branch_then_allows_retrack_rerun() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let mut db = db_with_project(repo.path());
    let first_id = tracked_item(&mut db, "delete after run", Some(9));
    let first = run_issue(&mut db, &first_id, None).unwrap();
    assert!(Path::new(&first.worktree_path).exists());
    assert!(branch_exists(repo.path(), "issue-9"));
    let first_worktree = Path::new(&first.worktree_path);
    fs::write(first_worktree.join("local-work.txt"), "keep me\n").unwrap();
    run_git(first_worktree, &["add", "local-work.txt"]);
    run_git(first_worktree, &["commit", "-m", "local work"]);

    let deleted = delete_issue(&mut db, &first_id).unwrap();
    assert_eq!(deleted.item.id, first_id);
    assert_eq!(deleted.removed_runs, vec![first.run_id]);
    assert_eq!(deleted.removed_branches, vec!["issue-9".to_string()]);
    assert!(db.get_work_item(&first_id).unwrap().is_none());
    assert!(!Path::new(&first.worktree_path).exists());
    assert!(!branch_exists(repo.path(), "issue-9"));

    let second_id = tracked_item(&mut db, "delete after run again", Some(9));
    let second = run_issue(&mut db, &second_id, None).unwrap();
    assert_eq!(second.branch, "issue-9");
    assert!(Path::new(&second.worktree_path).exists());
    assert!(!Path::new(&second.worktree_path)
        .join("local-work.txt")
        .exists());

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn delete_issue_prunes_stale_worktree_metadata_after_manual_directory_removal() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let mut db = db_with_project(repo.path());
    let first_id = tracked_item(&mut db, "manual cleanup", Some(9));
    let first = run_issue(&mut db, &first_id, None).unwrap();
    assert!(Path::new(&first.worktree_path).exists());
    fs::remove_dir_all(&first.worktree_path).unwrap();

    let deleted = delete_issue(&mut db, &first_id).unwrap();
    assert_eq!(deleted.item.id, first_id);
    assert_eq!(deleted.removed_runs, vec![first.run_id]);
    assert_eq!(deleted.removed_branches, vec!["issue-9".to_string()]);
    assert!(db.get_work_item(&first_id).unwrap().is_none());
    assert!(!branch_exists(repo.path(), "issue-9"));

    let second_id = tracked_item(&mut db, "manual cleanup again", Some(9));
    let second = run_issue(&mut db, &second_id, None).unwrap();
    assert_eq!(second.branch, "issue-9");
    assert!(Path::new(&second.worktree_path).exists());

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn delete_issue_tolerates_worktree_already_removed_by_git() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let mut db = db_with_project(repo.path());
    let first_id = tracked_item(&mut db, "already cleaned", Some(9));
    let first = run_issue(&mut db, &first_id, None).unwrap();
    run_git(repo.path(), &["worktree", "remove", &first.worktree_path]);
    assert!(!Path::new(&first.worktree_path).exists());
    assert!(!worktree_registered(
        repo.path(),
        Path::new(&first.worktree_path)
    ));

    let deleted = delete_issue(&mut db, &first_id).unwrap();
    assert_eq!(deleted.item.id, first_id);
    assert_eq!(deleted.removed_runs, vec![first.run_id]);
    assert_eq!(deleted.removed_branches, vec!["issue-9".to_string()]);
    assert!(db.get_work_item(&first_id).unwrap().is_none());
    assert!(!branch_exists(repo.path(), "issue-9"));

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn delete_issue_does_not_prune_unrelated_stale_worktree_metadata() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let unrelated = repo.path().join(".worktrees/unrelated");
    let unrelated_str = unrelated.to_string_lossy().into_owned();
    run_git(
        repo.path(),
        &["worktree", "add", &unrelated_str, "-b", "unrelated", "main"],
    );

    let mut db = db_with_project(repo.path());
    let first_id = tracked_item(&mut db, "targeted stale cleanup", Some(9));
    let first = run_issue(&mut db, &first_id, None).unwrap();
    fs::remove_dir_all(&first.worktree_path).unwrap();
    fs::remove_dir_all(&unrelated).unwrap();

    assert!(worktree_registered(
        repo.path(),
        Path::new(&first.worktree_path)
    ));
    assert!(worktree_registered(repo.path(), &unrelated));

    delete_issue(&mut db, &first_id).unwrap();
    assert!(!worktree_registered(
        repo.path(),
        Path::new(&first.worktree_path)
    ));
    assert!(
        worktree_registered(repo.path(), &unrelated),
        "issue delete must only clean the recorded run worktree metadata"
    );

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn run_issue_failure_after_start_run_settles_failed() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "stuck guard", Some(9));

    // Block `runs/run-1` creation: place a regular file where the run dir must go, so
    // create_dir_all fails *after* start_run has moved the work item to setting_up.
    let runs = home.path().join("runs");
    fs::create_dir_all(&runs).unwrap();
    fs::write(runs.join("run-1"), "x").unwrap();

    let result = run_issue(&mut db, &id, None);
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
    assert!(run_issue(&mut db, &id, None).is_err());
    assert!(run_issue(&mut db, "MON-999", None).is_err());
}

#[test]
fn run_issue_errors_when_project_has_no_path() {
    let mut db = Db::open_in_memory().unwrap();
    // A project exists but its checkout path was never set (no `project init` in the repo yet).
    db.upsert_project(&Project::from_repo("ashigirl96/monica"))
        .unwrap();
    let id = tracked_item(&mut db, "no path", None);
    let err = run_issue(&mut db, &id, None).unwrap_err();
    assert!(format!("{err:#}").contains("no checkout path"), "{err:#}");
}

// ---- agent launch preparation (run_issue with Some(Agent::Claude) — no spawn) ----

fn env_value<'a>(launch: &'a AgentLaunch, key: &str) -> Option<&'a str> {
    launch
        .env
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

#[test]
fn run_issue_with_claude_builds_launch_spec_and_records_settings_path() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(
        repo.path(),
        Some("#!/usr/bin/env bash\ntrue\n"),
        Some("hello prompt body\n"),
    );

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "Add feature X", Some(9));

    let report = run_issue(&mut db, &id, Some(Agent::Claude)).unwrap();

    assert_eq!(report.status, Status::Running);
    let launch = report
        .agent_launch
        .as_ref()
        .expect("agent_launch must be Some when --claude is requested");
    let settings_path = report
        .settings_path
        .as_deref()
        .expect("settings_path must be Some when an agent launch is prepared");

    assert_eq!(launch.program, "claude");
    assert!(
        Path::new(settings_path).is_file(),
        "claude-settings.json must exist at {settings_path}"
    );
    assert_eq!(launch.args.first().map(String::as_str), Some("--settings"));
    assert_eq!(launch.args.get(1).map(String::as_str), Some(settings_path));
    assert_eq!(
        launch.args.get(2).map(String::as_str),
        Some("hello prompt body"),
        "non-empty prompt must be appended as a positional arg"
    );
    assert_eq!(launch.cwd, report.worktree_path);

    assert_eq!(env_value(launch, "MONICA_ID"), Some(id.as_str()));
    assert_eq!(
        env_value(launch, "MONICA_RUN_ID"),
        Some(report.run_id.as_str())
    );
    assert_eq!(
        env_value(launch, "MONICA_PROJECT_ID"),
        Some("ashigirl96/monica")
    );

    let prompt_txt = home
        .path()
        .join("runs")
        .join(&report.run_id)
        .join("prompt.txt");
    assert_eq!(
        fs::read_to_string(&prompt_txt).unwrap(),
        "hello prompt body"
    );

    let settings_body = fs::read_to_string(settings_path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&settings_body).unwrap();
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "Stop",
        "StopFailure",
        "SessionEnd",
    ] {
        let cmd = parsed
            .pointer(&format!("/hooks/{event}/0/hooks/0/command"))
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("{event}: command missing"));
        // The command embeds `current_exe()` (the test binary here) for PATH-independence —
        // assert the shape rather than the exact path so the test is location-agnostic.
        assert!(
            cmd.starts_with('\''),
            "{event}: command must single-quote the exe path, got {cmd}"
        );
        assert!(
            cmd.ends_with("' hook claude"),
            "{event}: command must end with `' hook claude`, got {cmd}"
        );
    }

    let run = db.get_run(&report.run_id).unwrap().unwrap();
    assert_eq!(run.status, Status::Running);
    assert_eq!(run.settings_path.as_deref(), Some(settings_path));
    assert_eq!(
        run.agent.as_deref(),
        Some("claude"),
        "run.agent must reflect the agent the caller asked for"
    );

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn run_issue_with_claude_handles_missing_prompt() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "no prompt", Some(9));

    let report = run_issue(&mut db, &id, Some(Agent::Claude)).unwrap();
    let launch = report.agent_launch.as_ref().unwrap();
    // No positional prompt — args end at the settings path so claude starts in plain
    // interactive mode rather than receiving an empty turn.
    assert_eq!(launch.args.len(), 2, "{:?}", launch.args);
    assert_eq!(launch.args[0], "--settings");

    let prompt_txt = home
        .path()
        .join("runs")
        .join(&report.run_id)
        .join("prompt.txt");
    assert_eq!(fs::read_to_string(&prompt_txt).unwrap(), "");

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn run_issue_with_claude_skips_launch_when_setup_fails() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(
        repo.path(),
        Some("#!/usr/bin/env bash\nexit 1\n"),
        Some("/tackle\n"),
    );

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "broken setup", Some(9));

    let report = run_issue(&mut db, &id, Some(Agent::Claude)).unwrap();
    assert_eq!(report.status, Status::Failed);
    assert!(report.agent_launch.is_none());
    assert!(report.settings_path.is_none());

    let run_dir = home.path().join("runs").join(&report.run_id);
    assert!(
        !run_dir.join("claude-settings.json").exists(),
        "no settings file may be left behind when setup fails"
    );
    assert!(
        !run_dir.join("prompt.txt").exists(),
        "no prompt.txt may be left behind when setup fails"
    );

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn run_issue_with_claude_settles_failed_when_settings_write_fails() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "claude settings write fail", Some(9));

    // Place a directory where build_claude_launch wants to write claude-settings.json, so
    // the write fails *after* start_run has moved the work item to setting_up. This exercises
    // the failed-settle guard inside the agent prep arm (run.rs:348-354), distinct from the
    // setup_phase guard already covered above.
    let settings_blocker = home
        .path()
        .join("runs")
        .join("run-1")
        .join("claude-settings.json");
    fs::create_dir_all(&settings_blocker).unwrap();

    let result = run_issue(&mut db, &id, Some(Agent::Claude));
    assert!(
        result.is_err(),
        "build_claude_launch failure must propagate"
    );
    assert_eq!(
        db.get_work_item(&id).unwrap().unwrap().status,
        Status::Failed,
        "work item must not be stranded in setting_up when agent prep fails"
    );
    assert_eq!(
        db.get_run("run-1").unwrap().unwrap().status,
        Status::Failed,
        "run must be settled to failed when agent prep fails"
    );

    std::env::remove_var("MONICA_HOME");
}

#[test]
fn run_issue_without_agent_records_none_for_run_agent() {
    let _env = paths::test_env_guard();
    let home = Tmp::new("home");
    std::env::set_var("MONICA_HOME", home.path());
    let repo = Tmp::new("repo");
    init_repo(repo.path(), Some("#!/usr/bin/env bash\ntrue\n"), None);

    let mut db = db_with_project(repo.path());
    let id = tracked_item(&mut db, "no flag", None);

    let report = run_issue(&mut db, &id, None).unwrap();
    assert!(report.agent_launch.is_none());
    let run = db.get_run(&report.run_id).unwrap().unwrap();
    assert_eq!(
        run.agent, None,
        "a no-flag run must not record an agent it never launched"
    );

    std::env::remove_var("MONICA_HOME");
}

// ---- launch_agent (no real claude needed — failure path uses a bogus program) ----

fn run_report_stub(work_item_id: &str, run_id: &str, launch: Option<AgentLaunch>) -> RunReport {
    RunReport {
        work_item_id: work_item_id.to_string(),
        run_id: run_id.to_string(),
        branch: "issue-1".to_string(),
        worktree_path: "/tmp/wt".to_string(),
        status: Status::Running,
        setup: SetupOutcome::Skipped,
        log_path: "/tmp/setup.log".to_string(),
        settings_path: launch.as_ref().and_then(|l| l.args.get(1).cloned()),
        agent_launch: launch,
    }
}

#[test]
fn launch_agent_is_noop_when_report_has_no_launch() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db
        .insert_work_item(NewWorkItem::new(WorkItemKind::Development, "no-op"))
        .unwrap();
    let run = db
        .start_run(NewRun {
            work_item_id: item.id.clone(),
            agent: None,
            branch: Some("issue-1".to_string()),
            worktree_path: Some("/tmp/wt".to_string()),
        })
        .unwrap();

    let report = run_report_stub(&item.id, &run.id, None);
    launch_agent(&mut db, &report).unwrap();

    // The run must be untouched: no agent_launch means no spawn and no settle.
    assert_eq!(
        db.get_run(&run.id).unwrap().unwrap().status,
        Status::SettingUp
    );
}

#[test]
fn launch_agent_settles_failed_when_spawn_fails() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db
        .insert_work_item({
            let mut i = NewWorkItem::new(WorkItemKind::Development, "spawn fail");
            i.status = Status::Ready;
            i
        })
        .unwrap();
    let run = db
        .start_run(NewRun {
            work_item_id: item.id.clone(),
            agent: Some(Agent::Claude),
            branch: Some("issue-1".to_string()),
            worktree_path: Some("/tmp/wt".to_string()),
        })
        .unwrap();

    // A program name no system will resolve. We only need spawn() to error; we never check
    // exit status, so a hypothetical name collision still wouldn't ruin the assertion.
    let launch = AgentLaunch {
        program: "monica-launch-agent-test-nonexistent-xyz".to_string(),
        args: vec!["--settings".to_string(), "/tmp/x.json".to_string()],
        cwd: "/tmp".to_string(),
        env: vec![],
    };
    let report = run_report_stub(&item.id, &run.id, Some(launch));

    let err = launch_agent(&mut db, &report).unwrap_err();
    assert!(format!("{err:#}").contains("failed to launch"), "{err:#}");
    assert_eq!(
        db.get_run(&run.id).unwrap().unwrap().status,
        Status::Failed,
        "spawn failure must settle the run to failed, not leave it stranded"
    );
    assert_eq!(
        db.get_work_item(&item.id).unwrap().unwrap().status,
        Status::Failed,
        "the work item must move in lockstep with the run"
    );
}
