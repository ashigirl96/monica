use std::io::{self, Read};

use anyhow::Result;
use clap::Subcommand;

#[derive(Subcommand)]
pub enum HookCommand {
    /// Receive a Claude Code hook event on stdin (no-op until #20 wires the bridge)
    Claude,
}

pub fn run(cmd: HookCommand) -> Result<()> {
    match cmd {
        HookCommand::Claude => claude(),
    }
}

fn claude() -> Result<()> {
    // Drain stdin so Claude's hook payload doesn't trigger SIGPIPE on its side. #20 will replace
    // this with a real receiver that parses the JSON event and updates work-item/run state.
    let mut buf = Vec::new();
    let _ = io::stdin().lock().read_to_end(&mut buf);
    Ok(())
}
