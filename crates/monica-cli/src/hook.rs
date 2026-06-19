use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use clap::Subcommand;
use monica_core::Agent;
use monica_infra::Runtime;

use crate::notify;

#[derive(Subcommand)]
pub enum HookCommand {
    /// Receive a Claude Code hook callback (event JSON on stdin, `MONICA_*` in env)
    Claude,
    /// Receive a Codex CLI hook callback (event JSON on stdin, `MONICA_*` in env)
    Codex,
}

pub fn run(cmd: HookCommand) -> Result<()> {
    let agent = match cmd {
        HookCommand::Claude => Agent::Claude,
        HookCommand::Codex => Agent::Codex,
    };
    let log_file = format!("hook-{}.log", agent.as_str());
    if let Err(e) = handle_agent(agent, &log_file) {
        eprintln!("monica hook {}: {e:#}", agent.as_str());
        debug_log_to(&log_file, &format!("error: {e:#}"));
    }
    Ok(())
}

fn debug_log_to(log_file: &str, msg: &str) {
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
        .open(dir.join(log_file))
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

fn read_stdin() -> Result<String> {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw)?;
    Ok(raw)
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn handle_agent(agent: Agent, log_file: &str) -> Result<()> {
    let raw = read_stdin()?;
    let task_id = env_opt("MONICA_TASK_ID");
    let task_run_id = env_opt("MONICA_TASK_RUN_ID");
    let terminal_tab_id = env_opt("MONICA_TERMINAL_TAB_ID");

    debug_log_to(log_file, &format!(
        "invoked task_id={task_id:?} task_run_id={task_run_id:?} tab_id={terminal_tab_id:?} monica_home={:?} cwd={:?} stdin_bytes={}",
        env_opt("MONICA_HOME"),
        std::env::current_dir().ok(),
        raw.len(),
    ));

    if task_id.is_none() && task_run_id.is_none() {
        return Ok(());
    }

    let mut runtime = Runtime::open_default()?;
    let record = match agent {
        Agent::Claude => monica_core::record_claude_hook,
        Agent::Codex => monica_core::record_codex_hook,
    };
    let report = record(
        &mut runtime.repositories,
        &runtime.task_run_outputs,
        monica_core::HookContext {
            task_id: task_id.as_deref(),
            task_run_id: task_run_id.as_deref(),
            terminal_tab_id: terminal_tab_id.as_deref(),
        },
        &raw,
    )?;

    debug_log_to(log_file, &format!(
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

    if report.entered_waiting_for_user {
        notify::post(&notify::waiting_notification(
            report.task_run_wait_reason,
            report.task_title.as_deref(),
        ));
    }

    if let Some(id) = &task_id {
        if !report.ignored && !report.task_found {
            eprintln!("monica hook {}: MONICA_TASK_ID={id:?} not found; recorded event only", agent.as_str());
        }
    }
    if report.unsafe_task_run_id {
        eprintln!(
            "monica hook {}: MONICA_TASK_RUN_ID is not a safe task run id; skipped hook-events.jsonl",
            agent.as_str()
        );
    }
    Ok(())
}
