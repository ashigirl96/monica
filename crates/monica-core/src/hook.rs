use std::fs::{self, OpenOptions};
use std::io::Write;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::{paths, AgentSessionStatus, Db, TaskRunStatus, TaskStatus};

const HOOK_EVENTS_FILE: &str = "hook-events.jsonl";

/// Map a Claude Code hook event name to the task-run status it implies:
/// `SessionStart`/`UserPromptSubmit`→running, `Stop`→stopped, `StopFailure`→failed,
/// `SessionEnd`→stopped. Events Monica does not act on return `None` (they are still recorded,
/// never an error).
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

/// Statuses a generic lifecycle hook must never downgrade. Two reasons cohabit here:
/// - explicit `monica issue mark` signals (`need_approval`, `pr_open`, `done`, `archived`) — a
///   `Stop`/`SessionEnd` firing afterward records the event but leaves the user-declared state
///   intact.
/// - `failed` set by an earlier `StopFailure` hook in the same session — Claude often emits
///   `SessionEnd` right after `StopFailure`, and `SessionEnd→stopped` would otherwise silently
///   downgrade the failure signal we just recorded.
fn explicit_status_wins(current: TaskStatus) -> bool {
    matches!(
        current,
        TaskStatus::NeedApproval
            | TaskStatus::PrOpen
            | TaskStatus::Done
            | TaskStatus::Archived
            | TaskStatus::Failed
    )
}

fn task_status_for_run_status(status: TaskRunStatus) -> TaskStatus {
    match status {
        TaskRunStatus::Failed => TaskStatus::Failed,
        TaskRunStatus::SettingUp | TaskRunStatus::Running | TaskRunStatus::Stopped => {
            TaskStatus::Active
        }
    }
}

fn task_run_status_protected(status: TaskRunStatus) -> bool {
    matches!(status, TaskRunStatus::Failed)
}

fn agent_session_status_for_run_status(status: TaskRunStatus) -> AgentSessionStatus {
    match status {
        TaskRunStatus::SettingUp => AgentSessionStatus::Starting,
        TaskRunStatus::Running => AgentSessionStatus::Running,
        TaskRunStatus::Stopped => AgentSessionStatus::Stopped,
        TaskRunStatus::Failed => AgentSessionStatus::Failed,
    }
}

fn agent_session_status_after_hook(
    current: AgentSessionStatus,
    implied: TaskRunStatus,
) -> AgentSessionStatus {
    let next = agent_session_status_for_run_status(implied);
    match (current, next) {
        (AgentSessionStatus::Failed, AgentSessionStatus::Starting)
        | (AgentSessionStatus::Failed, AgentSessionStatus::Running)
        | (AgentSessionStatus::Failed, AgentSessionStatus::Stopped) => AgentSessionStatus::Failed,
        _ => next,
    }
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
    pub task_status: Option<TaskStatus>,
    pub task_run_status: Option<TaskRunStatus>,
    pub task_found: bool,
    pub task_run_linked: bool,
    pub agent_session_found: bool,
    pub event_recorded: bool,
    pub jsonl_written: bool,
    pub unsafe_task_run_id: bool,
}

/// Receive a Claude Code hook callback: parse the stdin JSON, append it to the run's
/// `hook-events.jsonl`, record an `events` row, and move the task (and its run) to the status
/// the event implies. Tolerant by contract — invalid JSON and unknown events are recorded without
/// erroring, so the caller can always exit 0 and never disrupt the Claude session.
///
/// `task_id` and `task_run_id` come from `MONICA_*` env vars and are treated as untrusted input:
/// - `task_run_id` becomes a path component only when [`is_safe_task_run_id`]; an id that resolves
///   to a task run owned by a *different* task is a mismatch and is excluded from every task-run
///   artifact (its jsonl, its status, the `events.task_run_id` link), so one session cannot pollute
///   another task run.
/// - a status implied by the event is applied only when it would not overwrite an explicit
///   `monica issue mark` signal ([`explicit_status_wins`]) — explicit signals win over inference.
pub fn record_claude_hook(
    db: &mut Db,
    task_id: Option<&str>,
    task_run_id: Option<&str>,
    raw_stdin: &str,
) -> Result<HookReport> {
    record_claude_hook_with_session(db, task_id, task_run_id, None, raw_stdin)
}

pub fn record_claude_hook_with_session(
    db: &mut Db,
    task_id: Option<&str>,
    task_run_id: Option<&str>,
    agent_session_id: Option<&str>,
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

    let current_status = match task_id {
        Some(id) => db.get_task(id)?.map(|w| w.status),
        None => None,
    };
    let task_found = current_status.is_some();

    let run_row = match safe_task_run_id {
        Some(r) => db.get_task_run(r)?,
        None => None,
    };
    let task_run_linked = match (run_row.as_ref(), task_id) {
        (Some(run), Some(wid)) => run.task_id == wid,
        _ => false,
    };
    let run_mismatch = run_row.is_some() && !task_run_linked;
    let linked_task_run_id = if task_run_linked {
        safe_task_run_id
    } else {
        None
    };

    let mut jsonl_written = false;
    if let Some(task_run_id) = safe_task_run_id {
        if !run_mismatch {
            append_jsonl(db, task_run_id, event_name.as_deref(), &parsed, raw_stdin)?;
            jsonl_written = true;
        }
    }

    let event_recorded = if task_found || task_run_linked {
        let payload = parsed
            .clone()
            .unwrap_or_else(|| json!({ "raw": raw_stdin }));
        db.insert_event(
            task_id.filter(|_| task_found),
            linked_task_run_id,
            "claude_hook",
            &payload,
        )?;
        true
    } else {
        false
    };

    let implied = event_name.as_deref().and_then(status_for_claude_event);
    let task_protected = current_status.map(explicit_status_wins).unwrap_or(false);
    let task_status = match (implied, current_status) {
        (Some(implied), Some(_)) if !task_protected => Some(task_status_for_run_status(implied)),
        _ => None,
    };
    let task_run_status = match (implied, linked_task_run_id) {
        (Some(implied), Some(_)) => {
            let protected = run_row
                .as_ref()
                .map(|r| task_run_status_protected(r.status))
                .unwrap_or(false);
            (!protected).then_some(implied)
        }
        _ => None,
    };
    if task_status.is_some() || task_run_status.is_some() {
        if let Some(task_id) = task_id {
            db.apply_hook_status(task_id, linked_task_run_id, task_status, task_run_status)?;
        }
    }

    let mut agent_session_found = false;
    if let (
        Some(agent_session_id),
        Some(status),
        Some(event_name),
        Some(task_id),
        Some(task_run_id),
    ) = (
        agent_session_id,
        implied,
        event_name.as_deref(),
        task_id,
        linked_task_run_id,
    ) {
        if let Some(session) = db.get_agent_session(agent_session_id)? {
            if session.task_id == task_id && session.task_run_id == task_run_id {
                agent_session_found = true;
                let at = db.now_iso()?;
                let provider_session_id = parsed
                    .as_ref()
                    .and_then(|value| value.get("session_id"))
                    .and_then(Value::as_str);
                db.update_agent_session_event(
                    agent_session_id,
                    agent_session_status_after_hook(session.status, status),
                    Some(event_name),
                    &at,
                    provider_session_id,
                    parsed.as_ref(),
                )?;
            }
        }
    }

    Ok(HookReport {
        event_name,
        task_status,
        task_run_status,
        task_found,
        task_run_linked,
        agent_session_found,
        event_recorded,
        jsonl_written,
        unsafe_task_run_id,
    })
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
    use crate::{Agent, NewAgentSession, NewTask, NewTaskRun, TaskKind};
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

    fn jsonl_for(task_run_id: &str) -> String {
        fs::read_to_string(
            paths::task_run_dir(task_run_id)
                .unwrap()
                .join(HOOK_EVENTS_FILE),
        )
        .unwrap()
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
    fn session_start_updates_task_and_linked_task_run() {
        let (_g, _home) = temp_home("start");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Ready);
        let run = db.start_task_run(new_task_run(&id)).unwrap();

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some(&run.id),
            r#"{"hook_event_name":"SessionStart"}"#,
        )
        .unwrap();

        assert_eq!(report.task_status, Some(TaskStatus::Active));
        assert_eq!(report.task_run_status, Some(TaskRunStatus::Running));
        assert!(report.task_run_linked);
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::Active
        );
        assert_eq!(
            db.get_task_run(&run.id).unwrap().unwrap().status,
            TaskRunStatus::Running
        );
        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(
            events.last().unwrap().task_run_id.as_deref(),
            Some(run.id.as_str())
        );
    }

    #[test]
    fn unknown_task_run_writes_jsonl_but_does_not_fk_link_event() {
        let (_g, _home) = temp_home("unknown-run");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Active);

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some("run_x"),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert_eq!(report.task_status, Some(TaskStatus::Active));
        assert_eq!(report.task_run_status, None);
        assert!(report.event_recorded);
        assert!(report.jsonl_written);
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::Active
        );
        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(events[0].task_run_id, None);
        assert!(jsonl_for("run_x").contains(r#""hook_event_name":"Stop""#));
    }

    #[test]
    fn explicit_task_status_survives_stop_but_task_run_stops() {
        let (_g, _home) = temp_home("protected");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Ready);
        let run = db.start_task_run(new_task_run(&id)).unwrap();
        db.finish_task_run(&run.id, &id, TaskRunStatus::Running)
            .unwrap();
        db.mark_task(&id, TaskStatus::NeedApproval, Some("Plan ready"), None)
            .unwrap();

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some(&run.id),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert_eq!(report.task_status, None);
        assert_eq!(report.task_run_status, Some(TaskRunStatus::Stopped));
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::NeedApproval
        );
        assert_eq!(
            db.get_task_run(&run.id).unwrap().unwrap().status,
            TaskRunStatus::Stopped
        );
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

        assert_eq!(report.task_status, None);
        assert_eq!(report.task_run_status, None);
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::Failed
        );
        assert_eq!(
            db.get_task_run(&run.id).unwrap().unwrap().status,
            TaskRunStatus::Failed
        );
    }

    #[test]
    fn unsafe_task_run_id_skips_jsonl_but_updates_task() {
        let (_g, home) = temp_home("unsafe");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Active);

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some("../evil"),
            r#"{"hook_event_name":"StopFailure"}"#,
        )
        .unwrap();

        assert!(report.unsafe_task_run_id);
        assert!(!report.jsonl_written);
        assert_eq!(report.task_status, Some(TaskStatus::Failed));
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::Failed
        );
        assert!(!home.join("evil").exists());
    }

    #[test]
    fn invalid_json_records_raw_event_without_status_change() {
        let (_g, _home) = temp_home("badjson");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Active);

        let report =
            record_claude_hook(&mut db, Some(&id), Some("run_x"), "not json at all").unwrap();

        assert_eq!(report.event_name, None);
        assert_eq!(report.task_status, None);
        assert!(report.event_recorded);
        assert!(report.jsonl_written);
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::Active
        );
        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(events[0].payload["raw"], json!("not json at all"));
    }

    #[test]
    fn unknown_event_records_but_leaves_status_and_needs_no_run() {
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Active);

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            None,
            r#"{"hook_event_name":"PreToolUse"}"#,
        )
        .unwrap();

        assert_eq!(report.event_name.as_deref(), Some("PreToolUse"));
        assert_eq!(report.task_status, None);
        assert_eq!(report.task_run_status, None);
        assert!(report.event_recorded);
        assert!(!report.jsonl_written);
        assert_eq!(
            db.get_task(&id).unwrap().unwrap().status,
            TaskStatus::Active
        );
    }

    #[test]
    fn run_id_of_another_task_is_not_linked_or_mutated() {
        let (_g, _home) = temp_home("mismatch");
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

        assert!(!report.task_run_linked);
        assert_eq!(report.task_status, Some(TaskStatus::Active));
        assert_eq!(report.task_run_status, None);
        assert_eq!(db.get_task(&b).unwrap().unwrap().status, TaskStatus::Active);
        assert_eq!(db.get_task(&a).unwrap().unwrap().status, TaskStatus::Active);
        assert_eq!(
            db.get_task_run(&run_a.id).unwrap().unwrap().status,
            TaskRunStatus::SettingUp
        );
        assert!(!report.jsonl_written);
    }

    #[test]
    fn hook_updates_agent_session_when_session_id_matches() {
        let (_g, _home) = temp_home("session");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Ready);
        let run = db.start_task_run(new_task_run(&id)).unwrap();
        let session = db
            .create_agent_session(NewAgentSession {
                task_id: id.clone(),
                task_run_id: run.id.clone(),
                agent: Agent::Claude,
                mode: "new".to_string(),
                provider_session_id: None,
                parent_session_id: None,
                metadata: json!({ "source": "test" }),
            })
            .unwrap();

        let report = record_claude_hook_with_session(
            &mut db,
            Some(&id),
            Some(&run.id),
            Some(&session.id),
            r#"{"hook_event_name":"SessionStart","session_id":"provider-1"}"#,
        )
        .unwrap();

        assert!(report.agent_session_found);
        let updated = db.get_agent_session(&session.id).unwrap().unwrap();
        assert_eq!(updated.status, AgentSessionStatus::Running);
        assert_eq!(updated.provider_session_id.as_deref(), Some("provider-1"));
        assert_eq!(updated.last_event_name.as_deref(), Some("SessionStart"));
        assert_eq!(updated.metadata["hook_event_name"], json!("SessionStart"));
    }

    #[test]
    fn hook_does_not_update_agent_session_owned_by_another_task_run() {
        let (_g, _home) = temp_home("session-mismatch");
        let mut db = Db::open_in_memory().unwrap();
        let a = dev_task(&mut db, TaskStatus::Ready);
        let run_a = db.start_task_run(new_task_run(&a)).unwrap();
        let session_a = db
            .create_agent_session(NewAgentSession {
                task_id: a.clone(),
                task_run_id: run_a.id.clone(),
                agent: Agent::Claude,
                mode: "new".to_string(),
                provider_session_id: None,
                parent_session_id: None,
                metadata: json!({ "source": "original" }),
            })
            .unwrap();
        let b = dev_task(&mut db, TaskStatus::Ready);
        let run_b = db.start_task_run(new_task_run(&b)).unwrap();

        let report = record_claude_hook_with_session(
            &mut db,
            Some(&b),
            Some(&run_b.id),
            Some(&session_a.id),
            r#"{"hook_event_name":"SessionStart","session_id":"provider-wrong"}"#,
        )
        .unwrap();

        assert!(!report.agent_session_found);
        let unchanged = db.get_agent_session(&session_a.id).unwrap().unwrap();
        assert_eq!(unchanged.status, AgentSessionStatus::Starting);
        assert_eq!(unchanged.provider_session_id, None);
        assert_eq!(unchanged.last_event_name, None);
        assert_eq!(unchanged.metadata["source"], json!("original"));
    }

    #[test]
    fn session_end_does_not_downgrade_failed_agent_session() {
        let (_g, _home) = temp_home("session-failed");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_task(&mut db, TaskStatus::Ready);
        let run = db.start_task_run(new_task_run(&id)).unwrap();
        let session = db
            .create_agent_session(NewAgentSession {
                task_id: id.clone(),
                task_run_id: run.id.clone(),
                agent: Agent::Claude,
                mode: "new".to_string(),
                provider_session_id: None,
                parent_session_id: None,
                metadata: json!({ "source": "test" }),
            })
            .unwrap();

        record_claude_hook_with_session(
            &mut db,
            Some(&id),
            Some(&run.id),
            Some(&session.id),
            r#"{"hook_event_name":"StopFailure","session_id":"provider-1"}"#,
        )
        .unwrap();
        record_claude_hook_with_session(
            &mut db,
            Some(&id),
            Some(&run.id),
            Some(&session.id),
            r#"{"hook_event_name":"SessionEnd","session_id":"provider-1"}"#,
        )
        .unwrap();

        let updated = db.get_agent_session(&session.id).unwrap().unwrap();
        assert_eq!(updated.status, AgentSessionStatus::Failed);
        assert_eq!(updated.last_event_name.as_deref(), Some("SessionEnd"));
        assert_eq!(updated.metadata["hook_event_name"], json!("SessionEnd"));
    }
}
