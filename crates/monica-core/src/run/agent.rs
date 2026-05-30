use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Context, Result};

use crate::claude::{self, AgentLaunch};
use crate::{paths, Db, Project, TaskRunStatus};

use super::setup::SetupOutcome;

const CLAUDE_PROGRAM: &str = "claude";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentLaunchMode {
    New,
    Continue,
    Fork { session_id: String },
}

impl AgentLaunchMode {
    pub fn is_reconnect(&self) -> bool {
        !matches!(self, AgentLaunchMode::New)
    }
}

pub(super) fn hook_command() -> String {
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "monica".to_string());
    format!("{} hook claude", shell_quote_single(&exe))
}

/// Wrap `s` in single quotes for `/bin/sh`, escaping any embedded single quote as `'\''` (close,
/// literal quote, reopen). Survives paths containing spaces or apostrophes intact.
pub(super) fn shell_quote_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub(super) fn should_remove_agent_env(key: &str) -> bool {
    key.starts_with("NORI_")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRunReport {
    pub task_id: String,
    pub task_run_id: String,
    pub branch: String,
    pub worktree_path: String,
    pub status: TaskRunStatus,
    pub setup: SetupOutcome,
    pub log_path: String,
    pub settings_path: Option<String>,
    pub agent_launch: Option<AgentLaunch>,
}

pub(super) fn build_claude_launch(
    db: &Db,
    task_run_id: &str,
    task_id: &str,
    project: &Project,
    worktree: &Path,
    launch_mode: &AgentLaunchMode,
) -> Result<(AgentLaunch, String)> {
    let task_run_dir = paths::task_run_dir(task_run_id)?;
    fs::create_dir_all(&task_run_dir)
        .with_context(|| format!("failed to create {}", task_run_dir.display()))?;
    let settings_path = task_run_dir.join("claude-settings.json");
    let settings_body = claude::claude_settings_json(&hook_command())?;
    fs::write(&settings_path, settings_body)
        .with_context(|| format!("failed to write {}", settings_path.display()))?;

    let prompt = match launch_mode {
        AgentLaunchMode::New => claude::read_prompt(worktree)?,
        AgentLaunchMode::Continue | AgentLaunchMode::Fork { .. } => None,
    };
    // Always write prompt.txt: the verification step (`cat runs/<task_run_id>/prompt.txt`) needs the
    // file to exist whether or not a prompt was provided.
    let prompt_path = task_run_dir.join("prompt.txt");
    fs::write(&prompt_path, prompt.as_deref().unwrap_or(""))
        .with_context(|| format!("failed to write {}", prompt_path.display()))?;

    let settings_path_str = settings_path.to_string_lossy().into_owned();
    db.set_task_run_settings_path(task_run_id, &settings_path_str)?;

    let mut args = vec!["--settings".to_string(), settings_path_str.clone()];
    match launch_mode {
        AgentLaunchMode::New => {
            if let Some(p) = prompt {
                args.push(p);
            }
        }
        AgentLaunchMode::Continue => args.push("--continue".to_string()),
        AgentLaunchMode::Fork { session_id } => {
            args.push("--fork-session".to_string());
            args.push("--resume".to_string());
            args.push(session_id.clone());
        }
    }
    let launch = AgentLaunch {
        program: CLAUDE_PROGRAM.to_string(),
        args,
        cwd: worktree.to_string_lossy().into_owned(),
        env: vec![
            ("MONICA_TASK_ID".to_string(), task_id.to_string()),
            ("MONICA_TASK_RUN_ID".to_string(), task_run_id.to_string()),
            ("MONICA_ID".to_string(), task_id.to_string()),
            ("MONICA_RUN_ID".to_string(), task_run_id.to_string()),
            ("MONICA_PROJECT_ID".to_string(), project.id.clone()),
        ],
    };
    Ok((launch, settings_path_str))
}

/// Spawn the agent described by `report.agent_launch` in the foreground (inherited stdio, so the
/// agent's TUI takes over the terminal) and block until it exits. A `None` `agent_launch` is a
/// no-op so CLI callers can call this unconditionally.
///
/// On spawn failure (e.g. `claude` is not on `PATH`) this settles the run + task to `failed`
/// while keeping the `start_task_run`-onward invariant that nothing is stranded in `setting_up`/`running`
/// when the agent never actually started. A non-zero *exit* from a successfully-spawned agent is
/// not treated as a monica failure (interactive sessions exit non-zero on Ctrl-C); run-state
/// reconciliation is the hook receiver's job (see issue #20).
pub fn launch_agent(db: &mut Db, report: &TaskRunReport) -> Result<()> {
    let Some(launch) = report.agent_launch.as_ref() else {
        return Ok(());
    };

    // NEVER call `env_clear()` here: the inherited PATH is what lets the agent's own hook
    // commands (e.g. `monica hook claude`) resolve. We only remove known hook injectors that
    // prepend their own Claude `--settings`, then add MONICA_* vars.
    let mut command = Command::new(&launch.program);
    command.args(&launch.args).current_dir(&launch.cwd);
    for key in std::env::vars()
        .map(|(key, _)| key)
        .filter(|key| should_remove_agent_env(key))
    {
        command.env_remove(key);
    }
    let result = command
        .envs(launch.env.iter().map(|(k, v)| (k, v)))
        .status();

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = db.finish_task_run(&report.task_run_id, &report.task_id, TaskRunStatus::Failed);
            Err(anyhow!(
                "failed to launch {}: {e}; install Claude Code and ensure `{}` is on PATH",
                launch.program,
                launch.program
            ))
        }
    }
}
