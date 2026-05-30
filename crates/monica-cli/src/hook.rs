use std::io::Read;

use anyhow::Result;
use clap::Subcommand;
use monica_core::{record_claude_hook_with_session, Db};

#[derive(Subcommand)]
pub enum HookCommand {
    /// Receive a Claude Code hook callback (event JSON on stdin, `MONICA_*` in env)
    Claude,
}

pub fn run(cmd: HookCommand) -> Result<()> {
    match cmd {
        HookCommand::Claude => claude(),
    }
}

/// A hook must never disrupt the agent session, so this always returns `Ok(())` (exit 0) and routes
/// every diagnostic to stderr. Claude Code feeds some hook stdout back into its own context, so
/// stdout is kept empty on success — there is intentionally no `println!` here.
fn claude() -> Result<()> {
    if let Err(e) = handle_claude() {
        eprintln!("monica hook claude: {e:#}");
    }
    Ok(())
}

fn handle_claude() -> Result<()> {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw)?;

    let task_id = env_opt("MONICA_TASK_ID").or_else(|| env_opt("MONICA_ID"));
    let task_run_id = env_opt("MONICA_TASK_RUN_ID").or_else(|| env_opt("MONICA_RUN_ID"));
    let agent_session_id = env_opt("MONICA_AGENT_SESSION_ID");

    let mut db = Db::open()?;
    let report = record_claude_hook_with_session(
        &mut db,
        task_id.as_deref(),
        task_run_id.as_deref(),
        agent_session_id.as_deref(),
        &raw,
    )?;

    // Surface notable degradations on stderr so a misconfigured launch shows up in the hook debug
    // log without ever reaching Claude's context.
    if let Some(id) = &task_id {
        if !report.task_found {
            eprintln!("monica hook claude: MONICA_ID={id:?} not found; recorded event only");
        }
    }
    if report.unsafe_task_run_id {
        eprintln!(
            "monica hook claude: MONICA_TASK_RUN_ID/MONICA_RUN_ID is not a safe task run id; skipped hook-events.jsonl"
        );
    }
    Ok(())
}

/// Read an env var, treating unset and empty-string the same (an empty `MONICA_*` is "absent").
fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}
