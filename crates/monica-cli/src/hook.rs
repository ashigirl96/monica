use std::borrow::Cow;
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use clap::Subcommand;
use monica_application::{log_field as field, HookContext};
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
        debug_log_to(log.as_ref(), &format!("hook_failed error={}", field(&format!("{e:#}"))));
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

/// An absent value reads as `none`, matching [`HookReport::trace_line`] so the two lines this
/// process writes about one hook spell their ids the same way.
fn opt(value: Option<&str>) -> Cow<'_, str> {
    value.map_or(Cow::Borrowed("none"), field)
}

/// What the hook was launched with, written before anything is resolved — the only record of a
/// hook that turns out to carry no identity at all.
///
/// The values come from the environment and from `current_dir`, so they are arbitrary text: every
/// one goes through the core's [`field`] escaping, or a newline in one would split the record and
/// let the caller forge a second one.
fn invoked_line(
    task_id: Option<&str>,
    task_run_id: Option<&str>,
    tab_id: Option<&str>,
    session_id: Option<&str>,
    monica_home: Option<&str>,
    cwd: Option<&str>,
    stdin_bytes: usize,
) -> String {
    format!(
        "invoked task_id={} task_run_id={} tab_id={} session_id={} monica_home={} cwd={} \
         stdin_bytes={stdin_bytes}",
        opt(task_id),
        opt(task_run_id),
        opt(tab_id),
        opt(session_id),
        opt(monica_home),
        opt(cwd),
    )
}

const PLAN_APPROVAL: &str =
    r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;

/// `auto_approve_plan` is only consulted for an ExitPlanMode permission request, so every other
/// event skips reading settings.json.
fn plan_approval(raw: &str, auto_approve_plan: impl FnOnce() -> bool) -> Option<&'static str> {
    let event: serde_json::Value = serde_json::from_str(raw).ok()?;
    let is_plan_request = event["hook_event_name"] == "PermissionRequest"
        && event["tool_name"] == "ExitPlanMode";
    (is_plan_request && auto_approve_plan()).then_some(PLAN_APPROVAL)
}

fn auto_approve_plan_setting(log: Option<&DailyLog>) -> bool {
    let loaded =
        monica_paths::base_dir().and_then(|base| monica_settings::Settings::load_from(&base));
    match loaded {
        Ok(settings) => settings.claude.auto_approve_plan,
        Err(e) => {
            debug_log_to(
                log,
                &format!("plan_auto_approve_skipped error={}", field(&format!("{e:#}"))),
            );
            false
        }
    }
}

/// claude parses this process's stdout as the hook's JSON reply, so nothing else may be printed.
fn approve_plan(raw: &str, log: Option<&DailyLog>) {
    let Some(reply) = plan_approval(raw, || auto_approve_plan_setting(log)) else {
        return;
    };
    let mut stdout = std::io::stdout().lock();
    match writeln!(stdout, "{reply}").and_then(|()| stdout.flush()) {
        Ok(()) => debug_log_to(log, "plan_auto_approved"),
        Err(e) => debug_log_to(
            log,
            &format!("plan_auto_approve_failed error={}", field(&e.to_string())),
        ),
    }
}

fn handle_agent(agent: Agent, log: Option<&DailyLog>) -> Result<()> {
    let raw = read_stdin()?;
    approve_plan(&raw, log);
    let task_id = env_opt("MONICA_TASK_ID").map(TaskId::from_store);
    let task_run_id = env_opt("MONICA_TASK_RUN_ID").map(TaskRunId::from_store);
    let terminal_tab_id = env_opt("MONICA_TERMINAL_TAB_ID");
    let terminal_session_id = env_opt("MONICA_TERMINAL_SESSION_ID");

    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.display().to_string());
    debug_log_to(
        log,
        &invoked_line(
            task_id.as_deref(),
            task_run_id.as_deref(),
            terminal_tab_id.as_deref(),
            terminal_session_id.as_deref(),
            env_opt("MONICA_HOME").as_deref(),
            cwd.as_deref(),
            raw.len(),
        ),
    );

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

    // `monica hook` installs no logger, so the core's own `log::*` output goes nowhere here. The
    // line the core builds is written to this file instead — same vocabulary, one place to change.
    debug_log_to(log, &report.trace_line());

    if let Some(id) = &task_id {
        if !report.ignored && !report.task_found {
            eprintln!(
                "monica hook {}: MONICA_TASK_ID={} not found; recorded event only",
                agent.as_str(),
                field(id)
            );
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

#[cfg(test)]
mod tests {
    use super::{invoked_line, plan_approval};

    const EXIT_PLAN_REQUEST: &str = r#"{"hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode","tool_input":{"plan":"x"}}"#;

    #[test]
    fn an_exit_plan_request_is_allowed_when_enabled() {
        let reply = plan_approval(EXIT_PLAN_REQUEST, || true).expect("approval");
        let parsed: serde_json::Value = serde_json::from_str(reply).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": { "behavior": "allow" }
                }
            })
        );
    }

    #[test]
    fn an_exit_plan_request_falls_through_to_the_dialog_when_disabled() {
        assert_eq!(plan_approval(EXIT_PLAN_REQUEST, || false), None);
    }

    #[test]
    fn other_requests_are_never_approved_and_never_read_settings() {
        for raw in [
            r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}"#,
            r#"{"hook_event_name":"PreToolUse","tool_name":"ExitPlanMode","tool_input":{"plan":"x"}}"#,
            r#"{"hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode""#,
            "",
        ] {
            assert_eq!(plan_approval(raw, || panic!("settings read for {raw}")), None, "{raw}");
        }
    }

    #[test]
    fn every_id_reads_back_verbatim() {
        assert_eq!(
            invoked_line(
                Some("MON-42"),
                Some("run-688"),
                Some("tab-1"),
                Some("ts-1865"),
                Some("/Users/x/monica"),
                Some("/Users/x/repo"),
                1149,
            ),
            "invoked task_id=MON-42 task_run_id=run-688 tab_id=tab-1 session_id=ts-1865 \
             monica_home=/Users/x/monica cwd=/Users/x/repo stdin_bytes=1149"
        );
    }

    /// The whole reason this line exists: `rg 'task_run_id=run-688'` has to reach it, so no value
    /// may arrive wrapped in `Some(..)` or quoted.
    #[test]
    fn an_absent_id_reads_none_rather_than_a_debug_wrapper() {
        let line = invoked_line(None, Some("run-688"), None, Some("ts-1"), None, None, 0);
        assert_eq!(
            line,
            "invoked task_id=none task_run_id=run-688 tab_id=none session_id=ts-1 \
             monica_home=none cwd=none stdin_bytes=0"
        );
        assert!(!line.contains("Some("), "{line}");
    }

    #[test]
    fn a_newline_in_the_environment_cannot_forge_a_second_record() {
        let line = invoked_line(
            Some("MON-1\ninvoked task_id=MON-99"),
            None,
            None,
            None,
            None,
            Some("/a path/with spaces"),
            0,
        );
        assert!(!line.contains('\n'), "{line}");
        assert!(line.starts_with("invoked task_id=MON-1_invoked_task_id=MON-99 "), "{line}");
        assert!(line.contains("cwd=/a_path/with_spaces "), "{line}");
    }
}
