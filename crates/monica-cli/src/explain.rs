use anyhow::{anyhow, Result};
use clap::Subcommand;
use monica_domain::ExplanationMode;

use crate::event_sink;

#[derive(Subcommand)]
pub enum ExplainCommand {
    /// Create a new explanation document
    New {
        /// Title for the explanation
        #[arg(long)]
        title: String,
        /// Mode: "diff" or "topic"
        #[arg(long)]
        mode: String,
        /// One-to-two line summary shown on the explanation list card
        #[arg(long)]
        summary: Option<String>,
    },
}

pub fn run(cmd: ExplainCommand) -> Result<()> {
    match cmd {
        ExplainCommand::New {
            title,
            mode,
            summary,
        } => new_command(&title, &mode, summary.as_deref()),
    }
}

fn new_command(title: &str, mode_str: &str, summary: Option<&str>) -> Result<()> {
    let terminal_session_id = std::env::var("MONICA_TERMINAL_SESSION_ID").map_err(|_| {
        anyhow!(
            "MONICA_TERMINAL_SESSION_ID is not set — run this command inside a Monica terminal"
        )
    })?;

    let mode: ExplanationMode = mode_str
        .parse()
        .map_err(|_| anyhow!("invalid mode {mode_str:?} (expected \"diff\" or \"topic\")"))?;

    let mut monica = event_sink::open()?;
    let (_explanation, index_path) = monica
        .explanations()
        .create_explanation(&terminal_session_id, title, mode, summary)
        .map_err(|e| {
            let db_path = monica_paths::db_path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "(unknown)".to_string());
            anyhow!("{e} (db: {db_path})")
        })?;

    eprintln!("Created explanation");
    println!("{}", index_path.display());
    Ok(())
}
