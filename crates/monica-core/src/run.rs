use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

use crate::claude::{self, AgentLaunch};
use crate::model::{Agent, NewRun};
use crate::{paths, Db, Project, RefType, Status};

const SETUP_SCRIPT_REL: &str = ".monica/setup.sh";
const SETUP_POLL_INTERVAL: Duration = Duration::from_millis(50);
const CLAUDE_PROGRAM: &str = "claude";

/// The shell command the four generated hooks invoke. Uses the absolute path of *this* monica
/// executable via [`std::env::current_exe`] so the hook resolves no matter how the user launched
/// monica (e.g. `./monica` from a checkout, or an install location that isn't on `PATH`) — claude
/// runs the command via `sh -c`, which would otherwise PATH-lookup a bare `monica` and silently
/// fail, leaving runs stranded as `running`. The path is single-quoted for safety against spaces;
/// `monica` is the last-ditch fallback when the platform refuses to report the running exe.
fn hook_command() -> String {
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "monica".to_string());
    format!("{} hook claude", shell_quote_single(&exe))
}

/// Wrap `s` in single quotes for `/bin/sh`, escaping any embedded single quote as `'\''` (close,
/// literal quote, reopen). Survives paths containing spaces or apostrophes intact.
fn shell_quote_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

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

/// What `run_issue` did, for the caller to render and (optionally) hand to [`launch_agent`].
/// `settings_path` and `agent_launch` are both `Some` exactly when an agent was prepared (i.e.
/// `run_issue` was called with a non-`None` `agent` and setup did not fail). When both are
/// `Some`, `settings_path` is also the value at `agent_launch.args[1]` — both are written together
/// by `build_claude_launch` from the same string, kept side-by-side because one is canonical for
/// display/persistence and the other is structural for the spawn invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    pub work_item_id: String,
    pub run_id: String,
    pub branch: String,
    pub worktree_path: String,
    pub status: Status,
    pub setup: SetupOutcome,
    pub log_path: String,
    pub settings_path: Option<String>,
    pub agent_launch: Option<AgentLaunch>,
}

/// Connect a work item to its repo's execution environment: resolve the project, generate the
/// branch, create the git worktree, record a [`crate::Run`] (`setting_up`), run `.monica/setup.sh`,
/// optionally prepare an agent launch spec, and settle the run + work item to `running` / `failed`.
///
/// `agent` selects which agent (if any) to prepare for `launch_agent`. `None` keeps the M0
/// "setup only" behavior (worktree + setup, settle to `running`, no agent launch).
///
/// The worktree is created first; only once it exists is a run recorded. A failure before the run
/// is recorded leaves the work item untouched (`ready`). Once the run is recorded, every subsequent
/// failure is converted to a best-effort `failed` settle so neither the run nor the work item is
/// left stranded in `setting_up`. **This function never spawns the agent process** — that is
/// [`launch_agent`]'s job, so tests can verify the prepared spec without a real `claude` binary.
pub fn run_issue(
    db: &mut Db,
    work_item_id: &str,
    agent: Option<Agent>,
) -> Result<RunReport> {
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
        // Record the agent the caller actually asked for — `None` means "no launch requested",
        // not "default to claude" — so the persisted Run is honest about what happened.
        agent,
        branch: Some(branch.clone()),
        worktree_path: Some(worktree_str.clone()),
    })?;

    // The work item is now `setting_up`. Any failure from here must settle it to `failed`, never
    // leave it stranded — so an error from setup_phase is caught and converted before propagating.
    let setup = match setup_phase(&run.id, work_item_id, &worktree_path, &project, &branch) {
        Ok(setup) => setup,
        Err(e) => {
            let _ = db.finish_run(&run.id, work_item_id, Status::Failed);
            return Err(e);
        }
    };

    let setup_outcome = setup.outcome;
    let log_path = setup.log_path;

    if setup_outcome.is_failure() {
        db.finish_run(&run.id, work_item_id, Status::Failed)?;
        return Ok(RunReport {
            work_item_id: work_item_id.to_string(),
            run_id: run.id,
            branch,
            worktree_path: worktree_str,
            status: Status::Failed,
            setup: setup_outcome,
            log_path,
            settings_path: None,
            agent_launch: None,
        });
    }

    // setup ok/skipped → prepare the agent's launch spec (if requested), then settle running.
    let (agent_launch, settings_path) = match agent {
        None => (None, None),
        Some(Agent::Claude) => {
            match build_claude_launch(db, &run.id, work_item_id, &project, &worktree_path) {
                Ok((launch, path)) => (Some(launch), Some(path)),
                Err(e) => {
                    let _ = db.finish_run(&run.id, work_item_id, Status::Failed);
                    return Err(e);
                }
            }
        }
    };
    if let Err(e) = db.finish_run(&run.id, work_item_id, Status::Running) {
        // Even the final settle must not leave the pair stranded in setting_up: re-settle to
        // failed before surfacing the original DB error.
        let _ = db.finish_run(&run.id, work_item_id, Status::Failed);
        return Err(e);
    }

    Ok(RunReport {
        work_item_id: work_item_id.to_string(),
        run_id: run.id,
        branch,
        worktree_path: worktree_str,
        status: Status::Running,
        setup: setup_outcome,
        log_path,
        settings_path,
        agent_launch,
    })
}

/// Prepare the per-run Claude Code launch artifacts and the [`AgentLaunch`] spec the caller can
/// hand to [`launch_agent`]. Writes `claude-settings.json` and `prompt.txt` into the existing
/// `runs/<run_id>/` directory (created by `setup_phase`) and records `run.settings_path` in the DB.
/// Does **not** spawn `claude`.
fn build_claude_launch(
    db: &Db,
    run_id: &str,
    work_item_id: &str,
    project: &Project,
    worktree: &Path,
) -> Result<(AgentLaunch, String)> {
    let run_dir = paths::run_dir(run_id)?;
    let settings_path = run_dir.join("claude-settings.json");
    let settings_body = claude::claude_settings_json(&hook_command())?;
    fs::write(&settings_path, settings_body)
        .with_context(|| format!("failed to write {}", settings_path.display()))?;

    let prompt = claude::read_prompt(worktree)?;
    // Always write prompt.txt — the verification step (`cat runs/<run_id>/prompt.txt`) needs the
    // file to exist whether or not a prompt was provided.
    let prompt_path = run_dir.join("prompt.txt");
    fs::write(&prompt_path, prompt.as_deref().unwrap_or(""))
        .with_context(|| format!("failed to write {}", prompt_path.display()))?;

    let settings_path_str = settings_path.to_string_lossy().into_owned();
    db.set_run_settings_path(run_id, &settings_path_str)?;

    let mut args = vec!["--settings".to_string(), settings_path_str.clone()];
    if let Some(p) = prompt {
        args.push(p);
    }
    let launch = AgentLaunch {
        program: CLAUDE_PROGRAM.to_string(),
        args,
        cwd: worktree.to_string_lossy().into_owned(),
        env: vec![
            ("MONICA_ID".to_string(), work_item_id.to_string()),
            ("MONICA_RUN_ID".to_string(), run_id.to_string()),
            ("MONICA_PROJECT_ID".to_string(), project.id.clone()),
        ],
    };
    Ok((launch, settings_path_str))
}

/// Spawn the agent described by `report.agent_launch` in the foreground (inherited stdio, so the
/// agent's TUI takes over the terminal) and block until it exits. A `None` `agent_launch` is a
/// no-op so CLI callers can call this unconditionally.
///
/// On spawn failure (e.g. `claude` is not on `PATH`) this settles the run + work item to `failed`
/// — keeping the `start_run`-onward invariant that nothing is stranded in `setting_up`/`running`
/// when the agent never actually started. A non-zero *exit* from a successfully-spawned agent is
/// not treated as a monica failure (interactive sessions exit non-zero on Ctrl-C); session-state
/// reconciliation is the hook receiver's job (see issue #20).
pub fn launch_agent(db: &mut Db, report: &RunReport) -> Result<()> {
    let Some(launch) = report.agent_launch.as_ref() else {
        return Ok(());
    };

    // NEVER call `env_clear()` here: the inherited PATH is what lets the agent's own hook
    // commands (e.g. `monica hook claude`) resolve. We only *add* the MONICA_* vars.
    let result = Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(&launch.cwd)
        .envs(launch.env.iter().map(|(k, v)| (k, v)))
        .status();

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = db.finish_run(&report.run_id, &report.work_item_id, Status::Failed);
            Err(anyhow!(
                "failed to launch {}: {e}; install Claude Code and ensure `{}` is on PATH",
                launch.program,
                launch.program
            ))
        }
    }
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
    use crate::test_support::Tmp;

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
        assert_eq!(shell_quote_single("/Users/me/bin/monica"), "'/Users/me/bin/monica'");
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
        assert!(!path.is_empty(), "exe path token must be non-empty in {cmd}");
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
        for event in ["SessionStart", "Stop", "StopFailure", "SessionEnd"] {
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
        assert!(result.is_err(), "build_claude_launch failure must propagate");
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
            settings_path: launch
                .as_ref()
                .and_then(|l| l.args.get(1).cloned()),
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
        assert!(
            format!("{err:#}").contains("failed to launch"),
            "{err:#}"
        );
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
}
