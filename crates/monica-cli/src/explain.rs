use anyhow::{Context, Result};
use clap::Subcommand;

use crate::event_sink;

const TERMINAL_SESSION_ID_ENV: &str = "MONICA_TERMINAL_SESSION_ID";
const TERMINAL_HOME_ENV: &str = "MONICA_TERMINAL_HOME";

#[derive(Subcommand)]
pub enum ExplainCommand {
    /// Register a topic explanation and create its artifact directory
    New {
        /// Human-readable explanation title
        title: String,
    },
}

pub fn run(cmd: ExplainCommand) -> Result<()> {
    match cmd {
        ExplainCommand::New { title } => new(&title),
    }
}

fn new(title: &str) -> Result<()> {
    let terminal_session_id = std::env::var(TERMINAL_SESSION_ID_ENV)
        .with_context(|| format!("{TERMINAL_SESSION_ID_ENV} is not set; run this command from a Monica terminal"))?;
    if terminal_session_id.trim().is_empty() {
        anyhow::bail!("{TERMINAL_SESSION_ID_ENV} is empty; run this command from a Monica terminal");
    }

    pin_terminal_home()?;
    let artifact_root = std::path::absolute(monica_paths::explanations_dir()?)?;
    let mut monica = event_sink::open()?;
    let explanation =
        monica.explanations().create_topic(title, &terminal_session_id, &artifact_root)?;
    println!("{}", explanation.artifact_path);
    Ok(())
}

/// A repo's direnv may replace MONICA_HOME after the terminal starts. The terminal-scoped copy
/// keeps this command on the same database that assigned MONICA_TERMINAL_SESSION_ID.
fn pin_terminal_home() -> Result<()> {
    let home = std::env::var_os(TERMINAL_HOME_ENV)
        .filter(|value| !value.is_empty())
        .with_context(|| {
            format!("{TERMINAL_HOME_ENV} is not set; open a new Monica terminal and try again")
        })?;
    let home = std::path::PathBuf::from(home);
    if !home.is_absolute() {
        anyhow::bail!("{TERMINAL_HOME_ENV} must be an absolute path");
    }
    std::env::set_var("MONICA_HOME", home);
    Ok(())
}
