use std::fs::{self, OpenOptions};
use std::io::Write;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::{paths, Db, TaskRunObservation, TaskRunStatus, TaskRunWaitReason};

const HOOK_EVENTS_FILE: &str = "hook-events.jsonl";

/// Map a Claude Code hook event name to the task-run status it implies:
/// `SessionStart`/`UserPromptSubmit` -> running, `Stop` -> stopped, `StopFailure` -> failed,
/// `SessionEnd` -> stopped. Events Monica does not act on return `None` (they are still recorded,
/// never an error, except non-waiting `PreToolUse` events which are intentionally ignored).
pub fn status_for_claude_event(event_name: &str) -> Option<TaskRunStatus> {
    match event_name {
        "SessionStart" => Some(TaskRunStatus::Running),
        "UserPromptSubmit" => Some(TaskRunStatus::Running),
        "Stop" => Some(TaskRunStatus::Stopped),
        "StopFailure" => Some(TaskRunStatus::Failed),
        "SessionEnd" => Some(TaskRunStatus::Stopped),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HookTransition {
    status: TaskRunStatus,
    wait_reason: Option<TaskRunWaitReason>,
}

fn wait_reason_for_tool(tool_name: &str) -> Option<TaskRunWaitReason> {
    match tool_name {
        "AskUserQuestion" => Some(TaskRunWaitReason::AskUserQuestion),
        "ExitPlanMode" => Some(TaskRunWaitReason::ExitPlanMode),
        _ => None,
    }
}

fn transition_for_claude_event(
    event_name: &str,
    payload: Option<&Value>,
) -> Option<HookTransition> {
    if event_name == "PreToolUse" {
        let wait_reason = payload
            .and_then(|value| value.get("tool_name"))
            .and_then(Value::as_str)
            .and_then(wait_reason_for_tool)?;
        return Some(HookTransition {
            status: TaskRunStatus::WaitingForUser,
            wait_reason: Some(wait_reason),
        });
    }

    status_for_claude_event(event_name).map(|status| HookTransition {
        status,
        wait_reason: None,
    })
}

fn transition_is_protected(current: TaskRunStatus, next: TaskRunStatus) -> bool {
    matches!(current, TaskRunStatus::Failed)
        || (matches!(current, TaskRunStatus::WaitingForUser)
            && matches!(next, TaskRunStatus::Stopped))
}

/// Whether `task_run_id` is safe to use as a path component under `runs/`. Task run ids are minted as
/// `run-<n>`; anything outside `[A-Za-z0-9_.-]`, or `.`/`..`, is rejected so a hostile env var
/// (e.g. `../../etc`) cannot escape the runs directory via [`paths::task_run_dir`]'s plain join.
pub fn is_safe_task_run_id(task_run_id: &str) -> bool {
    !task_run_id.is_empty()
        && task_run_id != "."
        && task_run_id != ".."
        && !task_run_id.starts_with('-')
        && task_run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// What [`record_claude_hook`] did, for the caller to log. Never written to the hook's stdout:
/// Claude Code feeds a `SessionStart` hook's stdout back into its own context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookReport {
    pub event_name: Option<String>,
    pub task_run_status: Option<TaskRunStatus>,
    pub task_run_wait_reason: Option<TaskRunWaitReason>,
    pub ignored: bool,
    pub task_found: bool,
    pub task_run_linked: bool,
    pub event_recorded: bool,
    pub jsonl_written: bool,
    pub unsafe_task_run_id: bool,
}

/// Receive a Claude Code hook callback: parse the stdin JSON, append it to the run's
/// `hook-events.jsonl`, record an `events` row, and move the task run to the status
/// the event implies. Tolerant by contract: invalid JSON and unknown events are recorded without
/// erroring, so the caller can always exit 0 and never disrupt the Claude session.
///
/// `task_id` and `task_run_id` come from `MONICA_*` env vars and are treated as untrusted input:
/// - `task_run_id` becomes a path component only when [`is_safe_task_run_id`]; an id that resolves
///   to a task run is the source of truth for the owning task.
/// - `failed` and `waiting_for_user` are protected from later `Stop`/`SessionEnd` downgrades.
pub fn record_claude_hook(
    db: &mut Db,
    task_id: Option<&str>,
    task_run_id: Option<&str>,
    raw_stdin: &str,
) -> Result<HookReport> {
    let parsed: Option<Value> = serde_json::from_str(raw_stdin.trim()).ok();
    let event_name = parsed
        .as_ref()
        .and_then(|v| v.get("hook_event_name"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let safe_task_run_id = task_run_id.filter(|&r| is_safe_task_run_id(r));
    let unsafe_task_run_id = task_run_id.is_some() && safe_task_run_id.is_none();

    if should_ignore_claude_event(event_name.as_deref(), parsed.as_ref()) {
        return Ok(HookReport {
            event_name,
            task_run_status: None,
            task_run_wait_reason: None,
            ignored: true,
            task_found: false,
            task_run_linked: false,
            event_recorded: false,
            jsonl_written: false,
            unsafe_task_run_id,
        });
    }

    let run_row = match safe_task_run_id {
        Some(r) => db.get_task_run(r)?,
        None => None,
    };
    let task_run_linked = run_row.is_some();
    let linked_task_run_id = if task_run_linked {
        safe_task_run_id
    } else {
        None
    };
    let linked_task_id = run_row.as_ref().map(|run| run.task_id.as_str()).or(task_id);
    let task_found = match linked_task_id {
        Some(id) if run_row.is_some() => db.get_task(id)?.is_some() || run_row.is_some(),
        Some(id) => db.get_task(id)?.is_some(),
        None => false,
    };

    let mut jsonl_written = false;
    if let Some(task_run_id) = linked_task_run_id {
        append_jsonl(db, task_run_id, event_name.as_deref(), &parsed, raw_stdin)?;
        jsonl_written = true;
    }

    let event_recorded = if task_found || task_run_linked {
        let payload = parsed
            .clone()
            .unwrap_or_else(|| json!({ "raw": raw_stdin }));
        db.insert_event(
            linked_task_id.filter(|_| task_found || task_run_linked),
            linked_task_run_id,
            "claude_hook",
            &payload,
        )?;
        true
    } else {
        false
    };

    let transition = event_name
        .as_deref()
        .and_then(|event| transition_for_claude_event(event, parsed.as_ref()));
    let transition = match (transition, run_row.as_ref()) {
        (Some(transition), Some(run))
            if !transition_is_protected(run.status, transition.status) =>
        {
            Some(transition)
        }
        _ => None,
    };

    let at = db.now_iso()?;
    let provider_session_id = parsed
        .as_ref()
        .and_then(|value| value.get("session_id"))
        .and_then(Value::as_str);
    if let Some(task_run_id) = linked_task_run_id {
        let wait_update = transition.map(|t| {
            if t.status == TaskRunStatus::WaitingForUser {
                t.wait_reason
            } else {
                None
            }
        });
        db.record_task_run_observation(
            task_run_id,
            TaskRunObservation {
                status: transition.map(|t| t.status),
                wait_reason: wait_update,
                event_name: event_name.as_deref(),
                at: &at,
                provider_session_id,
                metadata: parsed.as_ref(),
            },
        )?;
    }

    Ok(HookReport {
        event_name,
        task_run_status: transition.map(|t| t.status),
        task_run_wait_reason: transition.and_then(|t| t.wait_reason),
        ignored: false,
        task_found,
        task_run_linked,
        event_recorded,
        jsonl_written,
        unsafe_task_run_id,
    })
}

fn should_ignore_claude_event(event_name: Option<&str>, payload: Option<&Value>) -> bool {
    event_name == Some("PreToolUse")
        && payload
            .and_then(|value| value.get("tool_name"))
            .and_then(Value::as_str)
            .and_then(wait_reason_for_tool)
            .is_none()
}

/// Append one self-describing line `{at, hook_event_name, payload}` to the run's hook-event log.
/// `payload` is the parsed JSON, or `{"raw": <stdin>}` when the input was not valid JSON.
fn append_jsonl(
    db: &Db,
    task_run_id: &str,
    event_name: Option<&str>,
    parsed: &Option<Value>,
    raw_stdin: &str,
) -> Result<()> {
    let dir = paths::task_run_dir(task_run_id)?;
    fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let path = dir.join(HOOK_EVENTS_FILE);

    let payload = parsed
        .clone()
        .unwrap_or_else(|| json!({ "raw": raw_stdin }));
    let mut line = serde_json::to_string(&json!({
        "at": db.now_iso()?,
        "hook_event_name": event_name,
        "payload": payload,
    }))?;
    line.push('\n');

    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .with_context(|| format!("failed to append to {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NewTask, NewTaskRun, TaskKind, TaskStatus};
    use serde_json::json;
    use std::path::PathBuf;

    fn dev_task(db: &mut Db, status: TaskStatus) -> String {
        let mut task = NewTask::new(TaskKind::Development, "hooked");
        task.status = status;
        db.insert_task(task).unwrap().id
    }

    fn new_task_run(task_id: &str) -> NewTaskRun {
        NewTaskRun {
            task_id: task_id.to_string(),
            agent: None,
            branch: None,
            worktree_path: None,
        }
    }

    fn temp_home(tag: &str) -> (std::sync::MutexGuard<'static, ()>, PathBuf) {
        let guard = crate::paths::test_env_guard();
        let dir = std::env::temp_dir().join(format!(
            "monica-hook-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("MONICA_HOME", &dir);
        (guard, dir)
    }

    #[test]
    fn status_mapping_covers_lifecycle_events() {
        assert_eq!(
            status_for_claude_event("SessionStart"),
            Some(TaskRunStatus::Running)
        );
        assert_eq!(
            status_for_claude_event("UserPromptSubmit"),
            Some(TaskRunStatus::Running)
        );
        assert_eq!(
            status_for_claude_event("Stop"),
            Some(TaskRunStatus::Stopped)
        );
        assert_eq!(
            status_for_claude_event("StopFailure"),
            Some(TaskRunStatus::Failed)
        );
        assert_eq!(
            status_for_claude_event("SessionEnd"),
            Some(TaskRunStatus::Stopped)
        );
        assert_eq!(status_for_claude_event("PreToolUse"), None);
    }

    #[test]
    fn pre_tool_use_wait_reasons_are_detected_from_tool_name() {
        assert_eq!(
            transition_for_claude_event(
                "PreToolUse",
                Some(&json!({"tool_name": "AskUserQuestion"}))
            ),
            Some(HookTransition {
                status: TaskRunStatus::WaitingForUser,
                wait_reason: Some(TaskRunWaitReason::AskUserQuestion),
            })
        );
        assert_eq!(
            transition_for_claude_event("PreToolUse", Some(&json!({"tool_name": "ExitPlanMode"})))
                .unwrap()
                .wait_reason,
            Some(TaskRunWaitReason::ExitPlanMode)
        );
        assert!(
            transition_for_claude_event("PreToolUse", Some(&json!({"tool_name": "Read"})))
                .is_none()
        );
    }

    #[test]
    fn safe_task_run_id_accepts_run_ids_and_rejects_traversal() {
        assert!(is_safe_task_run_id("run-1"));
        assert!(is_safe_task_run_id("RUN.1-2_3"));
        assert!(!is_safe_task_run_id(""));
        assert!(!is_safe_task_run_id("."));
        assert!(!is_safe_task_run_id(".."));
        assert!(!is_safe_task_run_id("../x"));
        assert!(!is_safe_task_run_id("a/b"));
        assert!(!is_safe_task_run_id("-rf"));
    }

    #[test]
    fn session_start_updates_linked_task_run_and_provider_fields() {
        let (_g, _home) = temp_home("start");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Ready);
        let run = db.start_task_run(new_task_run(&id)).unwrap();

        let report = record_claude_hook(
            &mut db,
            None,
            Some(&run.id),
            r#"{"hook_event_name":"SessionStart","session_id":"provider-1"}"#,
        )
        .unwrap();

        assert_eq!(report.task_run_status, Some(TaskRunStatus::Running));
        assert!(report.task_run_linked);
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        let updated = db.get_task_run(&run.id).unwrap().unwrap();
        assert_eq!(updated.status, TaskRunStatus::Running);
        assert_eq!(updated.wait_reason, None);
        assert_eq!(updated.provider_session_id.as_deref(), Some("provider-1"));
        assert_eq!(updated.last_event_name.as_deref(), Some("SessionStart"));
        assert_eq!(updated.metadata["hook_event_name"], json!("SessionStart"));
        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(
            events.last().unwrap().task_run_id.as_deref(),
            Some(run.id.as_str())
        );
    }

    #[test]
    fn unknown_task_run_does_not_write_jsonl_or_link_event() {
        let (_g, _home) = temp_home("unknown-run");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::InProgress);

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some("run_x"),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert_eq!(report.task_run_status, None);
        assert!(report.event_recorded);
        assert!(!report.jsonl_written);
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(events[0].task_run_id, None);
    }

    #[test]
    fn waiting_for_user_is_not_downgraded_by_stop() {
        let (_g, _home) = temp_home("wait-stop");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Ready);
        let run = db.start_task_run(new_task_run(&id)).unwrap();
        record_claude_hook(
            &mut db,
            Some(&id),
            Some(&run.id),
            r#"{"hook_event_name":"PreToolUse","tool_name":"ExitPlanMode"}"#,
        )
        .unwrap();
        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some(&run.id),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert_eq!(report.task_run_status, None);
        let updated = db.get_task_run(&run.id).unwrap().unwrap();
        assert_eq!(updated.status, TaskRunStatus::WaitingForUser);
        assert_eq!(updated.wait_reason, Some(TaskRunWaitReason::ExitPlanMode));
    }

    #[test]
    fn user_prompt_submit_resumes_waiting_run_and_clears_reason() {
        let (_g, _home) = temp_home("wait-resume");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Ready);
        let run = db.start_task_run(new_task_run(&id)).unwrap();
        record_claude_hook(
            &mut db,
            Some(&id),
            Some(&run.id),
            r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}"#,
        )
        .unwrap();
        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some(&run.id),
            r#"{"hook_event_name":"UserPromptSubmit"}"#,
        )
        .unwrap();

        assert_eq!(report.task_run_status, Some(TaskRunStatus::Running));
        let updated = db.get_task_run(&run.id).unwrap().unwrap();
        assert_eq!(updated.status, TaskRunStatus::Running);
        assert_eq!(updated.wait_reason, None);
    }

    #[test]
    fn failed_task_run_is_not_downgraded_by_session_end() {
        let (_g, _home) = temp_home("failed-run");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Ready);
        let run = db.start_task_run(new_task_run(&id)).unwrap();
        db.finish_task_run(&run.id, &id, TaskRunStatus::Failed)
            .unwrap();

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some(&run.id),
            r#"{"hook_event_name":"SessionEnd"}"#,
        )
        .unwrap();

        assert_eq!(report.task_run_status, None);
        assert_eq!(
            db.get_task_run(&run.id).unwrap().unwrap().status,
            TaskRunStatus::Failed
        );
    }

    #[test]
    fn unsafe_task_run_id_skips_jsonl_and_status_update() {
        let (_g, home) = temp_home("unsafe");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::InProgress);

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some("../evil"),
            r#"{"hook_event_name":"StopFailure"}"#,
        )
        .unwrap();

        assert!(report.unsafe_task_run_id);
        assert!(!report.jsonl_written);
        assert_eq!(report.task_run_status, None);
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert!(!home.join("evil").exists());
    }

    #[test]
    fn invalid_json_records_raw_event_without_status_change() {
        let (_g, _home) = temp_home("badjson");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::InProgress);
        let run = db.start_task_run(new_task_run(&id)).unwrap();

        let report =
            record_claude_hook(&mut db, Some(&id), Some(&run.id), "not json at all").unwrap();

        assert_eq!(report.event_name, None);
        assert_eq!(report.task_run_status, None);
        assert!(report.event_recorded);
        assert!(report.jsonl_written);
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(events[0].payload["raw"], json!("not json at all"));
    }

    #[test]
    fn non_waiting_pre_tool_use_is_ignored_without_db_noise() {
        let (_g, home) = temp_home("ignored-pretool");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::InProgress);
        let run = db.start_task_run(new_task_run(&id)).unwrap();

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some(&run.id),
            r#"{"hook_event_name":"PreToolUse","tool_name":"Read"}"#,
        )
        .unwrap();

        assert_eq!(report.event_name.as_deref(), Some("PreToolUse"));
        assert!(report.ignored);
        assert_eq!(report.task_run_status, None);
        assert!(!report.event_recorded);
        assert!(!report.jsonl_written);
        assert!(db.list_events(Some(&id)).unwrap().is_empty());
        assert!(
            !home
                .join("runs")
                .join(&run.id)
                .join("hook-events.jsonl")
                .exists(),
            "ignored PreToolUse should not create hook artifacts"
        );
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert_eq!(
            db.get_task_run(&run.id).unwrap().unwrap().last_event_name,
            None
        );
    }

    #[test]
    fn task_run_id_is_source_of_truth_when_task_id_mismatches() {
        let (_g, _home) = temp_home("source-truth");
        let mut db = Db::open_in_memory().unwrap();
        let a = dev_task(&mut db, TaskStatus::Ready);
        let run_a = db.start_task_run(new_task_run(&a)).unwrap();
        let b = dev_task(&mut db, TaskStatus::Ready);

        let report = record_claude_hook(
            &mut db,
            Some(&b),
            Some(&run_a.id),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert!(report.task_run_linked);
        assert_eq!(report.task_run_status, Some(TaskRunStatus::Stopped));
        assert_eq!(db.get_task(&b).unwrap().unwrap().status, TaskStatus::Ready);
        assert_eq!(
            db.get_task(&a).unwrap().unwrap().status,
            TaskStatus::InProgress
        );
        assert_eq!(
            db.get_task_run(&run_a.id).unwrap().unwrap().status,
            TaskRunStatus::Stopped
        );
        assert!(report.jsonl_written);
    }
}
