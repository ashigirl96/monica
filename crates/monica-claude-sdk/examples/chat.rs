//! Interactive multi-turn chat with Claude via Monica's Workbench.
//!
//! ```sh
//! cargo run -p monica-claude-sdk --example chat -- <cwd>
//! ```
//!
//! The Monica app must be running. Ctrl-D or an empty line exits.

use std::io::{self, BufRead, Write};

use anyhow::{bail, Result};
use monica_claude_sdk::{ClaudeRuntime, CreateSessionParams, SessionEvent};

fn main() {
    if let Err(err) = run() {
        eprintln!("chat: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cwd = std::env::args()
        .nth(1)
        .unwrap_or_else(|| std::env::current_dir().unwrap().display().to_string());

    let runtime = ClaudeRuntime::connect()?;
    let mut session = runtime.create_session(CreateSessionParams {
        cwd,
        model: None,
        title: Some("chat".to_string()),
    })?;
    eprintln!("session: {}", session.claude_session_id());
    eprintln!("waiting for claude to boot...");
    session.wait_until_idle()?;

    let stdin = io::stdin().lock();
    let mut lines = stdin.lines();

    loop {
        print!("> ");
        io::stdout().flush()?;

        let Some(line) = lines.next() else { break };
        let line = line?;
        if line.is_empty() {
            break;
        }

        session.send_user_message(&line)?;
        run_turn(&mut session)?;
    }

    eprintln!("bye!");
    Ok(())
}

/// Print events until the turn's single final Idle. `Idle { subagents_running: false }`
/// fires only once the whole logical turn is over — subagents included — and only after
/// the turn's messages have been delivered, so it ends the turn with nothing to drain.
fn run_turn(session: &mut monica_claude_sdk::ClaudeSession) -> Result<()> {
    loop {
        match session.next_event()? {
            SessionEvent::AssistantMessage { text } => println!("claude: {text}"),
            SessionEvent::ToolUse { name, .. } => eprintln!("[tool] {name}"),
            SessionEvent::AwaitingUser { wait_reason } => {
                eprintln!(
                    "[awaiting user: {}]",
                    wait_reason.as_deref().unwrap_or("input")
                );
            }
            SessionEvent::Idle { subagents_running: true } => {
                eprintln!("(subagents still running — waiting for next turn)");
            }
            SessionEvent::Idle { subagents_running: false } => return Ok(()),
            SessionEvent::Ended => bail!("session ended unexpectedly"),
        }
    }
}
