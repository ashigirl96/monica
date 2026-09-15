use super::ports::{Clock, EventRepository, TaskRunStore, TaskStore};
use crate::ports::{TerminalSessionRepository, UnitOfWork};
use crate::ApplicationResult;
use crate::prelude::{is_safe_task_run_id, Agent, AgentSignal, SignalKind, Task};
use crate::prelude::{NewTaskRun, TaskId, TaskRun, TaskRunStatus, TaskRunWaitReason, TaskStatus};
use monica_domain::{
    AgentSessionEffect, AgentSessionId, AgentSessionStatus, TaskRunId, TransitionRefusal,
};
use crate::TaskRunObservation;

/// Which rule bound this hook to a run. Reported so a hook that landed on the "wrong" run can be
/// traced back to the rule that chose it, without re-deriving the chain from the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookResolveRoute {
    ExplicitRunId,
    TabBinding,
    TaskMissing,
    BySession,
    ByPreparedPrimary,
    ByLazyCreate,
    Unresolved,
}

impl HookResolveRoute {
    pub fn as_str(self) -> &'static str {
        match self {
            HookResolveRoute::ExplicitRunId => "explicit_run_id",
            HookResolveRoute::TabBinding => "tab_binding",
            HookResolveRoute::TaskMissing => "task_missing",
            HookResolveRoute::BySession => "session",
            HookResolveRoute::ByPreparedPrimary => "prepared_primary",
            HookResolveRoute::ByLazyCreate => "lazy_create",
            HookResolveRoute::Unresolved => "none",
        }
    }
}

/// Why a rule declined. Each variant is one `return` in one resolver; conditions the code used to
/// OR together are split so the report names the condition that actually fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveSkip {
    NoSessionId,
    NoRunForSession,
    NoPrimaryRun,
    PrimaryNotPrepared(TaskRunStatus),
    NotSessionStarting,
    ClaimLost,
    ExplicitRunIdRejected,
    TaskClosed,
}

impl std::fmt::Display for ResolveSkip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveSkip::NoSessionId => f.write_str("no_session_id"),
            ResolveSkip::NoRunForSession => f.write_str("no_run_for_session"),
            ResolveSkip::NoPrimaryRun => f.write_str("no_primary_run"),
            ResolveSkip::PrimaryNotPrepared(status) => {
                write!(f, "primary_not_prepared({})", status.as_str())
            }
            ResolveSkip::NotSessionStarting => f.write_str("not_session_starting"),
            ResolveSkip::ClaimLost => f.write_str("claim_lost"),
            ResolveSkip::ExplicitRunIdRejected => f.write_str("explicit_run_id_rejected"),
            ResolveSkip::TaskClosed => f.write_str("task_closed"),
        }
    }
}

/// The identity a hook arrived with, kept for the trace line alone.
///
/// Separate from the report's own `terminal_session_id` on purpose: that field drives notification
/// cancellation, so an ignored payload must leave it unset while its trace line still names every
/// id the hook was launched with.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HookIdentity {
    pub task_id: Option<TaskId>,
    pub task_run_id: Option<TaskRunId>,
    pub terminal_tab_id: Option<String>,
    pub terminal_session_id: Option<String>,
}

impl HookIdentity {
    /// `task_run_id` is the id after the safety check, never the raw env value: an id that failed it
    /// is attacker-shaped text, and a log line is the wrong place to repeat it. `unsafe_run_id=true`
    /// on the same line says one was supplied and rejected.
    fn of(ctx: HookContext<'_>, safe_task_run_id: Option<&TaskRunId>) -> Self {
        HookIdentity {
            task_id: ctx.task_id.cloned(),
            task_run_id: safe_task_run_id.cloned(),
            terminal_tab_id: ctx.terminal_tab_id.map(str::to_string),
            terminal_session_id: ctx.terminal_session_id.map(str::to_string),
        }
    }
}

/// The three task-scoped rules, in evaluation order. Paired with `ResolveTrace::skipped` by index.
const RULE_NAMES: [&str; 3] = ["session", "prepared_primary", "lazy_create"];

/// Identity carried by a hook invocation via `MONICA_*` env vars. `task_run_id` is only present
/// for wrapper launches with an explicit run; plain `claude` in a Bench tab has task/tab only, and
/// an agent in a non-task tab has just the terminal session/tab.
#[derive(Debug, Clone, Copy, Default)]
pub struct HookContext<'a> {
    pub task_id: Option<&'a TaskId>,
    pub task_run_id: Option<&'a TaskRunId>,
    pub terminal_tab_id: Option<&'a str>,
    pub terminal_session_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookReport {
    pub event_name: Option<String>,
    pub task_run_status: Option<TaskRunStatus>,
    /// An agent entered `WaitingForUser` — either the TaskRun entering edge (task tabs) or the
    /// session-level agent_status transition (any tab). Only the entering edge fires.
    pub entered_waiting_for_user: bool,
    /// The wait reason for the entering edge (from TaskRun or session, whichever fired).
    pub wait_reason: Option<TaskRunWaitReason>,
    /// The run's task title, carried only on the entering edge so a notification need not reach
    /// back into the DB for what core already resolved.
    pub task_title: Option<String>,
    pub linked_task_run_id: Option<TaskRunId>,
    pub linked_task_id: Option<TaskId>,
    pub terminal_session_id: Option<String>,
    pub agent_session_id: Option<AgentSessionId>,
    /// What the hook was launched with, for the trace line — present even when nothing resolved.
    pub identity: HookIdentity,
    pub ignored: bool,
    pub task_found: bool,
    pub task_run_linked: bool,
    pub task_run_created: bool,
    pub event_recorded: bool,
    pub unsafe_task_run_id: bool,
    /// How the run was chosen, and what each rule that declined gave as its reason (by the order in
    /// [`RULE_NAMES`]).
    pub resolved_by: HookResolveRoute,
    pub resolve_skipped: [Option<ResolveSkip>; 3],
    /// The run's status before this hook, the status the domain asked for, and the domain's reason
    /// for asking for nothing. `requested_status` differing from `task_run_status` is the store's
    /// atomic guard refusing a stale snapshot — the one refusal the domain cannot see.
    pub from_status: Option<TaskRunStatus>,
    pub requested_status: Option<TaskRunStatus>,
    pub refused: Option<TransitionRefusal>,
}

impl HookReport {
    fn ignored(identity: HookIdentity, unsafe_task_run_id: bool) -> Self {
        HookReport {
            event_name: None,
            task_run_status: None,
            entered_waiting_for_user: false,
            wait_reason: None,
            task_title: None,
            linked_task_run_id: None,
            linked_task_id: None,
            terminal_session_id: None,
            agent_session_id: None,
            identity,
            ignored: true,
            task_found: false,
            task_run_linked: false,
            task_run_created: false,
            event_recorded: false,
            unsafe_task_run_id,
            resolved_by: HookResolveRoute::Unresolved,
            resolve_skipped: [None; 3],
            from_status: None,
            requested_status: None,
            refused: None,
        }
    }

    /// The whole hook as one `key=value` line. Built on demand rather than stored: the façade fills
    /// in `event_name` for payloads the decoder dropped *after* this use case returns, and a line
    /// frozen here would report those as having no event.
    pub fn trace_line(&self) -> String {
        // The event name and the agent's session id are copied verbatim out of the hook payload's
        // JSON, so both are arbitrary text: without this a newline in either would split the
        // promised one-line record and let a payload forge a second one.
        fn opt(value: Option<&str>) -> std::borrow::Cow<'_, str> {
            value.map_or(std::borrow::Cow::Borrowed("none"), crate::observability::field)
        }
        let skipped = self
            .resolve_skipped
            .iter()
            .enumerate()
            .filter_map(|(i, skip)| skip.map(|skip| format!("{}:{skip}", RULE_NAMES[i])))
            .collect::<Vec<_>>();
        format!(
            "hook task_id={} task_run_id={} agent_session_id={} tab_id={} session_id={} event={} \
             resolved_by={} created={} skipped={} from={} requested={} to={} refused={} \
             ignored={} task_found={} run_linked={} event_recorded={} unsafe_run_id={} \
             wait_reason={} entered_waiting={}",
            opt(self.linked_task_id.as_deref().or(self.identity.task_id.as_deref())),
            opt(self
                .linked_task_run_id
                .as_deref()
                .or(self.identity.task_run_id.as_deref())),
            opt(self.agent_session_id.as_deref()),
            opt(self.identity.terminal_tab_id.as_deref()),
            opt(self.identity.terminal_session_id.as_deref()),
            opt(self.event_name.as_deref()),
            self.resolved_by.as_str(),
            self.task_run_created,
            if skipped.is_empty() { "none".to_string() } else { skipped.join(",") },
            opt(self.from_status.map(TaskRunStatus::as_str)),
            opt(self.requested_status.map(TaskRunStatus::as_str)),
            opt(self.task_run_status.map(TaskRunStatus::as_str)),
            opt(self.refused.map(TransitionRefusal::as_str)),
            self.ignored,
            self.task_found,
            self.task_run_linked,
            self.event_recorded,
            self.unsafe_task_run_id,
            opt(self.wait_reason.map(TaskRunWaitReason::as_str)),
            self.entered_waiting_for_user,
        )
    }
}

/// Apply a decoded agent [`AgentSignal`] to the run it belongs to. The agent payload was already
/// interpreted by the adapter decoder; this use case only resolves which run the signal targets,
/// asks the domain ([`TaskRun::decide`](monica_domain::TaskRun::decide)) what to record, and persists
/// it. `signal == None` means the decoder found nothing actionable (a non-blocking tool call, an
/// unparseable payload), so the hook is ignored without touching storage.
pub fn record_hook<R>(
    repos: &mut R,
    ctx: HookContext<'_>,
    agent: Agent,
    signal: Option<&AgentSignal>,
    raw_stdin: &str,
) -> ApplicationResult<HookReport>
where
    R: TaskStore + TaskRunStore + EventRepository + Clock + UnitOfWork + TerminalSessionRepository,
{
    let safe_task_run_id = ctx.task_run_id.filter(|r| is_safe_task_run_id(r.as_str()));
    let unsafe_task_run_id = ctx.task_run_id.is_some() && safe_task_run_id.is_none();

    let identity = HookIdentity::of(ctx, safe_task_run_id);

    let Some(signal) = signal else {
        return Ok(HookReport::ignored(identity, unsafe_task_run_id));
    };

    // The per-tab indicator updates for any Monica shell, task-linked or not.
    // `session_entered_waiting` detects the entering edge so notifications can fire for all tabs.
    let mut session_entered_waiting = false;
    let mut session_wait_reason: Option<TaskRunWaitReason> = None;
    let agent_session_id = signal.agent_session_id.as_ref();

    if let Some(session_id) = ctx.terminal_session_id {
        match signal.kind.agent_session_effect() {
            AgentSessionEffect::Keep => {}
            AgentSessionEffect::Clear => {
                repos.set_terminal_session_agent_status(session_id, None, None, None)?;
            }
            AgentSessionEffect::Set(status, reason) => {
                let changed = repos.set_terminal_session_agent_status(
                    session_id,
                    Some(status),
                    reason,
                    agent_session_id,
                )?;
                if changed && status == AgentSessionStatus::WaitingForUser {
                    session_entered_waiting = true;
                    session_wait_reason = reason;
                }
            }
        }
    }

    let event_label = signal.event_label.as_deref();

    let (resolved, trace) = resolve_hook_run(
        repos,
        RunLookup {
            task_id: ctx.task_id,
            explicit_run_id: safe_task_run_id,
            explicit_run_id_rejected: unsafe_task_run_id,
            agent_session_id,
            terminal_tab_id: ctx.terminal_tab_id,
            starts_session: signal.starts_session(),
            agent,
        },
    )?;
    let run_row = resolved.run;
    if let Some(run) = run_row.as_ref().filter(|_| resolved.created) {
        crate::observability::run_status(&run.id, &run.task_id, None, run.status, "hook_lazy_create");
    }
    let task_run_linked = run_row.is_some();
    let linked_task_run_id = run_row.as_ref().map(|run| &run.id);
    let linked_task_id = run_row.as_ref().map(|run| &run.task_id).or(ctx.task_id);
    let task_found = match linked_task_id {
        Some(_) if run_row.is_some() => true,
        Some(id) => repos.get_task(id)?.is_some(),
        None => false,
    };

    let at = repos.now_iso()?;
    // The full hook payload, stored verbatim (opaque RawJson). `signal` is only `Some` when the
    // decoder parsed valid JSON, so this is always valid JSON text.
    let metadata_raw = raw_stdin.trim();

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
                    agent_session_id: agent_session_id.filter(|_| plan.stamp_session),
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
    let task_run_status = landed.as_ref().map(|run| run.status);
    let from_status = run_row.as_ref().map(|run| run.status);
    if let (Some(run), Some(to)) = (landed.as_ref(), task_run_status) {
        if from_status != Some(to) {
            crate::observability::run_status(
                &run.id,
                &run.task_id,
                from_status,
                to,
                &format!("hook:{}", event_label.unwrap_or("unknown")),
            );
        }
    }
    let task_run_entered_waiting = task_run_status == Some(TaskRunStatus::WaitingForUser)
        && !run_row
            .as_ref()
            .is_some_and(|run| run.status == TaskRunStatus::WaitingForUser);
    let entered_waiting_for_user = task_run_entered_waiting || session_entered_waiting;
    let wait_reason = if task_run_entered_waiting {
        landed.as_ref().and_then(|run| run.wait_reason)
    } else {
        session_wait_reason
    };
    let task_title = match linked_task_id.filter(|_| task_run_entered_waiting) {
        Some(id) => repos.get_task(id)?.map(|task| task.title),
        None => None,
    };

    Ok(HookReport {
        event_name: signal.event_label.clone(),
        task_run_status,
        entered_waiting_for_user,
        wait_reason,
        task_title,
        linked_task_run_id: linked_task_run_id.cloned(),
        linked_task_id: linked_task_id.cloned(),
        terminal_session_id: ctx.terminal_session_id.map(str::to_string),
        agent_session_id: agent_session_id.cloned(),
        identity,
        ignored: false,
        task_found,
        task_run_linked,
        task_run_created: resolved.created,
        event_recorded,
        unsafe_task_run_id,
        resolved_by: trace.route,
        resolve_skipped: trace.skipped,
        from_status,
        requested_status: transition.map(|t| t.status),
        refused: plan.and_then(|p| p.refused),
    })
}

#[derive(Debug)]
pub(in crate::usecases) struct ResolvedRun {
    pub(in crate::usecases) run: Option<TaskRun>,
    pub(in crate::usecases) created: bool,
}

impl ResolvedRun {
    fn linked(run: Option<TaskRun>) -> Self {
        Self { run, created: false }
    }
}

/// A rule either takes the hook or names why it passed. `Result` rather than a local enum on
/// purpose: a local one holding a `TaskRun` trips `clippy::large_enum_variant`.
pub(in crate::usecases) type Resolution = Result<ResolvedRun, ResolveSkip>;

/// Which rule bound the run, plus the reason from each rule that declined before it.
pub(in crate::usecases) struct ResolveTrace {
    route: HookResolveRoute,
    skipped: [Option<ResolveSkip>; 3],
}

type ResolveRule<R> = fn(&RunResolveCtx, &mut R) -> ApplicationResult<Resolution>;

pub(in crate::usecases) struct RunResolveCtx<'a> {
    pub(in crate::usecases) task_id: &'a TaskId,
    pub(in crate::usecases) task: &'a Task,
    pub(in crate::usecases) explicit_run_id_rejected: bool,
    pub(in crate::usecases) agent_session_id: Option<&'a AgentSessionId>,
    /// Whether the signal proves a user is actively driving a session (session start / first
    /// prompt) — only such signals may claim or create a run.
    pub(in crate::usecases) starts_session: bool,
    pub(in crate::usecases) agent: Agent,
    pub(in crate::usecases) primary_run: Option<&'a TaskRun>,
}

/// Everything a hook carries about which run it belongs to, once the raw env has been validated.
/// `explicit_run_id` is the wrapper-supplied id after the safety check; `explicit_run_id_rejected`
/// says the env carried one that failed it.
struct RunLookup<'a> {
    task_id: Option<&'a TaskId>,
    explicit_run_id: Option<&'a TaskRunId>,
    explicit_run_id_rejected: bool,
    agent_session_id: Option<&'a AgentSessionId>,
    terminal_tab_id: Option<&'a str>,
    starts_session: bool,
    agent: Agent,
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
///
/// Rules 2-4 all scope their lookups by task, so a tab launched without `MONICA_TASK_ID` can never
/// reach them. Such a tab is instead resolved by the tab -> run binding `monica task attach` wrote,
/// which is also the only thing that can have created one. That binding deliberately carries none
/// of the guards above: it never creates a run, and it follows the tab regardless of which session
/// the signal came from or whether that signal starts a session. So a fresh agent started in an
/// attached tab keeps driving the same run (reviving it from `Stopped` if need be), where a task
/// tab would have lazily created a new one — the attachment is a property of the tab, not of the
/// session inside it.
fn resolve_hook_run<R>(
    repos: &mut R,
    lookup: RunLookup<'_>,
) -> ApplicationResult<(ResolvedRun, ResolveTrace)>
where
    R: TaskStore + TaskRunStore,
{
    let RunLookup {
        task_id,
        explicit_run_id,
        explicit_run_id_rejected,
        agent_session_id,
        terminal_tab_id,
        starts_session,
        agent,
    } = lookup;
    let took = |run, route| {
        Ok((
            ResolvedRun::linked(run),
            ResolveTrace { route, skipped: [None; 3] },
        ))
    };

    if let Some(run_id) = explicit_run_id {
        return took(repos.get_task_run(run_id)?, HookResolveRoute::ExplicitRunId);
    }
    let Some(task_id) = task_id else {
        let run = match terminal_tab_id {
            Some(tab_id) => repos.find_task_run_by_terminal_tab(tab_id)?,
            None => None,
        };
        return took(run, HookResolveRoute::TabBinding);
    };
    let Some(task) = repos.get_task(task_id)? else {
        return took(None, HookResolveRoute::TaskMissing);
    };

    let primary_run = match task.primary_task_run_id.as_ref() {
        Some(primary_id) => repos.get_task_run(primary_id)?,
        None => None,
    };

    let ctx = RunResolveCtx {
        task_id,
        task: &task,
        explicit_run_id_rejected,
        agent_session_id,
        starts_session,
        agent,
        primary_run: primary_run.as_ref(),
    };

    let rules: [ResolveRule<R>; 3] = [
        resolve_by_session,
        resolve_by_prepared_primary,
        resolve_by_lazy_create,
    ];
    let routes = [
        HookResolveRoute::BySession,
        HookResolveRoute::ByPreparedPrimary,
        HookResolveRoute::ByLazyCreate,
    ];
    let mut skipped = [None; 3];
    for (i, rule) in rules.iter().enumerate() {
        match rule(&ctx, repos)? {
            Ok(resolved) => return Ok((resolved, ResolveTrace { route: routes[i], skipped })),
            Err(skip) => skipped[i] = Some(skip),
        }
    }
    Ok((
        ResolvedRun::linked(None),
        ResolveTrace { route: HookResolveRoute::Unresolved, skipped },
    ))
}

pub(in crate::usecases) fn resolve_by_session<R>(
    ctx: &RunResolveCtx,
    repos: &mut R,
) -> ApplicationResult<Resolution>
where
    R: TaskStore + TaskRunStore,
{
    let Some(session_id) = ctx.agent_session_id else {
        return Ok(Err(ResolveSkip::NoSessionId));
    };
    match repos.find_task_run_by_session(ctx.task_id, session_id)? {
        Some(run) => Ok(Ok(ResolvedRun::linked(Some(run)))),
        None => Ok(Err(ResolveSkip::NoRunForSession)),
    }
}

pub(in crate::usecases) fn resolve_by_prepared_primary<R>(
    ctx: &RunResolveCtx,
    repos: &mut R,
) -> ApplicationResult<Resolution>
where
    R: TaskStore + TaskRunStore,
{
    let Some(run) = ctx.primary_run else {
        return Ok(Err(ResolveSkip::NoPrimaryRun));
    };
    if run.status != TaskRunStatus::Prepared {
        return Ok(Err(ResolveSkip::PrimaryNotPrepared(run.status)));
    }
    if !ctx.starts_session {
        return Ok(Err(ResolveSkip::NotSessionStarting));
    }
    // No session id to stamp (e.g. the Run-button flow before its first hook): nothing to claim
    // and nothing another session could clobber, so keep the snapshot behavior.
    let Some(session_id) = ctx.agent_session_id else {
        return Ok(Ok(ResolvedRun::linked(Some(run.clone()))));
    };
    // Atomic claim: only the start whose guarded UPDATE lands keeps the prepared run. A loser
    // changes 0 rows and falls through to lazy-create as a side run.
    if repos.claim_prepared_run(&run.id, session_id)? {
        // The claim only set `agent_session_id`; reflect it on the snapshot we already hold
        // (avoiding a re-read) so the observation that follows sees the claimed session.
        let mut claimed = run.clone();
        claimed.agent_session_id = Some(session_id.clone());
        Ok(Ok(ResolvedRun::linked(Some(claimed))))
    } else {
        Ok(Err(ResolveSkip::ClaimLost))
    }
}

pub(in crate::usecases) fn resolve_by_lazy_create<R>(
    ctx: &RunResolveCtx,
    repos: &mut R,
) -> ApplicationResult<Resolution>
where
    R: TaskStore + TaskRunStore,
{
    if ctx.agent_session_id.is_none() {
        return Ok(Err(ResolveSkip::NoSessionId));
    }
    if !ctx.starts_session {
        return Ok(Err(ResolveSkip::NotSessionStarting));
    }
    if ctx.explicit_run_id_rejected {
        return Ok(Err(ResolveSkip::ExplicitRunIdRejected));
    }
    if ctx.task.status == TaskStatus::Closed {
        return Ok(Err(ResolveSkip::TaskClosed));
    }

    // `make_primary_if_missing` is true exactly when no usable primary exists — including a dangling
    // pointer, which `primary_run` already resolved to `None`; otherwise the new run is a side run.
    let run = repos.create_lazy_run_for_session(
        NewTaskRun {
            task_id: ctx.task_id.clone(),
            agent: Some(ctx.agent),
            branch: None,
            worktree_path: None,
        },
        ctx.primary_run.is_none(),
    )?;
    Ok(Ok(ResolvedRun {
        run: Some(run),
        created: true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A payload cannot end the line early and start a second, forged one.
    #[test]
    fn free_form_payload_values_cannot_split_the_line() {
        let report = HookReport {
            event_name: Some("Stop\nhook task_id=MON-1 forged=true".to_string()),
            agent_session_id: Some(AgentSessionId::from_agent("sess 1\tx")),
            ..resolved_report()
        };
        let line = report.trace_line();
        assert!(!line.contains('\n'), "{line}");
        assert!(
            line.contains("agent_session_id=sess_1_x"),
            "{line}"
        );
        assert!(
            line.contains("event=Stop_hook_task_id=MON-1_forged=true"),
            "{line}"
        );
    }

    /// A hook that resolved nothing and changed nothing still prints every key, so a grep for one
    /// field never silently misses the lines where it is absent.
    #[test]
    fn a_hook_that_resolved_nothing_still_names_every_field() {
        assert_eq!(
            HookReport::ignored(HookIdentity::default(), false).trace_line(),
            "hook task_id=none task_run_id=none agent_session_id=none tab_id=none session_id=none \
             event=none resolved_by=none created=false skipped=none from=none requested=none \
             to=none refused=none ignored=true task_found=false run_linked=false \
             event_recorded=false unsafe_run_id=false wait_reason=none entered_waiting=false"
        );
    }

    fn resolved_report() -> HookReport {
        HookReport {
            event_name: Some("Stop".to_string()),
            task_run_status: Some(TaskRunStatus::WaitingForUser),
            entered_waiting_for_user: true,
            wait_reason: Some(TaskRunWaitReason::AwaitingPrompt),
            task_title: None,
            linked_task_run_id: Some(TaskRunId::from_store("run-12".to_string())),
            linked_task_id: Some(TaskId::from_store("MON-42".to_string())),
            terminal_session_id: Some("ts-1".to_string()),
            agent_session_id: Some(AgentSessionId::from_agent("sess-1")),
            identity: HookIdentity {
                task_id: Some(TaskId::from_store("MON-42".to_string())),
                task_run_id: None,
                terminal_tab_id: Some("tab-1".to_string()),
                terminal_session_id: Some("ts-1".to_string()),
            },
            ignored: false,
            task_found: true,
            task_run_linked: true,
            task_run_created: false,
            event_recorded: true,
            unsafe_task_run_id: false,
            resolved_by: HookResolveRoute::ByPreparedPrimary,
            resolve_skipped: [Some(ResolveSkip::NoRunForSession), None, None],
            from_status: Some(TaskRunStatus::Running),
            requested_status: Some(TaskRunStatus::WaitingForUser),
            refused: None,
        }
    }

    #[test]
    fn a_resolved_hook_names_the_rule_that_took_it_and_the_one_that_passed() {
        assert_eq!(
            resolved_report().trace_line(),
            "hook task_id=MON-42 task_run_id=run-12 agent_session_id=sess-1 tab_id=tab-1 \
             session_id=ts-1 event=Stop resolved_by=prepared_primary created=false \
             skipped=session:no_run_for_session from=running requested=waiting_for_user \
             to=waiting_for_user refused=none ignored=false task_found=true run_linked=true \
             event_recorded=true unsafe_run_id=false wait_reason=awaiting_prompt \
             entered_waiting=true"
        );
    }

    /// The domain refused the transition, so nothing was asked of the store and nothing landed.
    #[test]
    fn a_refused_hook_names_the_rule_that_refused_it() {
        let report = HookReport {
            task_run_status: None,
            requested_status: None,
            refused: Some(TransitionRefusal::StoppedStaysStopped),
            entered_waiting_for_user: false,
            wait_reason: None,
            resolve_skipped: [None; 3],
            resolved_by: HookResolveRoute::BySession,
            from_status: Some(TaskRunStatus::Stopped),
            ..resolved_report()
        };
        assert!(report
            .trace_line()
            .contains("from=stopped requested=none to=none refused=stopped_stays_stopped"));
    }

    /// The domain asked for a transition the store's own guard then refused — the one refusal the
    /// domain cannot see, readable only as `requested` differing from `to`.
    #[test]
    fn a_hook_the_store_guard_refused_shows_requested_apart_from_landed() {
        let report = HookReport {
            requested_status: Some(TaskRunStatus::Running),
            task_run_status: Some(TaskRunStatus::Stopped),
            refused: None,
            ..resolved_report()
        };
        assert!(report
            .trace_line()
            .contains("requested=running to=stopped refused=none"));
    }

    /// Every rule declined, so all three reasons are named in evaluation order.
    #[test]
    fn an_unresolved_hook_names_all_three_reasons() {
        let report = HookReport {
            resolved_by: HookResolveRoute::Unresolved,
            resolve_skipped: [
                Some(ResolveSkip::NoRunForSession),
                Some(ResolveSkip::PrimaryNotPrepared(TaskRunStatus::Running)),
                Some(ResolveSkip::TaskClosed),
            ],
            ..resolved_report()
        };
        assert!(report.trace_line().contains(
            "resolved_by=none created=false skipped=session:no_run_for_session,\
             prepared_primary:primary_not_prepared(running),lazy_create:task_closed"
        ));
    }
}
