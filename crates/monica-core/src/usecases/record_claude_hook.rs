use anyhow::Result;
use serde_json::{json, Value};

use crate::domain::{
    is_safe_task_run_id, should_ignore_claude_event, transition_for_claude_event,
    transition_is_protected,
};
use crate::interfaces::{Clock, EventRepository, RunArtifacts, TaskRepository, TaskRunRepository};
use crate::{TaskRun, TaskRunObservation, TaskRunStatus, TaskRunWaitReason};

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

pub fn record_claude_hook<R, A>(
    repos: &mut R,
    artifacts: &A,
    task_id: Option<&str>,
    task_run_id: Option<&str>,
    raw_stdin: &str,
) -> Result<HookReport>
where
    R: TaskRepository + TaskRunRepository + EventRepository + Clock,
    A: RunArtifacts,
{
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

    let provider_session_id = parsed
        .as_ref()
        .and_then(|value| value.get("session_id"))
        .and_then(Value::as_str);

    let run_row = match safe_task_run_id {
        Some(r) => repos.get_task_run(r)?,
        None => claim_primary_run(repos, task_id, provider_session_id)?,
    };
    let task_run_linked = run_row.is_some();
    let linked_task_run_id = run_row.as_ref().map(|run| run.id.as_str());
    let linked_task_id = run_row.as_ref().map(|run| run.task_id.as_str()).or(task_id);
    let task_found = match linked_task_id {
        Some(id) if run_row.is_some() => repos.get_task(id)?.is_some() || run_row.is_some(),
        Some(id) => repos.get_task(id)?.is_some(),
        None => false,
    };

    let at = repos.now_iso()?;
    let mut jsonl_written = false;
    if let Some(task_run_id) = linked_task_run_id {
        artifacts.append_hook_event(task_run_id, &at, event_name.as_deref(), &parsed, raw_stdin)?;
        jsonl_written = true;
    }

    let event_recorded = if task_found || task_run_linked {
        let payload = parsed
            .clone()
            .unwrap_or_else(|| json!({ "raw": raw_stdin }));
        repos.insert_event(
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

    if let Some(task_run_id) = linked_task_run_id {
        let wait_update = transition.map(|t| {
            if t.status == TaskRunStatus::WaitingForUser {
                t.wait_reason
            } else {
                None
            }
        });
        repos.record_task_run_observation(
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

/// Resolve a hook that carries task context but no run id (e.g. `claude` launched manually in a
/// Bench tab) to the task's primary run. The primary run is claimed while still `Prepared`; once
/// claimed, later hooks from the same Claude session keep following it via the recorded provider
/// session id. A run actively driven by another session is never stolen.
fn claim_primary_run<R>(
    repos: &R,
    task_id: Option<&str>,
    provider_session_id: Option<&str>,
) -> Result<Option<TaskRun>>
where
    R: TaskRepository + TaskRunRepository,
{
    let Some(task_id) = task_id else {
        return Ok(None);
    };
    let Some(task) = repos.get_task(task_id)? else {
        return Ok(None);
    };
    let Some(primary_id) = task.primary_task_run_id else {
        return Ok(None);
    };
    let Some(run) = repos.get_task_run(&primary_id)? else {
        return Ok(None);
    };

    let same_session = provider_session_id.is_some()
        && run.provider_session_id.as_deref() == provider_session_id;
    if run.status == TaskRunStatus::Prepared || same_session {
        Ok(Some(run))
    } else {
        Ok(None)
    }
}
