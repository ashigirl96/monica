use super::{Backend, Monica};
use crate::ports::{
    AgentDecoders, ClaudeSessionRepository, ClaudeTranscriptReader, NotificationOutboxStore,
    TaskRunStore, TerminalAttachment, TerminalCreateRequest, TerminalDaemon,
    TerminalSessionRepository, WorkbenchStore,
};
use crate::usecases::runs::ports::TaskRunOutputs;
use crate::usecases::terminal::{
    reconcile_terminal_sessions, task_run_settlement_for_orphaned_run,
    task_run_settlement_for_terminal_exit, DaemonSessionView, TerminalExitSettlement,
    TerminalSessionUpdate,
};
use crate::prelude::{
    Agent, NewNotificationIntent, NewTerminalSession, NotificationKind, TaskRun, TaskRunStatus,
    TerminalSession, TerminalSessionKind, TerminalSessionStatus,
};
use monica_domain::{ClaudeSession, ClaudeSessionStatus, NewClaudeSession};
use crate::{
    ApplicationError, ApplicationEvent, ApplicationResult, ClaudeHookReport, EventSink,
    HookContext, HookReport, OpenClaudeSessionParams, PrepareTaskResult, RunTaskResult,
    ClaudeSessionSpec, TaskBench, TerminalStateSnapshot,
};

/// Run preparation/execution, agent hooks, and (in a later phase) terminal sessions. Groups the
/// `runs` and `terminal` use-case contexts because run settlement is driven by terminal state.
pub struct ExecutionService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
}

/// What one [`ExecutionService::drain_claude_session_events`] tick did.
#[derive(Debug, Clone, Default)]
pub struct ClaudeSessionDrainOutcome {
    /// Events consumed this tick.
    pub drained: usize,
    /// Sessions whose turn completed but whose transcript had nothing new yet (Claude
    /// flushes the assistant record around the Stop hook, sometimes after it) — the
    /// caller should re-poll these briefly.
    pub recheck: Vec<String>,
}

impl<B: Backend> ExecutionService<'_, B> {
    /// Phase 1 of a run: create the TaskRun, set it primary, ensure the bench exists.
    pub fn prepare_task(&mut self, task_id: &str) -> ApplicationResult<PrepareTaskResult> {
        crate::usecases::runs::start_run(&mut self.m.repos, task_id)
    }

    /// Phase 2 of a run: create the worktree and run setup. Emits the run's resulting status
    /// (the run is marked `Failed` internally on error, so a failure still notifies).
    pub fn execute_run(
        &mut self,
        task_id: &str,
        task_run_id: &str,
    ) -> ApplicationResult<TaskRunStatus> {
        let Monica { repos, git, setup, outputs, events, .. } = &mut *self.m;
        let result =
            crate::usecases::runs::execute_run(repos, git, setup, outputs, task_id, task_run_id);
        let status = match &result {
            Ok(status) => *status,
            Err(_) => TaskRunStatus::Failed,
        };
        events.emit(ApplicationEvent::TaskRunStatusChanged {
            task_id: task_id.to_string(),
            task_run_id: task_run_id.to_string(),
            status,
        });
        result
    }

    pub fn prepare_claude_for_run(
        &mut self,
        task_id: &str,
        agent_override: Option<Agent>,
    ) -> ApplicationResult<RunTaskResult> {
        let Monica { repos, outputs, .. } = &mut *self.m;
        crate::usecases::runs::prepare_claude_for_run(repos, outputs, task_id, agent_override)
    }

    pub fn open_bench(&mut self, task_id: &str) -> ApplicationResult<TaskBench> {
        let Monica { repos, outputs, .. } = &mut *self.m;
        crate::usecases::runs::open_bench(repos, outputs, task_id)
    }

    pub fn task_shell_env(&self, task_id: &str) -> ApplicationResult<Vec<(String, String)>> {
        crate::usecases::runs::task_shell_env(&self.m.repos, &self.m.outputs, task_id)
    }

    pub fn list_bench_runspace_map(&self) -> ApplicationResult<Vec<(String, String)>> {
        Ok(self.m.repos.list_bench_runspace_map()?)
    }

    /// Decode a raw agent hook payload, record the resulting signal, and — on the entering edge
    /// into `WaitingForUser` — emit [`ApplicationEvent::AwaitingUserInput`] so drivers can surface a
    /// notification. Decoding happens behind the façade via [`Backend::Agents`], so drivers hand in
    /// raw bytes and never touch the per-agent decoders. `raw_stdin` is also stored verbatim.
    pub fn ingest_agent_hook(
        &mut self,
        agent: Agent,
        ctx: HookContext<'_>,
        raw_stdin: &str,
    ) -> ApplicationResult<HookReport> {
        let Monica { repos, outputs, events, agents, .. } = &mut *self.m;
        let signal = agents.decode(agent, raw_stdin.as_bytes())?;
        let mut report =
            crate::usecases::runs::record_hook(repos, outputs, ctx, agent, signal.as_ref(), raw_stdin)?;
        // A dropped event (a non-blocking tool call) carries no signal; recover its provider name
        // here so the driver's debug log need not reach back into the decoders.
        if report.event_name.is_none() {
            report.event_name = agents.event_label(raw_stdin.as_bytes());
        }
        if let (Some(ref run_id), Some(status)) =
            (&report.linked_task_run_id, report.task_run_status)
        {
            if status != TaskRunStatus::WaitingForUser {
                let _ = repos.cancel_notifications_for_run(run_id);
            }
        }
        if report.entered_waiting_for_user {
            events.emit(ApplicationEvent::AwaitingUserInput {
                task_id: report.linked_task_id.clone(),
                task_run_id: report.linked_task_run_id.clone(),
                reason: report.task_run_wait_reason,
                task_title: report.task_title.clone(),
            });
            if let Some(ref run_id) = report.linked_task_run_id {
                let body = crate::notification::waiting_notification(
                    report.task_run_wait_reason,
                    report.task_title.as_deref(),
                );
                let intent = NewNotificationIntent {
                    dedupe_key: format!("awaiting_user_input:{run_id}"),
                    kind: NotificationKind::AwaitingUserInput,
                    title: crate::notification::TITLE.to_string(),
                    body,
                    task_id: report.linked_task_id.clone(),
                    task_run_id: Some(run_id.clone()),
                };
                if let Err(e) = repos.enqueue_notification(intent) {
                    log::warn!(target: "monica_app::notify", "failed to enqueue notification: {e}");
                }
            }
        }
        Ok(report)
    }

    /// Create a terminal session row, then ask the daemon to spawn it. On spawn failure the
    /// session is marked `Failed` and any run waiting on this tab is settled now (rather than left
    /// to the sweep). The session is returned regardless so the frontend can bind it to its tab.
    ///
    /// An `Err` never leaves a live PTY behind: failures after a successful spawn (recording the
    /// start, reloading the row) kill the process before returning. A live row stuck at `Starting`
    /// would otherwise leak forever — reconcile deliberately skips it, trusting the create call
    /// that just died here to own that transition.
    pub fn create_terminal_session(
        &mut self,
        daemon: &impl TerminalDaemon,
        new: NewTerminalSession,
        mut env: Vec<(String, String)>,
    ) -> ApplicationResult<TerminalSession> {
        let tab_id = new.tab_id.clone();
        let cwd = new.cwd.clone();
        let shell = new.shell.clone();
        let rows = new.rows;
        let cols = new.cols;

        let session = self.m.repos.create_terminal_session(new)?;

        // The hook chain (shell → claude → monica hook) inherits these, letting hooks stamp the
        // tab onto the TaskRun for tab-based Make Main; the session id rides along for future
        // session-scoped lookups.
        if let Some(tab_id) = tab_id {
            env.push(("MONICA_TERMINAL_TAB_ID".to_string(), tab_id));
        }
        env.push(("MONICA_TERMINAL_SESSION_ID".to_string(), session.id.clone()));

        let request = TerminalCreateRequest {
            session_id: session.id.clone(),
            cwd,
            shell,
            rows,
            cols,
            env,
        };
        let mut pty_live = false;
        match daemon.create(request) {
            Ok(pid) => {
                if let Err(e) = self.m.repos.mark_terminal_session_started(&session.id, pid) {
                    self.roll_back_live_session(daemon, &session.id);
                    return Err(e.into());
                }
                pty_live = true;
            }
            Err(e) => {
                log::warn!(
                    target: "monica_application::terminal",
                    "failed to start terminal session {}: {e:#}",
                    session.id
                );
                // Settle regardless, but surface a failed status write rather than swallowing it.
                if let Err(e) = self.m.repos.update_terminal_session_status(
                    &session.id,
                    TerminalSessionStatus::Failed,
                    None,
                ) {
                    log::error!(
                        target: "monica_application::terminal",
                        "failed to mark session {} failed: {e}",
                        session.id
                    );
                }
                self.settle_runs_for_terminated_sessions(std::slice::from_ref(&session.id));
            }
        }

        let result = self.m.repos.get_terminal_session(&session.id);
        if pty_live && !matches!(result, Ok(Some(_))) {
            self.roll_back_live_session(daemon, &session.id);
        }
        match result {
            Ok(Some(row)) => Ok(row),
            Ok(None) => Err(ApplicationError::not_found(format!(
                "terminal session {} vanished",
                session.id
            ))),
            Err(e) => Err(e.into()),
        }
    }

    /// Create a Claude Code session in the permanent "agent-runtime" runspace: pre-mint the Claude session
    /// id and the tab id, spawn the shell through the daemon, submit the launch command into its
    /// PTY, and only then announce the session for Workbench adoption. Transactional from the
    /// caller's view — a determinately failed launch tears the session down and returns an
    /// error, so a retry can never stack a second live session on a half-open one. When neither
    /// the launch nor a kill can be confirmed (the daemon dying mid-open), the error is
    /// [`ApplicationError::Indeterminate`] and the pending reservation stays, so the id keeps
    /// refusing non-idempotent reuse. No webview involvement anywhere.
    pub fn open_claude_session(
        &mut self,
        daemon: &impl TerminalDaemon,
        params: OpenClaudeSessionParams,
    ) -> ApplicationResult<ClaudeSessionSpec> {
        // Idempotent recovery runs before cwd validation: a retry must be able to recover
        // a running session even if its cwd has since been deleted.
        if let Some(id) = &params.claude_session_id {
            if uuid::Uuid::parse_str(id).is_err() {
                // The id is interpolated into a shell command line; reject anything that
                // is not literally a UUID.
                return Err(ApplicationError::validation(format!(
                    "claude_session_id must be a UUID: {id}"
                )));
            }
            if let Some(spec) = self.recover_claude_session(daemon, id, params.model.as_deref())? {
                return Ok(spec);
            }
        }

        // Relative paths would resolve against the app process, not the Agent Runtime caller that
        // sent the request — an IPC boundary must not guess whose cwd "." means.
        let cwd_path = std::path::Path::new(&params.cwd);
        if !cwd_path.is_absolute() {
            return Err(ApplicationError::validation(format!(
                "cwd must be an absolute path: {}",
                params.cwd
            )));
        }
        if !cwd_path.is_dir() {
            return Err(ApplicationError::validation(format!(
                "cwd is not an existing directory: {}",
                params.cwd
            )));
        }

        // Claude loads hooks from <cwd>/.claude/settings.local.json at startup, so they
        // must be on disk before the spawn. No side effect has happened yet, so a failure
        // here is determinate and a same-id retry stays safe.
        self.m
            .outputs
            .install_agent_hooks(Agent::Claude, cwd_path)
            .map_err(|e| {
                ApplicationError::external(format!(
                    "failed to install claude hooks into {}: {e:#}; nothing was launched, \
                     so retrying is safe",
                    params.cwd
                ))
            })?;

        let claude_session_id = params
            .claude_session_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let tab_id = uuid::Uuid::new_v4().to_string();
        let initial_command =
            crate::claude_runtime::claude_runtime_initial_command(&claude_session_id, params.model.as_deref());
        let env = vec![(
            crate::MONICA_CLAUDE_SESSION_ID_ENV.to_string(),
            claude_session_id.clone(),
        )];

        let new = NewTerminalSession {
            runspace_id: Some(crate::agent_runtime_runspace_id().to_string()),
            tab_id: Some(tab_id.clone()),
            kind: TerminalSessionKind::Agent,
            cwd: params.cwd.clone(),
            shell: params.shell,
            // Placeholder geometry until a Workbench pane attaches and fits the terminal.
            rows: 24,
            cols: 80,
        };
        let session = self.create_terminal_session(daemon, new, env)?;
        // A spawn failure comes back as Ok(status=Failed), not Err — surface it as an error
        // here so the caller never announces or launches into a dead session.
        if session.status == TerminalSessionStatus::Failed {
            return Err(ApplicationError::external(format!(
                "terminal session {} failed to start",
                session.id
            )));
        }

        // Reserve the mapping BEFORE the launch touches the PTY: the reservation is the
        // idempotency lock, so it must exist before the side effect it deduplicates. A
        // crash past this point leaves a pending row that refuses automatic reuse of the
        // id; a crash before it leaves an unmapped shell that never launched Claude, so a
        // same-id retry opening fresh is still correct. A concurrent open racing this id
        // loses here on the primary key — before its own launch write — tears down only
        // its Claude-less shell, and answers from the winner's mapping below.
        if let Err(e) = self.m.repos.create_claude_session(NewClaudeSession {
            claude_session_id: claude_session_id.clone(),
            runspace_id: crate::agent_runtime_runspace_id().to_string(),
            tab_id: tab_id.clone(),
            terminal_session_id: session.id.clone(),
            cwd: params.cwd.clone(),
            name: params.title.clone(),
        }) {
            // Rollback outcome is irrelevant here even when the kill is unconfirmed: the
            // launch was never submitted, so whatever survives in that PTY is a plain
            // shell, not a session under this id.
            self.roll_back_live_session(daemon, &session.id);
            // Losing the reservation is determinate for THIS spawn, but not for the
            // logical open: the usual loser lost a same-id race, and the winner's
            // session is exactly what the caller asked for. Answer from the mapping —
            // resolve to an active winner, report an in-flight (pending) one as unknown
            // — instead of a determinate error that would license a duplicating
            // fresh-id retry.
            return match self.recover_claude_session(daemon, &claude_session_id, params.model.as_deref())
            {
                Ok(Some(spec)) => Ok(spec),
                // No mapping after all: the failure wasn't a duplicate (or the
                // concurrent open already failed and freed the id), so nothing runs
                // under this id.
                Ok(None) => Err(ApplicationError::external(format!(
                    "failed to reserve the claude session mapping for session {}: {e:#}; \
                     the launch was never submitted and no other open holds this id, so \
                     retrying is safe",
                    session.id
                ))),
                Err(recover_err) => Err(recover_err),
            };
        }

        // Stamp the launch attempt BEFORE it goes out: a pending row still in `reserved`
        // phase provably never received a launch, which is what lets a stale one be
        // reclaimed automatically instead of stranding the id forever.
        let stamped = self.m.repos.mark_claude_session_submitting(&claude_session_id);
        if !matches!(stamped, Ok(true)) {
            // No launch was attempted, so whatever survives in that PTY is a plain
            // shell — determinate, and the reservation is freed best-effort (a row left
            // behind is a reserved-phase pending that later reclaims itself).
            self.roll_back_live_session(daemon, &session.id);
            if let Err(e) = self.m.repos.delete_claude_session(&claude_session_id) {
                log::error!(
                    target: "monica_application::agent_runtime",
                    "failed to delete the unstamped reservation {claude_session_id}: {e}"
                );
            }
            let detail = match stamped {
                Err(e) => format!("{e:#}"),
                _ => "the reservation was no longer in its reserved phase".to_string(),
            };
            return Err(ApplicationError::external(format!(
                "failed to stamp the launch attempt for session {}: {detail}; the launch \
                 was never submitted, so retrying is safe",
                session.id
            )));
        }

        if let Err(e) = daemon.write_input(&session.id, format!("{initial_command}\r").as_bytes())
        {
            // The write is an acknowledged round trip and the daemon writes into the PTY
            // before answering, so this Err does not prove the launch bytes never arrived
            // — a timeout or dropped connection can lose only the ack. Whether "nothing
            // runs under this id" is true hinges on the kill being confirmed.
            if self.roll_back_live_session(daemon, &session.id) {
                // Verifiably dead — but killing the PTY rolls back the process, not
                // Claude's external side effects: a transcript keyed by this id may
                // already exist, so the id is never freed for reuse. The rollback's
                // coupled transition left an ended tombstone that refuses it, and a
                // fresh id is the safe way forward.
                return Err(ApplicationError::external(format!(
                    "failed to submit the claude launch into session {}: {e:#}; the \
                     session was terminated and claude_session_id {claude_session_id} is \
                     retired (claude may have left artifacts under it) — open a new \
                     session with a fresh id",
                    session.id
                )));
            }
            // Unconfirmed kill: the PTY may be alive with the launch landed. The pending
            // reservation stays — it refuses non-idempotent reuse — and the outcome is
            // reported as unknown so the Agent Runtime client keeps its typed retry key.
            return Err(ApplicationError::indeterminate(format!(
                "failed to submit the claude launch into session {} and the daemon could \
                 not confirm a kill: {e:#}; the session may be running under \
                 claude_session_id {claude_session_id} — retry with this same id or check \
                 the Workbench",
                session.id
            )));
        }

        match self.m.repos.mark_claude_session_launched(&claude_session_id) {
            Ok(true) => {}
            // The PTY settled before the launch was confirmed (a write into a dead session
            // is a silent no-op), so nothing runs under this id — fail the open. The
            // launch write WAS acknowledged though, so claude may have left artifacts
            // under the id: the ended tombstone stays, refusing reuse.
            Ok(false) => {
                self.roll_back_live_session(daemon, &session.id);
                return Err(ApplicationError::external(format!(
                    "terminal session {} exited before the claude launch was confirmed; \
                     claude_session_id {claude_session_id} is retired — open a new \
                     session with a fresh id",
                    session.id
                )));
            }
            // The launch IS submitted and acknowledged here; only the pending→active
            // write failed. A confirmed kill collapses that back to "nothing left
            // behind"; without one Claude is likely running, so the reservation must
            // survive and the outcome stays unknown.
            Err(e) => {
                if self.roll_back_live_session(daemon, &session.id) {
                    // Observed dead, but the acknowledged launch may have left claude
                    // artifacts under the id: the ended tombstone stays, refusing reuse.
                    return Err(ApplicationError::external(format!(
                        "failed to confirm the claude launch for session {}: {e:#}; the \
                         session was terminated and claude_session_id {claude_session_id} \
                         is retired — open a new session with a fresh id",
                        session.id
                    )));
                }
                return Err(ApplicationError::indeterminate(format!(
                    "failed to confirm the claude launch for session {} and the daemon \
                     could not confirm a kill: {e:#}; the session may be running under \
                     claude_session_id {claude_session_id} — retry with this same id or \
                     check the Workbench",
                    session.id
                )));
            }
        }

        let spec = ClaudeSessionSpec {
            runspace_id: crate::agent_runtime_runspace_id().to_string(),
            tab_id,
            session_id: session.id,
            claude_session_id,
            cwd: params.cwd,
            initial_command,
            title: params.title,
        };
        self.m.events.emit(ApplicationEvent::ClaudeSessionOpened {
            runspace_id: spec.runspace_id.clone(),
            tab_id: spec.tab_id.clone(),
            session_id: spec.session_id.clone(),
            claude_session_id: spec.claude_session_id.clone(),
            cwd: spec.cwd.clone(),
            title: spec.title.clone(),
        });
        Ok(spec)
    }

    /// Best-effort teardown of a spawned session that its creation flow can no longer vouch for
    /// (the start couldn't be recorded, or the launch's fate is unknown): kill the process,
    /// settle the row as Failed, and settle any run waiting on its tab, so nothing adoptable or
    /// retriable lingers. Returns whether the death was actually OBSERVED, not merely requested
    /// — `terminate`'s ack only proves the kill was dispatched, so this re-reads the daemon's
    /// view until the session stops reporting running. On `false` the process may still be
    /// alive and NOTHING is written: marking the row Failed would end its Claude mapping via
    /// the coupled transition, collapsing a genuinely unknown outcome into a determinate
    /// "ended" — reconcile settles the row once the daemon reports honestly again. The kill
    /// still comes before the Failed write — if the DB is the thing failing, that write fails
    /// too, and only a dead PTY lets reconcile settle the row later.
    fn roll_back_live_session(&mut self, daemon: &impl TerminalDaemon, session_id: &str) -> bool {
        if let Err(e) = daemon.terminate(session_id) {
            log::warn!(
                target: "monica_application::terminal",
                "failed to terminate rolled-back session {session_id}; leaving it for \
                 reconcile: {e:#}"
            );
            return false;
        }
        if !Self::kill_observed(daemon, session_id) {
            log::warn!(
                target: "monica_application::terminal",
                "session {session_id} still reported running after terminate; leaving it \
                 for reconcile"
            );
            return false;
        }
        if let Err(e) = self.m.repos.update_terminal_session_status(
            session_id,
            TerminalSessionStatus::Failed,
            None,
        ) {
            log::error!(
                target: "monica_application::terminal",
                "failed to mark rolled-back session {session_id} failed: {e}"
            );
        }
        self.settle_runs_for_terminated_sessions(&[session_id.to_string()]);
        true
    }

    /// Watch the daemon's own view until `session_id` stops reporting running (absent counts
    /// as reaped, equally dead). The daemon flips a session to not-running only after its wait
    /// thread reaps the child and the output pipeline drains — a drain that a survivor holding
    /// the PTY stalls (`EXIT_DRAIN_TIMEOUT`, 500ms), which is precisely the case that must NOT
    /// pass as verified. The window is sized past that stall so an ordinary kill converges and
    /// a survivor times out into `false`.
    fn kill_observed(daemon: &impl TerminalDaemon, session_id: &str) -> bool {
        const ATTEMPTS: u32 = 15;
        const INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(INTERVAL);
            }
            match daemon.list_views() {
                Ok(views) => {
                    if !views.iter().any(|v| v.session_id == session_id && v.running) {
                        return true;
                    }
                }
                // Unreachable daemon: death cannot be observed at all.
                Err(_) => return false,
            }
        }
        false
    }

    /// Resolve a client-supplied claude_session_id to its existing session, if the id is
    /// already mapped. `Ok(None)` means unmapped (or a stale never-launched reservation
    /// that was just reclaimed) — the caller proceeds with a fresh open under that id.
    /// Any other mapped state resolves to the live session or errors, so a retry can
    /// never stack a second session on the same id. Once a possibly-live mapping is in
    /// play, every infrastructure failure in here is classified indeterminate: a
    /// determinate error would read as "nothing exists under this id" and license a
    /// duplicating fresh-id retry.
    fn recover_claude_session(
        &mut self,
        daemon: &impl TerminalDaemon,
        claude_session_id: &str,
        model: Option<&str>,
    ) -> ApplicationResult<Option<ClaudeSessionSpec>> {
        let unverified = |what: &str, e: anyhow::Error| {
            ApplicationError::indeterminate(format!(
                "cannot verify claude session {claude_session_id} ({what}): {e:#}; the \
                 session may still be running — retry with this same id or check the \
                 Workbench"
            ))
        };
        let Some(row) = self
            .m
            .repos
            .get_claude_session(claude_session_id)
            .map_err(|e| unverified("reading the mapping failed", e))?
        else {
            return Ok(None);
        };
        if row.status == ClaudeSessionStatus::Ended {
            return Err(ApplicationError::validation(format!(
                "claude session {claude_session_id} already ended and cannot be reused; \
                 open a new session with a fresh id"
            )));
        }

        // Re-verify liveness before answering "already running": an active mapping may be
        // stale if the PTY died while nothing reconciled. An unreachable daemon is
        // indeterminate, not a plain failure — Claude may already be running under this
        // id, and a determinate error would license a fresh-id retry that duplicates it.
        let views = daemon
            .list_views()
            .map_err(|e| unverified("the terminal daemon is unreachable", e))?;
        match self
            .m
            .repos
            .get_terminal_session(&row.terminal_session_id)
            .map_err(|e| unverified("reading its terminal session failed", e))?
        {
            Some(ts_row) => {
                let outcome = reconcile_terminal_sessions(std::slice::from_ref(&ts_row), &views);
                let terminated: Vec<String> = outcome
                    .updates
                    .iter()
                    .filter(|u| u.status.is_terminal())
                    .map(|u| u.session_id.clone())
                    .collect();
                self.m
                    .repos
                    .apply_terminal_session_updates(&outcome.updates)
                    .map_err(|e| unverified("recording its liveness failed", e))?;
                self.settle_runs_for_terminated_sessions(&terminated);
                for session_id in outcome.reap_ids {
                    daemon.reap(&session_id);
                }
            }
            None => {
                // The terminal row is gone; push a Lost update through the funnel so the
                // coupled transition ends this mapping, then refuse below.
                self.m
                    .repos
                    .apply_terminal_session_updates(&[TerminalSessionUpdate {
                        session_id: row.terminal_session_id.clone(),
                        status: TerminalSessionStatus::Lost,
                        pid: None,
                        exit_code: None,
                    }])
                    .map_err(|e| unverified("recording its lost terminal failed", e))?;
            }
        }

        let row = self
            .m
            .repos
            .get_claude_session(claude_session_id)
            .map_err(|e| unverified("re-reading the mapping failed", e))?
            .ok_or_else(|| {
                // Deleted concurrently — only rollback paths that proved no launch (or an
                // observed death) free an id, so nothing runs under it.
                ApplicationError::not_found(format!(
                    "claude session {claude_session_id} vanished during recovery"
                ))
            })?;
        match row.status {
            ClaudeSessionStatus::Ended => {
                return Err(ApplicationError::validation(format!(
                    "claude session {claude_session_id} is no longer running and cannot be \
                     reused; open a new session with a fresh id"
                )));
            }
            // A reservation whose launch was never confirmed — an open in flight, or a
            // crash leftover. The launch phase and the row's age decide which.
            ClaudeSessionStatus::Pending => {
                return self.resolve_pending_reservation(daemon, &row);
            }
            ClaudeSessionStatus::Active => {}
        }

        let spec = ClaudeSessionSpec {
            runspace_id: row.runspace_id,
            tab_id: row.tab_id,
            session_id: row.terminal_session_id,
            claude_session_id: row.claude_session_id,
            cwd: row.cwd,
            // Informational only — the original launch already ran; this is not re-executed.
            initial_command: crate::claude_runtime::claude_runtime_initial_command(claude_session_id, model),
            title: row.name,
        };
        // Re-announce so a Workbench that missed the original event adopts the tab now.
        // Adoption dedupes on the terminal session id, so a repeat is a no-op there.
        self.m.events.emit(ApplicationEvent::ClaudeSessionOpened {
            runspace_id: spec.runspace_id.clone(),
            tab_id: spec.tab_id.clone(),
            session_id: spec.session_id.clone(),
            claude_session_id: spec.claude_session_id.clone(),
            cwd: spec.cwd.clone(),
            title: spec.title.clone(),
        });
        Ok(Some(spec))
    }

    /// How long an unconfirmed reservation is presumed to belong to an open still in
    /// flight. A live open spans one launch write (sub-second) inside a connection whose
    /// client gives up after 10s, so a pending row past this age is a crash leftover and
    /// eligible for reclamation; under it, retries stay indeterminate rather than risk
    /// sabotaging the open that owns the row.
    const PENDING_RESERVATION_LEASE_SECS: i64 = 60;

    /// How long an `active` row may sit without a SessionStart hook observation before
    /// the launch is judged stalled (hooks broken / not installed). Claude normally sends
    /// SessionStart within seconds of boot; age is measured from `created_at` — the
    /// pending phase it includes is sub-second, so no separate launched_at stamp is kept.
    const LAUNCH_HOOK_OBSERVATION_LEASE_SECS: i64 = 30;

    /// Bounded recovery for a pending (unconfirmed-launch) reservation, so a crash can
    /// never strand the idempotency key forever. Within the lease: indeterminate (an open
    /// may be in flight). Past it, by launch phase: `reserved` provably never received a
    /// launch — the row is freed and `Ok(None)` lets the caller open fresh under the id;
    /// `submitting` may have launched — reclaimed only through observed death of its
    /// terminal, which ends the mapping and makes "use a fresh id" a safe, determinate
    /// answer.
    fn resolve_pending_reservation(
        &mut self,
        daemon: &impl TerminalDaemon,
        row: &monica_domain::ClaudeSession,
    ) -> ApplicationResult<Option<ClaudeSessionSpec>> {
        let id = &row.claude_session_id;
        let indeterminate = |detail: String| {
            ApplicationError::indeterminate(format!(
                "claude session {id} has an unconfirmed launch ({detail}); retry with \
                 this same id, or check its tab in the Workbench — do not open a fresh \
                 id for the same logical session"
            ))
        };
        let age = self
            .m
            .repos
            .claude_session_age_seconds(id)
            .map_err(|e| indeterminate(format!("and reading its age failed: {e:#}")))?
            .unwrap_or(0);
        if age < Self::PENDING_RESERVATION_LEASE_SECS {
            return Err(indeterminate(
                "an open is in flight or was interrupted moments ago".to_string(),
            ));
        }
        match row.launch_phase {
            // The submitting stamp precedes any launch write, so this stale shell never
            // received one: nothing runs under the id. Free it and open fresh; the kill
            // is best-effort tidying of the leftover shell.
            monica_domain::ClaudeLaunchPhase::Reserved => {
                self.roll_back_live_session(daemon, &row.terminal_session_id);
                self.m
                    .repos
                    .delete_claude_session(id)
                    .map_err(|e| indeterminate(format!("and freeing the stale reservation \
                         failed: {e:#}")))?;
                Ok(None)
            }
            // The launch may have gone out; only an observed death of the terminal makes
            // the outcome determinate. Pending rows are never announced or adopted, so
            // no user-visible tab is being killed here.
            monica_domain::ClaudeLaunchPhase::Submitting => {
                if self.roll_back_live_session(daemon, &row.terminal_session_id) {
                    Err(ApplicationError::validation(format!(
                        "claude session {id} was a stale unconfirmed launch; its terminal \
                         was terminated and the mapping ended — open a new session with a \
                         fresh id"
                    )))
                } else {
                    Err(indeterminate(
                        "a stale launch whose terminal could not be confirmed dead"
                            .to_string(),
                    ))
                }
            }
        }
    }

    /// The Claude session mappings, with terminal sessions reconciled against the daemon
    /// first so `status` reflects a fresh liveness check (a mapping whose PTY died flips
    /// to ended via the coupled transition before this returns). Fails closed when the
    /// daemon cannot answer: startup recovery adopts rows still `active` as live Workbench
    /// tabs, so DB-only state must never be served as if it were verified.
    pub fn list_claude_sessions(
        &mut self,
        daemon: &impl TerminalDaemon,
    ) -> ApplicationResult<Vec<ClaudeSession>> {
        let views = daemon.list_views().map_err(|e| {
            ApplicationError::external(format!(
                "cannot verify claude sessions against the terminal daemon: {e:#}"
            ))
        })?;
        self.reconcile_terminal_rows(daemon, &views)?;
        Ok(self.m.repos.list_claude_sessions()?)
    }

    pub fn claude_session_stuck_launching(
        &self,
        row: &ClaudeSession,
    ) -> ApplicationResult<bool> {
        if row.status != monica_domain::ClaudeSessionStatus::Active
            || row.provider_session_id.is_some()
        {
            return Ok(false);
        }
        let age = self
            .m
            .repos
            .claude_session_age_seconds(&row.claude_session_id)?
            .unwrap_or(0);
        Ok(age >= Self::LAUNCH_HOOK_OBSERVATION_LEASE_SECS)
    }

    /// Submit one user message into an idle Claude session's PTY. The atomic claim
    /// (idle → thinking) is the whole in-flight lock: of two concurrent senders exactly
    /// one wins, and the loser gets `Conflict` without touching the PTY. Errors:
    /// `Conflict` while a message is in flight, the user's input is awaited, or the
    /// session has not proven ready (no hook observed yet); `NotFound` for an unknown id;
    /// `Validation` for an ended session.
    ///
    /// The claim is optimistic — the PromptSubmitted hook re-asserts `thinking` moments
    /// later, harmlessly. Human input is deliberately NOT excluded: a person typing into
    /// the same PTY coexists with this API, which only re-derives state from hooks.
    pub fn send_claude_user_message(
        &mut self,
        daemon: &impl TerminalDaemon,
        claude_session_id: &str,
        text: &str,
    ) -> ApplicationResult<()> {
        use crate::ports::ClaudePromptClaim;
        match self.m.repos.claim_claude_session_thinking(claude_session_id)? {
            ClaudePromptClaim::Claimed => {}
            ClaudePromptClaim::Busy(status) => {
                return Err(ApplicationError::conflict(format!(
                    "claude session {claude_session_id} is busy ({}): one message may be \
                     in flight per session",
                    status.as_str()
                )));
            }
            ClaudePromptClaim::Launching { active_without_hook_for_secs } => {
                if active_without_hook_for_secs
                    .is_some_and(|age| age >= Self::LAUNCH_HOOK_OBSERVATION_LEASE_SECS)
                {
                    let age = active_without_hook_for_secs.unwrap();
                    log::warn!(
                        target: "monica_application::agent_runtime",
                        "claude session {claude_session_id} has been active for {age}s \
                         with no SessionStart hook observed; hooks appear broken or not \
                         installed"
                    );
                    return Err(ApplicationError::external(format!(
                        "claude session {claude_session_id} has been active for {age}s \
                         with no SessionStart hook observed; hooks appear broken or not \
                         installed — restart the session"
                    )));
                }
                return Err(ApplicationError::conflict(format!(
                    "claude session {claude_session_id} is still launching; wait for it \
                     to report idle"
                )));
            }
            ClaudePromptClaim::Ended => {
                return Err(ApplicationError::validation(format!(
                    "claude session {claude_session_id} has ended"
                )));
            }
            ClaudePromptClaim::NotFound => {
                return Err(ApplicationError::not_found(format!(
                    "claude session {claude_session_id} not found"
                )));
            }
        }
        let row = self.m.repos.get_claude_session(claude_session_id)?.ok_or_else(|| {
            ApplicationError::external(format!(
                "claude session {claude_session_id} vanished after its claim"
            ))
        })?;
        let paste = monica_terminal_protocol::bracketed_paste_bytes(text);
        let submit = daemon.write_input(&row.terminal_session_id, &paste).and_then(|()| {
            std::thread::sleep(monica_terminal_protocol::SUBMIT_DELAY);
            daemon.write_input(&row.terminal_session_id, b"\r")
        });
        if let Err(e) = submit {
            // Release only a still-thinking row: a state a hook already moved on (the
            // paste may have landed despite the failed ack) must not be overwritten. A
            // failed release is logged, not fatal — the next hook self-corrects it.
            if let Err(release_err) =
                self.m.repos.release_claude_session_thinking(claude_session_id)
            {
                log::error!(
                    target: "monica_application::claude_session",
                    "failed to release the claim on {claude_session_id}: {release_err:#}"
                );
            }
            return Err(ApplicationError::external(format!(
                "failed to write the message into session {}: {e:#}; whether it reached \
                 claude is unknown — do not blindly resend",
                row.terminal_session_id
            )));
        }
        self.m.events.emit(ApplicationEvent::ClaudeSessionStateChanged {
            claude_session_id: row.claude_session_id,
            tab_id: row.tab_id,
            session_status: row.status,
            conversation_status: monica_domain::ClaudeConversationStatus::Thinking,
            wait_reason: None,
        });
        Ok(())
    }

    /// Send ESC into the session's PTY to stop the current turn, then optimistically
    /// settle a thinking claim back to idle. The optimism is load-bearing: Claude Code
    /// fires no Stop hook on a user interrupt, so waiting for hooks would leave the
    /// conversation stuck at `thinking` and every future send rejected as Busy. If the
    /// ESC did not actually land, the next hook overwrites the state anyway.
    pub fn interrupt_claude_session(
        &mut self,
        daemon: &impl TerminalDaemon,
        claude_session_id: &str,
    ) -> ApplicationResult<()> {
        let Some(row) = self.m.repos.get_claude_session(claude_session_id)? else {
            return Err(ApplicationError::not_found(format!(
                "claude session {claude_session_id} not found"
            )));
        };
        match row.status {
            ClaudeSessionStatus::Active => {}
            ClaudeSessionStatus::Ended => {
                return Err(ApplicationError::validation(format!(
                    "claude session {claude_session_id} has ended"
                )));
            }
            ClaudeSessionStatus::Pending => {
                return Err(ApplicationError::conflict(format!(
                    "claude session {claude_session_id} is still launching"
                )));
            }
        }
        daemon.write_input(&row.terminal_session_id, b"\x1b").map_err(|e| {
            ApplicationError::external(format!(
                "failed to write the interrupt into session {}: {e:#}",
                row.terminal_session_id
            ))
        })?;
        self.m.repos.release_claude_session_thinking(claude_session_id)?;
        let settled = self.m.repos.get_claude_session(claude_session_id)?.unwrap_or(row);
        self.m.events.emit(ApplicationEvent::ClaudeSessionStateChanged {
            claude_session_id: settled.claude_session_id,
            tab_id: settled.tab_id,
            session_status: settled.status,
            conversation_status: settled.conversation_status,
            wait_reason: settled.wait_reason,
        });
        Ok(())
    }

    /// Record a hook for a Claude Runtime session (env `MONICA_CLAUDE_SESSION_ID`
    /// present, no task context). DB-only by design: the hook runs in a short-lived CLI
    /// process whose EventSink is a no-op, so UI delivery happens when the desktop drain
    /// worker consumes the outbox rows this writes.
    pub fn ingest_claude_session_hook(
        &mut self,
        agent: Agent,
        claude_session_id: &str,
        raw_stdin: &str,
    ) -> ApplicationResult<ClaudeHookReport> {
        let Monica { repos, agents, .. } = &mut *self.m;
        let signal = agents.decode(agent, raw_stdin.as_bytes())?;
        let mut report = crate::usecases::claude_sessions::record_claude_session_hook(
            repos,
            claude_session_id,
            signal.as_ref(),
            raw_stdin,
        )?;
        if report.event_name.is_none() {
            report.event_name = agents.event_label(raw_stdin.as_bytes());
        }
        Ok(report)
    }

    /// One drain tick: consume pending `claude_session_events`, emit a state snapshot per
    /// touched session, and read the transcript JSONL for sessions whose turn completed
    /// (or ended). Events are always consumed — a turn whose assistant record was not
    /// flushed yet lands in `recheck`, and the caller re-polls those briefly; the
    /// persisted offset guarantees the next completed turn catches up anything missed.
    pub fn drain_claude_session_events(
        &mut self,
        home: &std::path::Path,
        limit: usize,
    ) -> ApplicationResult<ClaudeSessionDrainOutcome> {
        let events = self.m.repos.list_unconsumed_claude_session_events(limit)?;
        if events.is_empty() {
            return Ok(ClaudeSessionDrainOutcome::default());
        }
        let mut session_ids: Vec<&str> = Vec::new();
        for event in &events {
            if !session_ids.contains(&event.claude_session_id.as_str()) {
                session_ids.push(&event.claude_session_id);
            }
        }
        let mut recheck = Vec::new();
        for session_id in session_ids {
            let Some(row) = self.m.repos.get_claude_session(session_id)? else {
                continue;
            };
            let turn_landed = events.iter().any(|event| {
                event.claude_session_id == *session_id
                    && matches!(event.kind.as_str(), "turn_completed" | "session_ended")
            });
            // Messages before the state snapshot: a subscriber treating Idle as "the turn
            // is over" should already hold the turn's assistant output when it arrives
            // (best effort — a recheck flush still lands after). The state is emitted
            // even when the transcript read fails.
            if turn_landed {
                // A transcript read failure must not abort the batch: the events are
                // already durable, so we still consume them below and let the persisted
                // offset catch this session up on its next turn. Recheck on both "nothing
                // yet" and a transient read error.
                let done = match self.poll_transcript_from_row(home, &row) {
                    Ok(saw_assistant) => saw_assistant,
                    Err(e) => {
                        log::warn!(
                            target: "monica_application::claude_session",
                            "failed to read transcript for {session_id}: {e:#}"
                        );
                        false
                    }
                };
                if !done {
                    recheck.push(session_id.to_string());
                }
            }
            self.m.events.emit(ApplicationEvent::ClaudeSessionStateChanged {
                claude_session_id: row.claude_session_id.clone(),
                tab_id: row.tab_id.clone(),
                session_status: row.status,
                conversation_status: row.conversation_status,
                wait_reason: row.wait_reason,
            });
        }
        let ids: Vec<i64> = events.iter().map(|event| event.id).collect();
        self.m.repos.mark_claude_session_events_consumed(&ids)?;
        Ok(ClaudeSessionDrainOutcome {
            drained: events.len(),
            recheck,
        })
    }

    pub fn sweep_claude_session_events(&mut self) -> ApplicationResult<usize> {
        let deleted = self.m.repos.sweep_consumed_claude_session_events(30)?;
        if deleted > 0 {
            log::info!(
                target: "monica_application::claude_session",
                "swept {deleted} consumed claude_session_events older than 30 days"
            );
        }
        Ok(deleted)
    }

    /// Read the session's transcript from its persisted cursor, emit the new records, and
    /// advance the cursor. Returns whether the turn's assistant output has now been
    /// observed — `false` asks the caller to re-poll (the assistant record flushes around
    /// the Stop hook, sometimes after it). Safe to call while the file does not exist yet
    /// (Claude creates it lazily on the first user message).
    pub fn poll_claude_session_transcript(
        &mut self,
        home: &std::path::Path,
        claude_session_id: &str,
    ) -> ApplicationResult<bool> {
        let Some(row) = self.m.repos.get_claude_session(claude_session_id)? else {
            return Ok(false);
        };
        self.poll_transcript_from_row(home, &row)
    }

    /// Poll variant that reuses a session row the caller already loaded, avoiding a second
    /// read in the drain hot path.
    fn poll_transcript_from_row(
        &mut self,
        home: &std::path::Path,
        row: &ClaudeSession,
    ) -> ApplicationResult<bool> {
        let path = crate::claude_jsonl_path(home, &row.cwd, row.transcript_session_id());
        let chunk = self.m.transcripts.read_from(&path, row.jsonl_offset)?;
        if !chunk.file_exists {
            return Ok(false);
        }
        if chunk.new_offset != row.jsonl_offset {
            self.m
                .repos
                .set_claude_session_jsonl_offset(&row.claude_session_id, chunk.new_offset)?;
        }
        if chunk.records.is_empty() {
            return Ok(false);
        }
        // The recheck exists to catch the assistant record specifically, which flushes
        // last. A read that surfaced only the user prompt (or tool/other lines) has not
        // captured the turn's response yet, so it must keep rechecking — otherwise the
        // response is stranded until the next completed turn advances past it.
        let saw_assistant = chunk.records.iter().any(|record| {
            matches!(
                record.kind,
                crate::ports::ClaudeTranscriptRecordKind::Assistant { .. }
            )
        });
        self.m.events.emit(ApplicationEvent::ClaudeSessionMessages {
            claude_session_id: row.claude_session_id.clone(),
            records: chunk.records,
        });
        Ok(saw_assistant)
    }

    /// The full transcript of a session, from the start of its current file. Pull-style
    /// catch-up for a frontend that missed the push events; never moves the cursor.
    pub fn claude_session_transcript(
        &mut self,
        home: &std::path::Path,
        claude_session_id: &str,
    ) -> ApplicationResult<Vec<crate::ports::ClaudeTranscriptRecord>> {
        let Some(row) = self.m.repos.get_claude_session(claude_session_id)? else {
            return Err(ApplicationError::not_found(format!(
                "claude session {claude_session_id} not found"
            )));
        };
        let path = crate::claude_jsonl_path(home, &row.cwd, row.transcript_session_id());
        let chunk = self.m.transcripts.read_from(&path, 0)?;
        Ok(chunk.records)
    }

    pub fn sync_terminal_session(
        &mut self,
        daemon: &impl TerminalDaemon,
        session_id: &str,
    ) -> ApplicationResult<()> {
        let Some(row) = self.m.repos.get_terminal_session(session_id)? else {
            return Err(ApplicationError::not_found(format!(
                "terminal session {session_id} not found"
            )));
        };
        let views = daemon.list_views()?;
        let outcome = reconcile_terminal_sessions(std::slice::from_ref(&row), &views);
        let terminated: Vec<String> = outcome
            .updates
            .iter()
            .filter(|update| update.status.is_terminal())
            .map(|update| update.session_id.clone())
            .collect();
        self.m.repos.apply_terminal_session_updates(&outcome.updates)?;
        self.settle_runs_for_terminated_sessions(&terminated);
        for session_id in outcome.reap_ids {
            daemon.reap(&session_id);
        }
        Ok(())
    }

    pub fn attach_terminal_session(
        &mut self,
        daemon: &impl TerminalDaemon,
        session_id: &str,
        replay_bytes: Option<u32>,
    ) -> ApplicationResult<TerminalAttachment> {
        let attachment = daemon.attach(session_id, replay_bytes)?;
        self.m.repos.update_terminal_session_status(
            session_id,
            TerminalSessionStatus::Running,
            None,
        )?;
        Ok(attachment)
    }

    pub fn detach_terminal_session(
        &mut self,
        daemon: &impl TerminalDaemon,
        session_id: &str,
    ) -> ApplicationResult<()> {
        // Daemon-side detach is best-effort (it may be down); the durable fact that the view went
        // away is recorded regardless.
        let _ = daemon.detach(session_id);
        let session = self.m.repos.get_terminal_session(session_id)?;
        if session.is_some_and(|s| !s.status.is_terminal()) {
            self.m.repos.update_terminal_session_status(
                session_id,
                TerminalSessionStatus::Detached,
                None,
            )?;
        }
        Ok(())
    }

    /// The DB transition to exited rides on the daemon's Exit broadcast, so this only asks the
    /// daemon to terminate.
    pub fn terminate_terminal_session(
        &self,
        daemon: &impl TerminalDaemon,
        session_id: &str,
    ) -> ApplicationResult<()> {
        daemon.terminate(session_id)?;
        Ok(())
    }

    /// Reconcile DB rows against the daemon (when reachable), sweep orphaned runs, then return the
    /// (optionally runspace-filtered) session list. A daemon failure degrades to a plain DB read
    /// rather than erroring — surfacing it would let the frontend persist an empty layout.
    pub fn list_terminal_sessions(
        &mut self,
        daemon: &impl TerminalDaemon,
        runspace_id: Option<&str>,
    ) -> ApplicationResult<Vec<TerminalSession>> {
        match daemon.list_views() {
            Ok(views) => self.reconcile_terminal_rows(daemon, &views)?,
            Err(e) => {
                log::warn!(
                    target: "monica_application::terminal",
                    "daemon unreachable; listing sessions from DB only: {e:#}"
                );
            }
        }
        Ok(self.m.repos.list_terminal_sessions(runspace_id)?)
    }

    /// Apply a live daemon view to every DB row: demote dead sessions, settle the runs
    /// they drove, and reap what the daemon should forget. Sessions that died while the
    /// app was down only surface here; the run-first sweep also retries settlements lost
    /// to a crash.
    fn reconcile_terminal_rows(
        &mut self,
        daemon: &impl TerminalDaemon,
        views: &[DaemonSessionView],
    ) -> ApplicationResult<()> {
        let db_rows = self.m.repos.list_terminal_sessions(None)?;
        let outcome = reconcile_terminal_sessions(&db_rows, views);
        self.m.repos.apply_terminal_session_updates(&outcome.updates)?;
        self.settle_orphaned_runs();
        for session_id in outcome.reap_ids {
            daemon.reap(&session_id);
        }
        Ok(())
    }

    /// Record a daemon-reported session exit (status → exited) and settle the run it was driving.
    /// Called from the ptyd reader-thread callback.
    pub fn record_terminal_exit(
        &mut self,
        session_id: &str,
        exit_code: Option<i32>,
    ) -> ApplicationResult<()> {
        self.m.repos.update_terminal_session_status(
            session_id,
            TerminalSessionStatus::Exited,
            exit_code,
        )?;
        let ids = [session_id.to_string()];
        self.settle_runs_for_terminated_sessions(&ids);
        Ok(())
    }

    /// Mark every still-live session lost and settle their runs — used when the daemon is replaced
    /// across a protocol break and its sessions cannot be carried over.
    pub fn mark_all_sessions_lost(&mut self) -> ApplicationResult<()> {
        let updates: Vec<TerminalSessionUpdate> = self
            .m
            .repos
            .list_terminal_sessions(None)?
            .iter()
            .filter(|row| !row.status.is_terminal())
            .map(|row| TerminalSessionUpdate {
                session_id: row.id.clone(),
                status: TerminalSessionStatus::Lost,
                pid: None,
                exit_code: None,
            })
            .collect();
        let ids: Vec<String> = updates.iter().map(|u| u.session_id.clone()).collect();
        self.m.repos.apply_terminal_session_updates(&updates)?;
        self.settle_runs_for_terminated_sessions(&ids);
        Ok(())
    }

    pub fn load_terminal_state(
        &self,
        window_label: &str,
    ) -> ApplicationResult<TerminalStateSnapshot> {
        Ok(self.m.repos.load_terminal_state(window_label)?)
    }

    pub fn save_terminal_state(
        &mut self,
        window_label: &str,
        snapshot: &TerminalStateSnapshot,
    ) -> ApplicationResult<()> {
        Ok(self.m.repos.save_terminal_state(window_label, snapshot)?)
    }

    /// Settle the runs orphaned by dead terminal sessions. A killed terminal is the only signal
    /// left (closing a tab skips SessionEnd), so without this the run shows running/waiting
    /// forever. Per-session failures are logged and skipped.
    pub fn settle_runs_for_terminated_sessions(&mut self, session_ids: &[String]) {
        for session_id in session_ids {
            if let Err(e) = self.settle_one(session_id) {
                log::error!(
                    target: "monica_application::settlement",
                    "failed to settle run for session {session_id}: {e}"
                );
            }
        }
    }

    /// Run-first sweep over every run still pinned to a tab whose latest session is dead. Catches
    /// what the per-death path misses (a crash mid-settle, sessions already terminal before this
    /// build, an older run shadowed by a newer one in the same tab).
    pub fn settle_orphaned_runs(&mut self) {
        let runs = match self.m.repos.list_driven_task_runs_with_tab() {
            Ok(runs) => runs,
            Err(e) => {
                log::error!(
                    target: "monica_application::settlement",
                    "failed to list driven runs for the orphan sweep: {e}"
                );
                return;
            }
        };
        for run in runs {
            let Some(tab_id) = run.terminal_tab_id.clone() else {
                continue;
            };
            if let Err(e) = self.settle_orphaned_one(&run, &tab_id) {
                log::error!(
                    target: "monica_application::settlement",
                    "failed to settle orphaned run {}: {e}",
                    run.id
                );
            }
        }
    }

    fn settle_one(&mut self, session_id: &str) -> ApplicationResult<()> {
        let Monica { repos, events, .. } = &mut *self.m;
        let Some(exited) = repos.get_terminal_session(session_id)? else {
            return Ok(());
        };
        let Some(tab_id) = exited.tab_id.clone() else {
            return Ok(());
        };
        let latest = repos.latest_terminal_session_for_tab(&tab_id)?;
        let run = repos.find_task_run_by_terminal_tab(&tab_id)?;
        let Some(settlement) =
            task_run_settlement_for_terminal_exit(&exited, latest.as_ref(), run.as_ref())
        else {
            return Ok(());
        };
        Self::apply_settlement(repos, &**events, settlement)
    }

    fn settle_orphaned_one(&mut self, run: &TaskRun, tab_id: &str) -> ApplicationResult<()> {
        let Monica { repos, events, .. } = &mut *self.m;
        let latest = repos.latest_terminal_session_for_tab(tab_id)?;
        if let Some(settlement) = task_run_settlement_for_orphaned_run(run, latest.as_ref()) {
            Self::apply_settlement(repos, &**events, settlement)?;
        }
        Ok(())
    }

    /// A `false` return from `settle_task_run_if_live` means a hook settled the run first
    /// (SessionEnd, StopFailure); nothing to announce then.
    fn apply_settlement(
        repos: &mut B::Repos,
        events: &dyn EventSink,
        settlement: TerminalExitSettlement,
    ) -> ApplicationResult<()> {
        if repos.settle_task_run_if_live(&settlement.task_run_id, &settlement.task_id)? {
            events.emit(ApplicationEvent::TaskRunStatusChanged {
                task_id: settlement.task_id,
                task_run_id: settlement.task_run_id,
                status: TaskRunStatus::Stopped,
            });
        }
        Ok(())
    }
}
