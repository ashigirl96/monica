//! Interactive multi-turn chat with Claude via Monica's Workbench.
//!
//! ```sh
//! cargo run -p monica-claude-sdk --example chat -- <cwd>
//! ```
//!
//! The Monica app must be running. Ctrl-D or an empty line exits.

use std::io::{self, BufRead, Write};
use std::time::Duration;

use anyhow::{bail, Result};
use monica_claude_sdk::{ClaudeRuntime, CreateSessionParams, SessionEvent};

/// Grace window after Idle for the transcript drain's late flush.
const LATE_FLUSH: Duration = Duration::from_secs(3);

/// When a tool was used, Idle events arrive repeatedly while the tool runs
/// (e.g. a fork agent taking over a minute). This wider window keeps the
/// loop alive as long as events keep arriving.
const TOOL_IDLE: Duration = Duration::from_secs(30);

/// When the Idle arrives before any AssistantMessage (transcript drain race),
/// wait longer for the text to catch up.
const ANSWER_WAIT: Duration = Duration::from_secs(30);

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

fn run_turn(session: &mut monica_claude_sdk::ClaudeSession) -> Result<()> {
    let mut answered = false;
    let mut saw_tool = false;

    loop {
        match session.next_event()? {
            SessionEvent::AssistantMessage { text } => {
                println!("claude: {text}");
                answered = true;
            }
            SessionEvent::ToolUse { name, .. } => {
                eprintln!("[tool] {name}");
                saw_tool = true;
            }
            SessionEvent::AwaitingUser { wait_reason } => {
                eprintln!(
                    "[awaiting user: {}]",
                    wait_reason.as_deref().unwrap_or("input")
                );
            }
            SessionEvent::Idle { subagents_running } => {
                if subagents_running {
                    eprintln!("(subagents still running — waiting for next turn)");
                    continue;
                }
                if drain_after_idle(session, answered, saw_tool)? {
                    return Ok(());
                }
            }
            SessionEvent::Ended => bail!("session ended unexpectedly"),
        }
    }
}

/// After an Idle event, drain remaining events with an appropriate timeout.
/// Returns `true` when the turn is considered complete.
fn drain_after_idle(
    session: &mut monica_claude_sdk::ClaudeSession,
    answered: bool,
    saw_tool: bool,
) -> Result<bool> {
    let window = if saw_tool {
        TOOL_IDLE
    } else if answered {
        LATE_FLUSH
    } else {
        ANSWER_WAIT
    };

    loop {
        match session.next_event_timeout(window)? {
            Some(SessionEvent::AssistantMessage { text }) => {
                println!("claude: {text}");
            }
            Some(SessionEvent::ToolUse { name, .. }) => {
                eprintln!("[tool] {name}");
            }
            Some(SessionEvent::Idle { .. }) => {
            }
            Some(SessionEvent::AwaitingUser { .. }) | Some(SessionEvent::Ended) | None => {
                return Ok(true);
            }
        }
    }
}
