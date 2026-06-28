use anyhow::Result;

use super::ports::{Clock, EventRepository, TaskRunOutputs, TaskRunStore, TaskStore};
use crate::ports::UnitOfWork;
use crate::prelude::{is_safe_task_run_id, Agent, AgentSignal, SignalKind, Task};
use crate::prelude::{NewTaskRun, TaskId, TaskRun, TaskRunStatus, TaskRunWaitReason, TaskStatus};
use crate::{ApplicationError, TaskRunObservation};

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
    pub linked_task_run_id: Option<String>,
    pub linked_task_id: Option<String>,
    pub ignored: bool,
    pub task_found: bool,
    pub task_run_linked: bool,
    pub task_run_created: bool,
    pub event_recorded: bool,
    pub jsonl_written: bool,
    pub unsafe_task_run_id: bool,
}

impl HookReport {
    fn ignored(unsafe_task_run_id: bool) -> Self {
        HookReport {
            event_name: None,
            task_run_status: None,
            task_run_wait_reason: None,
            entered_waiting_for_user: false,
            task_title: None,
            linked_task_run_id: None,
            linked_task_id: None,
            ignored: true,
            task_found: false,
            task_run_linked: false,
            task_run_created: false,
            event_recorded: false,
            jsonl_written: false,
            unsafe_task_run_id,
        }
    }
}

/// Apply a decoded agent [`AgentSignal`] to the run it belongs to. The provider payload was already
/// interpreted by the adapter decoder; this use case only resolves which run the signal targets,
/// asks the domain ([`TaskRun::decide`](monica_domain::TaskRun::decide)) what to record, and persists
/// it. `signal == None` means the decoder found nothing actionable (a non-blocking tool call, an
/// unparseable payload), so the hook is ignored without touching storage.
pub fn record_hook<R, A>(
    repos: &mut R,
    outputs: &A,
    ctx: HookContext<'_>,
    agent: Agent,
    signal: Option<&AgentSignal>,
    raw_stdin: &str,
) -> Result<HookReport>
where
    R: TaskStore + TaskRunStore + EventRepository + Clock + UnitOfWork,
    A: TaskRunOutputs,
{
    let safe_task_run_id = ctx.task_run_id.filter(|&r| is_safe_task_run_id(r));
    let unsafe_task_run_id = ctx.task_run_id.is_some() && safe_task_run_id.is_none();

    let Some(signal) = signal else {
        return Ok(HookReport::ignored(unsafe_task_run_id));
    };

    let event_label = signal.event_label.as_deref();
    let provider_session_id = signal.session_id.as_deref();

    let resolved = resolve_hook_run(
        repos,
        ctx.task_id,
        safe_task_run_id,
        unsafe_task_run_id,
        provider_session_id,
        signal.starts_session(),
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
    // The full hook payload, stored verbatim (opaque RawJson). `signal` is only `Some` when the
    // decoder parsed valid JSON, so this is always valid JSON text.
    let metadata_raw = raw_stdin.trim();

    let mut jsonl_written = false;
    if let Some(task_run_id) = linked_task_run_id {
        outputs
            .append_hook_event(task_run_id, &at, event_label, raw_stdin)
            .map_err(|e| ApplicationError::external(format!("failed to write hook event: {e:#}")))?;
        jsonl_written = true;
    }

    let plan = run_row.as_ref().map(|run| run.decide(signal));
    let transition = plan.and_then(|p| p.transition);

    let needs_event = task_found || task_run_linked;
    let needs_observation = linked_task_run_id.is_some() && plan.is_some();

    let event_recorded = if needs_event || needs_observation {
        let mut tx = repos.begin()?;

        let event_recorded = if needs_event {
            let event_type = format!("{}_hook", agent.as_str());
            tx.insert_event(
                linked_task_id.filter(|_| needs_event),
                linked_task_run_id,
                &event_type,
                metadata_raw,
            )?;
            true
        } else {
            false
        };

        if let (Some(task_run_id), Some(plan)) = (linked_task_run_id, plan) {
            let wait_update = plan.transition.map(|t| {
                if t.status == TaskRunStatus::WaitingForUser {
                    t.wait_reason
                } else {
                    None
                }
            });
            tx.record_task_run_observation(
                task_run_id,
                TaskRunObservation {
                    status: plan.transition.map(|t| t.status),
                    wait_reason: wait_update,
                    event_label,
                    at: &at,
                    provider_session_id: provider_session_id.filter(|_| plan.stamp_session),
                    terminal_tab_id: ctx.terminal_tab_id.filter(|_| plan.stamp_tab),
                    metadata_raw: Some(metadata_raw),
                    plan_file_path: signal.plan_file_path(),
                    hold_stop: plan.hold_stop,
                    release_stop: plan.release_stop,
                },
            )?;
        }

        tx.commit()?;
        event_recorded
    } else {
        false
    };

    // A `SubagentFinished` produces no direct transition, but it may release a deferred turn-complete
    // in the store (Running → WaitingForUser); detect that so the entering edge still notifies.
    let landed = match (transition, linked_task_run_id) {
        (Some(_), Some(run_id)) => repos.get_task_run(run_id)?,
        (None, Some(run_id)) if matches!(signal.kind, SignalKind::SubagentFinished { .. }) => repos
            .get_task_run(run_id)?
            .filter(|run| {
                run_row
                    .as_ref()
                    .is_some_and(|prev| prev.status == TaskRunStatus::Running)
                    && run.status == TaskRunStatus::WaitingForUser
            }),
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
        event_name: signal.event_label.clone(),
        task_run_status,
        task_run_wait_reason,
        entered_waiting_for_user,
        task_title,
        linked_task_run_id: linked_task_run_id.map(str::to_string),
        linked_task_id: linked_task_id.map(str::to_string),
        ignored: false,
        task_found,
        task_run_linked,
        task_run_created: resolved.created,
        event_recorded,
        jsonl_written,
        unsafe_task_run_id,
    })
}

pub(in crate::usecases) struct ResolvedRun {
    pub(in crate::usecases) run: Option<TaskRun>,
    pub(in crate::usecases) created: bool,
}

impl ResolvedRun {
    fn linked(run: Option<TaskRun>) -> Self {
        Self { run, created: false }
    }
}

type ResolveRule<R> = fn(&RunResolveCtx, &mut R) -> Result<Option<ResolvedRun>>;

pub(in crate::usecases) struct RunResolveCtx<'a> {
    pub(in crate::usecases) task_id: &'a str,
    pub(in crate::usecases) task: &'a Task,
    pub(in crate::usecases) explicit_run_id_rejected: bool,
    pub(in crate::usecases) provider_session_id: Option<&'a str>,
    /// Whether the signal proves a user is actively driving a session (session start / first
    /// prompt) — only such signals may claim or create a run.
    pub(in crate::usecases) starts_session: bool,
    pub(in crate::usecases) agent: Agent,
    pub(in crate::usecases) primary_run: Option<&'a TaskRun>,
}

/// Resolve which task run a hook belongs to. Rules are evaluated top-down, first match wins:
///
/// 1. An explicit run id (wrapper launch) always wins; no session lookup.
/// 2. A run already carrying this session id is followed — this covers both a claimed primary and an
///    existing side run.
/// 3. A still-`Prepared` primary run is claimed by a session-starting signal (the Run-button flow
///    before its first hook, or plain `claude` consuming a Prepare); stray mid-session events from an
///    unknown session must not take it over. With a session id the claim is an atomic guarded UPDATE,
///    so two near-simultaneous starts can't both take the run — the loser falls through to rule 4 and
///    becomes a side run.
/// 4. Otherwise a session-starting signal from a live task lazily creates a run: it becomes the
///    primary when none is set (or the pointer dangles), and a side run when a primary already
///    exists — a run actively driven by another session is never stolen. A rejected explicit run id
///    means a wrapper launch with corrupted env, not a plain session; it never creates.
fn resolve_hook_run<R>(
    repos: &mut R,
    task_id: Option<&str>,
    explicit_run_id: Option<&str>,
    explicit_run_id_rejected: bool,
    provider_session_id: Option<&str>,
    starts_session: bool,
    agent: Agent,
) -> Result<ResolvedRun>
where
    R: TaskStore + TaskRunStore,
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

    let primary_run = match task.primary_task_run_id.as_deref() {
        Some(primary_id) => repos.get_task_run(primary_id)?,
        None => None,
    };

    let ctx = RunResolveCtx {
        task_id,
        task: &task,
        explicit_run_id_rejected,
        provider_session_id,
        starts_session,
        agent,
        primary_run: primary_run.as_ref(),
    };

    let rules: [ResolveRule<R>; 3] = [
        resolve_by_session,
        resolve_by_prepared_primary,
        resolve_by_lazy_create,
    ];
    for rule in &rules {
        if let Some(resolved) = rule(&ctx, repos)? {
            return Ok(resolved);
        }
    }
    Ok(ResolvedRun::linked(None))
}

pub(in crate::usecases) fn resolve_by_session<R>(
    ctx: &RunResolveCtx,
    repos: &mut R,
) -> Result<Option<ResolvedRun>>
where
    R: TaskStore + TaskRunStore,
{
    let Some(session_id) = ctx.provider_session_id else {
        return Ok(None);
    };
    match repos.find_task_run_by_session(ctx.task_id, session_id)? {
        Some(run) => Ok(Some(ResolvedRun::linked(Some(run)))),
        None => Ok(None),
    }
}

pub(in crate::usecases) fn resolve_by_prepared_primary<R>(
    ctx: &RunResolveCtx,
    repos: &mut R,
) -> Result<Option<ResolvedRun>>
where
    R: TaskStore + TaskRunStore,
{
    let Some(run) = ctx.primary_run else {
        return Ok(None);
    };
    if run.status != TaskRunStatus::Prepared || !ctx.starts_session {
        return Ok(None);
    }
    // No session id to stamp (e.g. the Run-button flow before its first hook): nothing to claim
    // and nothing another session could clobber, so keep the snapshot behavior.
    let Some(session_id) = ctx.provider_session_id else {
        return Ok(Some(ResolvedRun::linked(Some(run.clone()))));
    };
    // Atomic claim: only the start whose guarded UPDATE lands keeps the prepared run. A loser
    // changes 0 rows and falls through to lazy-create as a side run.
    if repos.claim_prepared_run(&run.id, session_id)? {
        // The claim only set `provider_session_id`; reflect it on the snapshot we already hold
        // (avoiding a re-read) so the observation that follows sees the claimed session.
        let mut claimed = run.clone();
        claimed.provider_session_id = Some(session_id.to_string());
        Ok(Some(ResolvedRun::linked(Some(claimed))))
    } else {
        Ok(None)
    }
}

pub(in crate::usecases) fn resolve_by_lazy_create<R>(
    ctx: &RunResolveCtx,
    repos: &mut R,
) -> Result<Option<ResolvedRun>>
where
    R: TaskStore + TaskRunStore,
{
    if ctx.provider_session_id.is_none()
        || !ctx.starts_session
        || ctx.explicit_run_id_rejected
        || ctx.task.status == TaskStatus::Closed
    {
        return Ok(None);
    }

    // `make_primary_if_missing` is true exactly when no usable primary exists — including a dangling
    // pointer, which `primary_run` already resolved to `None`; otherwise the new run is a side run.
    let run = repos.create_lazy_run_for_session(
        NewTaskRun {
            task_id: TaskId::from_store(ctx.task_id.to_string()),
            agent: Some(ctx.agent),
            branch: None,
            worktree_path: None,
        },
        ctx.primary_run.is_none(),
    )?;
    Ok(Some(ResolvedRun {
        run: Some(run),
        created: true,
    }))
}
