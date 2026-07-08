//! Send a prompt to an existing Claude Code tab (opened via agent-runtime):
//!
//! ```sh
//! cargo run -p monica-claude-sdk --example send_text -- --tab <tab-id> "<text>"
//! ```
//!
//! Targets the instance selected by `MONICA_HOME` (unset = prod `~/monica`).
//! Only tabs opened through the agent-runtime control socket are visible;
//! plain shell tabs created from the UI are not reachable via this path.

use anyhow::{Context, Result};
use monica_claude_sdk::{connect_ptyd, ensure_session_running, send_text, ClaudeRuntime};

fn main() {
    if let Err(err) = run() {
        eprintln!("send_text: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let (tab_id, text) = parse_args()?;

    let runtime = ClaudeRuntime::connect()?;
    let summary = runtime
        .list_sessions()?
        .into_iter()
        .find(|s| s.tab_id == tab_id)
        .with_context(|| format!("tab {tab_id} has no claude session"))?;
    println!(
        "tab {tab_id} -> session {} (status: {})",
        summary.terminal_session_id, summary.session_status,
    );

    let client = connect_ptyd()?;
    ensure_session_running(&client, &summary.terminal_session_id)?;
    send_text(&client, &summary.terminal_session_id, &text)?;
    println!(
        "pasted {} bytes + Enter into {}",
        text.len(),
        summary.terminal_session_id
    );
    Ok(())
}

fn parse_args() -> Result<(String, String)> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag, tab_id, text] if flag == "--tab" => Ok((tab_id.clone(), text.clone())),
        _ => anyhow::bail!("usage: send_text --tab <tab-id> \"<text>\""),
    }
}
