use anyhow::Result;
use serde_json::{json, Value};

use crate::domain::{
    is_continuation_session_start, is_resume_session_start, is_safe_task_run_id,
    is_session_starting_event, payload_has_running_subagents, should_ignore_event,
    transition_for_event, transition_is_protected, Agent,
};
use crate::interfaces::{Clock, EventRepository, TaskRunOutputs, TaskRepository, TaskRunRepository};
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
    /// This hook is the one that moved the run into `WaitingForUser`. Distinct from
    /// `task_run_status == Some(WaitingForUser)`, which a later event re-affirms while the run is
    /// already waiting; only the entering edge should fire a notification.
    pub entered_waiting_for_user: bool,
    /// The run's task title, carried only on the entering edge so a notification need not reach
    /// back into the DB for what core already resolved.
    pub task_title: Option<String>,
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
    outputs: &A,
    ctx: HookContext<'_>,
    raw_stdin: &str,
) -> Result<HookReport>
where
    R: TaskRepository + TaskRunRepository + EventRepository + Clock,
    A: TaskRunOutputs,
{
    record_hook(repos, outputs, ctx, raw_stdin, Agent::Claude)
}

pub fn record_codex_hook<R, A>(
    repos: &mut R,
    outputs: &A,
    ctx: HookContext<'_>,
    raw_stdin: &str,
) -> Result<HookReport>
where
    R: TaskRepository + TaskRunRepository + EventRepository + Clock,
    A: TaskRunOutputs,
{
    record_hook(repos, outputs, ctx, raw_stdin, Agent::Codex)
}

fn record_hook<R, A>(
    repos: &mut R,
    outputs: &A,
    ctx: HookContext<'_>,
    raw_stdin: &str,
    agent: Agent,
) -> Result<HookReport>
where
    R: TaskRepository + TaskRunRepository + EventRepository + Clock,
    A: TaskRunOutputs,
{
    let parsed: Option<Value> = serde_json::from_str(raw_stdin.trim()).ok();
    let event_name = parsed
        .as_ref()
        .and_then(|v| v.get("hook_event_name"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let safe_task_run_id = ctx.task_run_id.filter(|&r| is_safe_task_run_id(r));
    let unsafe_task_run_id = ctx.task_run_id.is_some() && safe_task_run_id.is_none();

    if should_ignore_event(agent, event_name.as_deref(), parsed.as_ref()) {
        return Ok(HookReport {
            event_name,
            task_run_status: None,
            task_run_wait_reason: None,
            entered_waiting_for_user: false,
            task_title: None,
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
        unsafe_task_run_id,
        provider_session_id,
        event_name.as_deref(),
        agent,
    )?;
    let run_row = resolved.run;
    let task_run_linked = run_row.is_some();
    let linked_task_run_id = run_row.as_ref().map(|run| run.id.as_str());
    let linked_task_id = run_row
        .as_ref()
        .map(|run| run.task_id.as_str())
        .or(ctx.task_id);
    let task_found = match linked_task_id {
        Some(_) if run_row.is_some() => true,
        Some(id) => repos.get_task(id)?.is_some(),
        None => false,
    };

    let at = repos.now_iso()?;
    let mut jsonl_written = false;
    if let Some(task_run_id) = linked_task_run_id {
        outputs.append_hook_event(task_run_id, &at, event_name.as_deref(), &parsed, raw_stdin)?;
        jsonl_written = true;
    }

    let event_recorded = if task_found || task_run_linked {
        let event_type = match agent {
            Agent::Claude => "claude_hook",
            Agent::Codex => "codex_hook",
        };
        let payload = parsed
            .clone()
            .unwrap_or_else(|| json!({ "raw": raw_stdin }));
        repos.insert_event(
            linked_task_id.filter(|_| task_found || task_run_linked),
            linked_task_run_id,
            event_type,
            &payload,
        )?;
        true
    } else {
        false
    };

    let requested = event_name
        .as_deref()
        .and_then(|event| transition_for_event(agent, event, parsed.as_ref()));
    let suppressed_continuation = run_row
        .as_ref()
        .is_some_and(|run| run.status == TaskRunStatus::Running)
        && is_continuation_session_start(event_name.as_deref(), parsed.as_ref());
    let protected = match (requested, run_row.as_ref()) {
        (Some(transition), Some(run)) if !suppressed_continuation => transition_is_protected(
            run.status,
            run.wait_reason,
            run.provider_session_id.as_deref(),
            provider_session_id,
            run.active_subagents > 0 || payload_has_running_subagents(parsed.as_ref()),
            event_name.as_deref(),
            transition,
        ),
        _ => false,
    };
    let transition = match (requested, run_row.as_ref()) {
        (Some(transition), Some(_)) if !suppressed_continuation && !protected => Some(transition),
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
        let terminal_tab_id = ctx
            .terminal_tab_id
            .filter(|_| !is_resume_session_start(event_name.as_deref(), parsed.as_ref()));
        repos.record_task_run_observation(
            task_run_id,
            TaskRunObservation {
                status: transition.map(|t| t.status),
                wait_reason: wait_update,
                event_name: event_name.as_deref(),
                at: &at,
                provider_session_id: provider_session_id.filter(|_| !protected),
                terminal_tab_id,
                metadata: parsed.as_ref(),
            },
        )?;
    }

    let landed = match (transition, linked_task_run_id) {
        (Some(_), Some(run_id)) => repos.get_task_run(run_id)?,
        (None, Some(run_id))
            if event_name.as_deref() == Some("SubagentStop")
                && run_row.as_ref().is_some_and(|prev| prev.pending_stop) =>
        {
            repos.get_task_run(run_id)?.filter(|run| {
                run_row
                    .as_ref()
                    .is_some_and(|prev| prev.status == TaskRunStatus::Running)
                    && run.status == TaskRunStatus::WaitingForUser
            })
        }
        _ => None,
    };
    let (task_run_status, task_run_wait_reason) = match landed {
        Some(run) => (Some(run.status), run.wait_reason),
        None => (None, None),
    };

    let entered_waiting_for_user = task_run_status == Some(TaskRunStatus::WaitingForUser)
        && !run_row
            .as_ref()
            .is_some_and(|run| run.status == TaskRunStatus::WaitingForUser);
    let task_title = match linked_task_id.filter(|_| entered_waiting_for_user) {
        Some(id) => repos.get_task(id)?.map(|task| task.title),
        None => None,
    };

    Ok(HookReport {
        event_name,
        task_run_status,
        task_run_wait_reason,
        entered_waiting_for_user,
        task_title,
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
}

/// Resolve which task run a hook belongs to. Rules are evaluated top-down, first match wins:
///
/// 1. An explicit run id (wrapper launch) always wins; no session lookup.
/// 2. A run already carrying this Claude session id is followed — this covers both a claimed
///    primary and an existing side run.
/// 3. A still-`Prepared` primary run is claimed by a session-starting event (the Run-button
///    flow before its first hook, or plain `claude` consuming a Prepare); stray mid-session
///    events from an unknown session must not take it over.
/// 4. Otherwise a session-starting event from a live task lazily creates a run: it becomes the
///    primary when none is set (or the pointer dangles), and a side run when a primary already
///    exists — a run actively driven by another session is never stolen. A rejected explicit
///    run id means a wrapper launch with corrupted env, not a plain session; it never creates.
///
/// TODO: two near-simultaneous SessionStarts can both pass rule 3 (or both reach rule 4) before
/// either observation lands; an atomic `UPDATE ... WHERE status = 'prepared'` claim would close
/// the window. Hooks are human-paced, so this is accepted for now.
fn resolve_hook_run<R>(
    repos: &mut R,
    task_id: Option<&str>,
    explicit_run_id: Option<&str>,
    explicit_run_id_rejected: bool,
    provider_session_id: Option<&str>,
    event_name: Option<&str>,
    agent: Agent,
) -> Result<ResolvedRun>
where
    R: TaskRepository + TaskRunRepository,
{
    if let Some(run_id) = explicit_run_id {
        return Ok(ResolvedRun::linked(repos.get_task_run(run_id)?));
    }
    let Some(task_id) = task_id else {
        return Ok(ResolvedRun::linked(None));
    };
    let Some(task) = repos.get_task(task_id)? else {
        return Ok(ResolvedRun::linked(None));
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
        if run.status == TaskRunStatus::Prepared && is_session_starting_event(event_name) {
            return Ok(ResolvedRun::linked(primary_run));
        }
    }

    if provider_session_id.is_none()
        || !is_session_starting_event(event_name)
        || explicit_run_id_rejected
        || task.status == TaskStatus::Closed
    {
        return Ok(ResolvedRun::linked(None));
    }

    // The session's cwd is arbitrary user space (often the project's main checkout, where
    // delete-time worktree cleanup would rip it); it stays in metadata_json, never here.
    let run = repos.start_task_run(NewTaskRun {
        task_id: task_id.to_string(),
        agent: Some(agent),
        branch: None,
        worktree_path: None,
    })?;
    if primary_run.is_none() {
        repos.set_primary_task_run(task_id, &run.id)?;
    }
    Ok(ResolvedRun {
        run: Some(run),
        created: true,
    })
}
