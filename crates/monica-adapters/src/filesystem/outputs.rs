use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use monica_application::{ExecutionProfile, ExplanationOutputs, ShellScaffolding, TaskRunOutputs};
use monica_domain::{Agent, Project};

use monica_paths as paths;

use super::shell_scaffold::{
    base_shell_env, pinned_hook_cmd, strip_legacy_claude_hooks, write_codex_hooks_config,
};

#[derive(Debug, Default, Clone, Copy)]
pub struct FsTaskRunOutputs;

impl TaskRunOutputs for FsTaskRunOutputs {
    fn task_run_dir(&self, task_run_id: &str) -> Result<PathBuf> {
        paths::task_run_dir(task_run_id)
    }

    fn setup_log_path(&self, task_run_id: &str) -> Result<PathBuf> {
        let dir = self.task_run_dir(task_run_id)?;
        fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
        Ok(dir.join("setup.log"))
    }

    fn prepare_task_shell_env(
        &self,
        task_id: &str,
        project: &Project,
        profile: &ExecutionProfile,
        task_run_id: Option<&str>,
        cwd: &Path,
    ) -> Result<Vec<(String, String)>> {
        match profile.agent_default {
            Agent::Claude => {}
            Agent::Codex => {
                write_codex_hooks_config(cwd, &pinned_hook_cmd(Agent::Codex)?)?;
            }
        }

        let mut env = vec![
            ("MONICA_TASK_ID".to_string(), task_id.to_string()),
            ("MONICA_PROJECT_ID".to_string(), project.id.clone()),
        ];
        if let Some(run_id) = task_run_id {
            env.push(("MONICA_TASK_RUN_ID".to_string(), run_id.to_string()));
        }
        Ok(env)
    }
}

impl ShellScaffolding for FsTaskRunOutputs {
    fn prepare_base_shell_env(&self, cwd: &Path) -> Result<Vec<(String, String)>> {
        strip_legacy_claude_hooks(cwd)?;
        base_shell_env()
    }
}

impl ExplanationOutputs for FsTaskRunOutputs {
    fn write_scaffold(&self, explanation_id: &str, title: &str) -> Result<PathBuf> {
        super::explanations::write_explanation_scaffold(explanation_id, title)
    }

    fn remove_dir(&self, explanation_id: &str) -> Result<()> {
        super::explanations::remove_explanation_dir(explanation_id)
    }
}
