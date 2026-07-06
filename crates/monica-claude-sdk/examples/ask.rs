//! End-to-end: create a Claude session, ask one question, stream the answer to stdout.
//!
//! ```sh
//! cargo run -p monica-claude-sdk --example ask -- <cwd> [prompt]
//! ```
//!
//! Defaults to asking 「今日の日付を教えて」. Targets the instance selected by
//! `MONICA_HOME` (unset = prod `~/monica`); the Monica app must be running.

use std::time::Duration;

use anyhow::{bail, Result};
use monica_claude_sdk::{ClaudeRuntime, CreateSessionParams, SessionBusy, SessionEvent};

/// Grace window after Idle for transcript records the drain flushes late (its recheck
/// re-polls for up to 3s after a turn completes).
const LATE_FLUSH_WINDOW: Duration = Duration::from_secs(3);

fn main() {
    if let Err(err) = run() {
        if err.downcast_ref::<SessionBusy>().is_some() {
            eprintln!("ask: the session is busy — a message is already in flight");
        } else {
            eprintln!("ask: {err:#}");
        }
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let (cwd, prompt) = parse_args()?;
    let runtime = ClaudeRuntime::connect()?;
    let mut session = runtime.create_session(CreateSessionParams {
        cwd,
        model: None,
        title: Some("ask".to_string()),
    })?;
    eprintln!("session: {}", session.claude_session_id());

    // The first Idle is the SessionStart hook landing (= Claude finished booting); the
    // subscription reports no earlier snapshot for a launching session.
    eprintln!("waiting for claude to boot...");
    session.wait_until_idle()?;

    eprintln!("asking: {prompt}");
    session.send_user_message(&prompt)?;

    let mut answered = false;
    loop {
        match session.next_event()? {
            SessionEvent::ToolUse { name, .. } => eprintln!("[tool] {name}"),
            SessionEvent::AssistantMessage { text } => {
                println!("{text}");
                answered = true;
            }
            SessionEvent::AwaitingUser { wait_reason } => {
                eprintln!("[awaiting user: {}]", wait_reason.as_deref().unwrap_or("input"));
            }
            SessionEvent::Idle => {
                // The turn is over; give the drain's late transcript flush a moment.
                while let Some(event) = session.next_event_timeout(LATE_FLUSH_WINDOW)? {
                    if let SessionEvent::AssistantMessage { text } = event {
                        println!("{text}");
                        answered = true;
                    }
                }
                if answered {
                    return Ok(());
                }
                eprintln!("(idle without an answer yet — waiting for the next turn)");
            }
            SessionEvent::Ended => bail!("the session ended before answering"),
        }
    }
}

fn parse_args() -> Result<(String, String)> {
    const USAGE: &str = "usage: ask <cwd> [prompt]";
    let mut args = std::env::args().skip(1);
    let Some(cwd) = args.next() else { bail!(USAGE) };
    let prompt = args.next().unwrap_or_else(|| "今日の日付を教えて".to_string());
    if args.next().is_some() {
        bail!(USAGE);
    }
    Ok((cwd, prompt))
}
