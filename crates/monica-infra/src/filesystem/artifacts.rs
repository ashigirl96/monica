use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use monica_core::{AgentLaunch, AgentLaunchMode, Project, RunArtifacts};
use serde_json::{json, Value};

use crate::filesystem::paths;
use crate::process::claude;

const HOOK_EVENTS_FILE: &str = "hook-events.jsonl";
const CLAUDE_PROGRAM: &str = "claude";

#[derive(Debug, Default, Clone, Copy)]
pub struct FsRunArtifacts;

impl RunArtifacts for FsRunArtifacts {
    fn task_run_dir(&self, task_run_id: &str) -> Result<PathBuf> {
        paths::task_run_dir(task_run_id)
    }

    fn setup_log_path(&self, task_run_id: &str) -> Result<PathBuf> {
        let dir = self.task_run_dir(task_run_id)?;
        fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
        Ok(dir.join("setup.log"))
    }

    fn write_reused_worktree_setup_log(&self, task_run_id: &str) -> Result<String> {
        let log_path = self.setup_log_path(task_run_id)?;
        fs::write(
            &log_path,
            "monica: reusing existing worktree; setup skipped\n",
        )
        .with_context(|| format!("failed to write {}", log_path.display()))?;
        Ok(log_path.to_string_lossy().into_owned())
    }

    fn prepare_claude_launch(
        &self,
        task_run_id: &str,
        task_id: &str,
        project: &Project,
        worktree: &Path,
        launch_mode: &AgentLaunchMode,
    ) -> Result<(AgentLaunch, String)> {
        build_claude_launch(task_run_id, task_id, project, worktree, launch_mode)
    }

    fn append_hook_event(
        &self,
        task_run_id: &str,
        at: &str,
        event_name: Option<&str>,
        parsed: &Option<Value>,
        raw_stdin: &str,
    ) -> Result<()> {
        let dir = self.task_run_dir(task_run_id)?;
        fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
        let path = dir.join(HOOK_EVENTS_FILE);
        let payload = parsed
            .clone()
            .unwrap_or_else(|| json!({ "raw": raw_stdin }));
        let mut line = serde_json::to_string(&json!({
            "at": at,
            "hook_event_name": event_name,
            "payload": payload,
        }))?;
        line.push('\n');

        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(line.as_bytes()))
            .with_context(|| format!("failed to append to {}", path.display()))
    }
}

fn build_claude_launch(
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
    let prompt_path = task_run_dir.join("prompt.txt");
    fs::write(&prompt_path, prompt.as_deref().unwrap_or(""))
        .with_context(|| format!("failed to write {}", prompt_path.display()))?;

    let settings_path_str = settings_path.to_string_lossy().into_owned();
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

fn hook_command() -> String {
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "monica".to_string());
    format!("{} hook claude", shell_quote_single(&exe))
}

fn shell_quote_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
