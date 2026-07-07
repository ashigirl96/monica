//! Create a new Claude Code session in the Workbench's "sdk" runspace:
//!
//! ```sh
//! cargo run -p monica-claude-sdk --example open_session -- --cwd <path> [--model <m>] [--title <t>]
//! ```
//!
//! Targets the instance selected by `MONICA_HOME` (unset = prod `~/monica`); the Monica
//! app must be running.

use anyhow::{bail, Result};
use monica_claude_sdk::{open_session, OpenSessionParams};

fn main() {
    if let Err(err) = run() {
        eprintln!("open_session: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let params = parse_args()?;
    let session = open_session(params)?;
    println!("claude_session_id: {}", session.claude_session_id);
    println!("session_id:        {}", session.session_id);
    println!("tab_id:            {}", session.tab_id);
    println!("runspace_id:       {}", session.runspace_id);
    println!("initial_command:   {}", session.initial_command);
    Ok(())
}

fn parse_args() -> Result<OpenSessionParams> {
    const USAGE: &str = "usage: open_session --cwd <path> [--model <model>] [--title <title>]";
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut cwd = None;
    let mut model = None;
    let mut title = None;
    let mut iter = args.iter();
    while let Some(flag) = iter.next() {
        let value = iter.next();
        match (flag.as_str(), value) {
            ("--cwd", Some(v)) => cwd = Some(v.clone()),
            ("--model", Some(v)) => model = Some(v.clone()),
            ("--title", Some(v)) => title = Some(v.clone()),
            _ => bail!(USAGE),
        }
    }
    let Some(cwd) = cwd else { bail!(USAGE) };
    Ok(OpenSessionParams { cwd, model, title })
}
