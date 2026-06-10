use anyhow::Result;
use serde_json::{json, Value};

use crate::domain::{
    is_safe_task_run_id, should_ignore_claude_event, transition_for_claude_event,
    transition_is_protected, Agent,
};
use crate::interfaces::{Clock, EventRepository, RunArtifacts, TaskRepository, TaskRunRepository};
use crate::{NewTaskRun, TaskRun, TaskRunObservation, TaskRunStatus, TaskRunWaitReason, TaskStatus};

/// Identity carried by a hook invocation via `MONICA_*` env vars. `task_run_id` is only present
/// for wrapper launches with an explicit run; plain `claude` in a Bench tab has task/tab only.
#[derive(Debug, Clone, Copy, Default)]
pub struct HookContext<'a> {
    pub task_id: Option<&'a str>,
    pub task_run_id: Option<&'a str>,
    pub terminal_tab_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookReport {
    pub event_name: Option<String>,
    pub task_run_status: Option<TaskRunStatus>,
    pub task_run_wait_reason: Option<TaskRunWaitReason>,
    pub ignored: bool,
    pub task_found: bool,
    pub task_run_linked: bool,
    pub task_run_created: bool,
    pub event_recorded: bool,
    pub jsonl_written: bool,
    pub unsafe_task_run_id: bool,
}

pub fn record_claude_hook<R, A>(
    repos: &mut R,
    artifacts: &A,
    ctx: HookContext<'_>,
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

    let safe_task_run_id = ctx.task_run_id.filter(|&r| is_safe_task_run_id(r));
    let unsafe_task_run_id = ctx.task_run_id.is_some() && safe_task_run_id.is_none();

    if should_ignore_claude_event(event_name.as_deref(), parsed.as_ref()) {
        return Ok(HookReport {
            event_name,
            task_run_status: None,
            task_run_wait_reason: None,
            ignored: true,
            task_found: false,
            task_run_linked: false,
            task_run_created: false,
            event_recorded: false,
            jsonl_written: false,
            unsafe_task_run_id,
        });
    }

    let provider_session_id = parsed
        .as_ref()
        .and_then(|value| value.get("session_id"))
        .and_then(Value::as_str);

    let resolved = resolve_hook_run(
        repos,
        ctx.task_id,
        safe_task_run_id,
        provider_session_id,
        event_name.as_deref(),
        parsed.as_ref(),
    )?;
    let run_row = resolved.run;
    let task_run_linked = run_row.is_some();
    let linked_task_run_id = run_row.as_ref().map(|run| run.id.as_str());
    let linked_task_id = run_row
        .as_ref()
        .map(|run| run.task_id.as_str())
        .or(ctx.task_id);
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
                terminal_tab_id: ctx.terminal_tab_id,
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
        task_run_created: resolved.created,
        event_recorded,
        jsonl_written,
        unsafe_task_run_id,
    })
}

struct ResolvedRun {
    run: Option<TaskRun>,
    created: bool,
}

impl ResolvedRun {
    fn linked(run: Option<TaskRun>) -> Self {
        Self { run, created: false }
    }

    fn none() -> Self {
        Self { run: None, created: false }
    }
}

/// Session-starting events may create a run when nothing else matches; anything else (a stray
/// `Stop` from an untracked session, a broken payload) must never grow the run set.
fn is_session_starting_event(event_name: Option<&str>) -> bool {
    matches!(event_name, Some("SessionStart" | "UserPromptSubmit"))
}

/// Resolve which task run a hook belongs to. Rules are evaluated top-down, first match wins:
///
/// 1. An explicit run id (wrapper launch) always wins; no session lookup.
/// 2. A run already carrying this Claude session id is followed — this covers both a claimed
///    primary and an existing side run.
/// 3. A still-`Prepared` primary run is claimed (the Run-button flow before its first hook).
/// 4. Otherwise a session-starting event from a live task lazily creates a run: it becomes the
///    primary when none is set (or the pointer dangles), and a side run when a primary already
///    exists — a run actively driven by another session is never stolen.
///
/// TODO: two near-simultaneous SessionStarts can both pass rule 3 (or both reach rule 4) before
/// either observation lands; an atomic `UPDATE ... WHERE status = 'prepared'` claim would close
/// the window. Hooks are human-paced, so this is accepted for now.
fn resolve_hook_run<R>(
    repos: &mut R,
    task_id: Option<&str>,
    explicit_run_id: Option<&str>,
    provider_session_id: Option<&str>,
    event_name: Option<&str>,
    payload: Option<&Value>,
) -> Result<ResolvedRun>
where
    R: TaskRepository + TaskRunRepository,
{
    if let Some(run_id) = explicit_run_id {
        return Ok(ResolvedRun::linked(repos.get_task_run(run_id)?));
    }
    let Some(task_id) = task_id else {
        return Ok(ResolvedRun::none());
    };
    let Some(task) = repos.get_task(task_id)? else {
        return Ok(ResolvedRun::none());
    };

    if let Some(session_id) = provider_session_id {
        if let Some(run) = repos.find_task_run_by_session(task_id, session_id)? {
            return Ok(ResolvedRun::linked(Some(run)));
        }
    }

    let primary_run = match task.primary_task_run_id.as_deref() {
        Some(primary_id) => repos.get_task_run(primary_id)?,
        None => None,
    };
    if let Some(run) = &primary_run {
        if run.status == TaskRunStatus::Prepared {
            return Ok(ResolvedRun::linked(primary_run));
        }
    }

    if provider_session_id.is_none()
        || !is_session_starting_event(event_name)
        || task.status == TaskStatus::Done
    {
        return Ok(ResolvedRun::none());
    }

    let cwd = payload
        .and_then(|value| value.get("cwd"))
        .and_then(Value::as_str);
    let run = repos.start_task_run(NewTaskRun {
        task_id: task_id.to_string(),
        agent: Some(Agent::Claude),
        branch: None,
        worktree_path: cwd.map(str::to_owned),
    })?;
    if primary_run.is_none() {
        repos.set_primary_task_run(task_id, &run.id)?;
    }
    Ok(ResolvedRun {
        run: Some(run),
        created: true,
    })
}
