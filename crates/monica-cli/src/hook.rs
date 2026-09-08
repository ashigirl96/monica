use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use clap::Subcommand;
use monica_application::HookContext;
use monica_domain::{Agent, TaskId, TaskRunId};
use monica_logfile::DailyLog;

#[derive(Subcommand)]
pub enum HookCommand {
    /// Receive a Claude Code hook callback (event JSON on stdin, `MONICA_*` in env)
    Claude,
}

pub fn run(cmd: HookCommand) -> Result<()> {
    let agent = match cmd {
        HookCommand::Claude => Agent::Claude,
    };
    let log = open_debug_log(agent);
    if let Err(e) = handle_agent(agent, log.as_ref()) {
        eprintln!("monica hook {}: {e:#}", agent.as_str());
        debug_log_to(log.as_ref(), &format!("error: {e:#}"));
    }
    Ok(())
}

/// `None` when the logs dir cannot be resolved or opened, which keeps every later `debug_log_to`
/// a silent no-op — a hook must still ingest its event when the debug log is unavailable.
fn open_debug_log(agent: Agent) -> Option<DailyLog> {
    let dir = monica_paths::logs_dir().ok()?;
    DailyLog::open(&dir, &format!("hook-{}", agent.as_str())).ok()
}

fn debug_log_to(log: Option<&DailyLog>, msg: &str) {
    let Some(log) = log else {
        return;
    };
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    log.append(&format!("{ms} pid={} {msg}", std::process::id()));
}

fn read_stdin() -> Result<String> {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw)?;
    Ok(raw)
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn handle_agent(agent: Agent, log: Option<&DailyLog>) -> Result<()> {
    let raw = read_stdin()?;
    let task_id = env_opt("MONICA_TASK_ID").map(TaskId::from_store);
    let task_run_id = env_opt("MONICA_TASK_RUN_ID").map(TaskRunId::from_store);
    let terminal_tab_id = env_opt("MONICA_TERMINAL_TAB_ID");
    let terminal_session_id = env_opt("MONICA_TERMINAL_SESSION_ID");

    debug_log_to(log, &format!(
        "invoked task_id={task_id:?} task_run_id={task_run_id:?} tab_id={terminal_tab_id:?} session_id={terminal_session_id:?} monica_home={:?} cwd={:?} stdin_bytes={}",
        env_opt("MONICA_HOME"),
        std::env::current_dir().ok(),
        raw.len(),
    ));

    if task_id.is_none() && task_run_id.is_none() && terminal_session_id.is_none() {
        return Ok(());
    }

    let mut monica = crate::event_sink::open()?;
    let report = monica.executions().ingest_agent_hook(
        agent,
        HookContext {
            task_id: task_id.as_ref(),
            task_run_id: task_run_id.as_ref(),
            terminal_tab_id: terminal_tab_id.as_deref(),
            terminal_session_id: terminal_session_id.as_deref(),
        },
        &raw,
    )?;

    let event_name = report.event_name.clone();
    debug_log_to(log, &format!(
        "event={:?} ignored={} task_found={} run_linked={} run_created={} status={:?} wait_reason={:?} entered_waiting={}",
        event_name,
        report.ignored,
        report.task_found,
        report.task_run_linked,
        report.task_run_created,
        report.task_run_status,
        report.wait_reason,
        report.entered_waiting_for_user,
    ));

    if let Some(id) = &task_id {
        if !report.ignored && !report.task_found {
            eprintln!("monica hook {}: MONICA_TASK_ID={id:?} not found; recorded event only", agent.as_str());
        }
    }
    if report.unsafe_task_run_id {
        eprintln!(
            "monica hook {}: MONICA_TASK_RUN_ID is not a safe task run id; ignored",
            agent.as_str()
        );
    }
    Ok(())
}
