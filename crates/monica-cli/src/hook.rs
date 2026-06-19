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
    /// Receive a Codex CLI hook callback (event JSON on stdin, `MONICA_*` in env)
    Codex,
}

pub fn run(cmd: HookCommand) -> Result<()> {
    match cmd {
        HookCommand::Claude => agent_hook(handle_claude, "hook-claude.log"),
        HookCommand::Codex => agent_hook(handle_codex, "hook-codex.log"),
    }
}

fn agent_hook(handler: fn() -> Result<()>, log_file: &str) -> Result<()> {
    if let Err(e) = handler() {
        let label = log_file.trim_end_matches(".log");
        eprintln!("monica {label}: {e:#}");
        debug_log_to(log_file, &format!("error: {e:#}"));
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

fn hook_context() -> (Option<String>, Option<String>, Option<String>) {
    (
        env_opt("MONICA_TASK_ID"),
        env_opt("MONICA_TASK_RUN_ID"),
        env_opt("MONICA_TERMINAL_TAB_ID"),
    )
}

fn log_invocation(log_file: &str, task_id: &Option<String>, task_run_id: &Option<String>, terminal_tab_id: &Option<String>, raw: &str) {
    debug_log_to(log_file, &format!(
        "invoked task_id={task_id:?} task_run_id={task_run_id:?} tab_id={terminal_tab_id:?} monica_home={:?} cwd={:?} stdin_bytes={}",
        env_opt("MONICA_HOME"),
        std::env::current_dir().ok(),
        raw.len(),
    ));
}

fn log_report(log_file: &str, report: &monica_core::HookReport) {
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
}

fn maybe_notify(report: &monica_core::HookReport) {
    if report.entered_waiting_for_user {
        notify::post(&notify::waiting_notification(
            report.task_run_wait_reason,
            report.task_title.as_deref(),
        ));
    }
}

fn warn_degradations(label: &str, task_id: &Option<String>, report: &monica_core::HookReport) {
    if let Some(id) = task_id {
        if !report.ignored && !report.task_found {
            eprintln!("monica {label}: MONICA_TASK_ID={id:?} not found; recorded event only");
        }
    }
    if report.unsafe_task_run_id {
        eprintln!(
            "monica {label}: MONICA_TASK_RUN_ID is not a safe task run id; skipped hook-events.jsonl"
        );
    }
}

fn handle_claude() -> Result<()> {
    let raw = read_stdin()?;
    let (task_id, task_run_id, terminal_tab_id) = hook_context();

    log_invocation("hook-claude.log", &task_id, &task_run_id, &terminal_tab_id, &raw);

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

    log_report("hook-claude.log", &report);
    maybe_notify(&report);
    warn_degradations("hook claude", &task_id, &report);
    Ok(())
}

fn handle_codex() -> Result<()> {
    let raw = read_stdin()?;
    let (task_id, task_run_id, terminal_tab_id) = hook_context();

    log_invocation("hook-codex.log", &task_id, &task_run_id, &terminal_tab_id, &raw);

    if task_id.is_none() && task_run_id.is_none() {
        return Ok(());
    }

    let mut runtime = Runtime::open_default()?;
    let report = monica_core::record_codex_hook(
        &mut runtime.repositories,
        &runtime.task_run_outputs,
        monica_core::HookContext {
            task_id: task_id.as_deref(),
            task_run_id: task_run_id.as_deref(),
            terminal_tab_id: terminal_tab_id.as_deref(),
        },
        &raw,
    )?;

    log_report("hook-codex.log", &report);
    maybe_notify(&report);
    warn_degradations("hook codex", &task_id, &report);
    Ok(())
}
