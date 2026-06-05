use std::process::Command;

use anyhow::{anyhow, Result};
use monica_core::{AgentLaunch, AgentLauncher};

#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessAgentLauncher;

impl AgentLauncher for ProcessAgentLauncher {
    fn launch(&self, launch: &AgentLaunch) -> Result<()> {
        let mut command = Command::new(&launch.program);
        command.args(&launch.args).current_dir(&launch.cwd);
        for key in std::env::vars()
            .map(|(key, _)| key)
            .filter(|key| should_remove_agent_env(key))
        {
            command.env_remove(key);
        }
        match command
            .envs(launch.env.iter().map(|(key, value)| (key, value)))
            .status()
        {
            Ok(_) => Ok(()),
            Err(e) => Err(anyhow!(
                "failed to launch {}: {e}; install Claude Code and ensure `{}` is on PATH",
                launch.program,
                launch.program
            )),
        }
    }
}

fn should_remove_agent_env(key: &str) -> bool {
    key.starts_with("NORI_")
}
