use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use clap::Subcommand;
use monica_infra::Runtime;

use crate::notify;

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
        debug_log(&format!("error: {e:#}"));
    }
    Ok(())
}

/// Append a diagnostic line to `<base>/logs/hook-claude.log`. Hooks run as silent children of
/// Claude (stderr is invisible, exit is always 0), so this file is the only way to see whether a
/// hook fired and what it decided. Never fails: logging must not disrupt the hook.
fn debug_log(msg: &str) {
    let Ok(dir) = monica_infra::filesystem::paths::logs_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("{ms} pid={} {msg}\n", std::process::id());
    let _ = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("hook-claude.log"))
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

fn handle_claude() -> Result<()> {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw)?;

    let task_id = env_opt("MONICA_TASK_ID");
    let task_run_id = env_opt("MONICA_TASK_RUN_ID");
    let terminal_tab_id = env_opt("MONICA_TERMINAL_TAB_ID");

    debug_log(&format!(
        "invoked task_id={task_id:?} task_run_id={task_run_id:?} tab_id={terminal_tab_id:?} monica_home={:?} cwd={:?} stdin_bytes={}",
        env_opt("MONICA_HOME"),
        std::env::current_dir().ok(),
        raw.len(),
    ));

    // Hooks live in the cwd's .claude/settings.local.json, so a plain `claude` started outside a
    // Monica task (no task identity in the env) still fires this. Such an event resolves to no run,
    // so bail before touching the DB instead of doing pointless work for unrelated sessions.
    if task_id.is_none() && task_run_id.is_none() {
        return Ok(());
    }

    let mut runtime = Runtime::open_default()?;
    let report = monica_core::record_claude_hook(
        &mut runtime.repositories,
        &runtime.task_run_outputs,
        monica_core::HookContext {
            task_id: task_id.as_deref(),
            task_run_id: task_run_id.as_deref(),
            terminal_tab_id: terminal_tab_id.as_deref(),
        },
        &raw,
    )?;

    debug_log(&format!(
        "event={:?} ignored={} task_found={} run_linked={} run_created={} status={:?} wait_reason={:?} entered_waiting={} jsonl={}",
        report.event_name,
        report.ignored,
        report.task_found,
        report.task_run_linked,
        report.task_run_created,
        report.task_run_status,
        report.task_run_wait_reason,
        report.entered_waiting_for_user,
        report.jsonl_written,
    ));

    // A hook fires exactly when the run enters WaitingForUser, regardless of whether the window is
    // foregrounded — the one moment frontend polling (gated on document.hidden) goes blind. Only
    // the entering edge notifies; a later event re-affirming an already-waiting run does not.
    // Best-effort throughout: a failed lookup or notification must never disrupt the session.
    if report.entered_waiting_for_user {
        notify::post(&notify::waiting_notification(
            report.task_run_wait_reason,
            report.task_title.as_deref(),
        ));
    }

    // Surface notable degradations on stderr so a misconfigured launch shows up in the hook debug
    // log without ever reaching Claude's context.
    if let Some(id) = &task_id {
        if !report.ignored && !report.task_found {
            eprintln!("monica hook claude: MONICA_TASK_ID={id:?} not found; recorded event only");
        }
    }
    if report.unsafe_task_run_id {
        eprintln!(
            "monica hook claude: MONICA_TASK_RUN_ID is not a safe task run id; skipped hook-events.jsonl"
        );
    }
    Ok(())
}

/// Read an env var, treating unset and empty-string the same (an empty `MONICA_*` is "absent").
fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}
