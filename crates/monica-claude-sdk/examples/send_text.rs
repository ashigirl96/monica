//! Send a prompt to an existing Claude Code tab:
//!
//! ```sh
//! cargo run -p monica-claude-sdk --example send_text -- --tab <tab-id> "<text>"
//! ```
//!
//! Targets the instance selected by `MONICA_HOME` (unset = prod `~/monica`).

use anyhow::{bail, Result};
use monica_claude_sdk::{connect_ptyd, ensure_session_running, resolve_tab_session, send_text};
use monica_storage_sqlite::SqliteStore;

fn main() {
    if let Err(err) = run() {
        eprintln!("send_text: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let (tab_id, text) = parse_args()?;

    let store = SqliteStore::open()?;
    let session = resolve_tab_session(&store, &tab_id)?;
    println!(
        "tab {tab_id} -> session {} (status: {}, pid: {:?})",
        session.id,
        session.status.as_str(),
        session.pid
    );

    let client = connect_ptyd()?;
    ensure_session_running(&client, &session.id)?;
    send_text(&client, &session.id, &text)?;
    println!("pasted {} bytes + Enter into {}", text.len(), session.id);
    Ok(())
}

fn parse_args() -> Result<(String, String)> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag, tab_id, text] if flag == "--tab" => Ok((tab_id.clone(), text.clone())),
        _ => bail!("usage: send_text --tab <tab-id> \"<text>\""),
    }
}
