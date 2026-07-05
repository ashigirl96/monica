use super::{Backend, Monica};
use crate::ports::{
    AgentDecoders, ClaudeSessionRepository, NotificationOutboxStore, TaskRunStore,
    TerminalAttachment, TerminalCreateRequest, TerminalDaemon, TerminalSessionRepository,
    WorkbenchStore,
};
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
    ApplicationError, ApplicationEvent, ApplicationResult, EventSink, HookContext, HookReport,
    OpenSdkSessionParams, PrepareTaskResult, RunTaskResult, SdkSessionSpec, TaskBench,
    TerminalStateSnapshot,
};

/// Run preparation/execution, agent hooks, and (in a later phase) terminal sessions. Groups the
/// `runs` and `terminal` use-case contexts because run settlement is driven by terminal state.
pub struct ExecutionService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
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

        match self.m.repos.get_terminal_session(&session.id) {
            Ok(Some(row)) => Ok(row),
            Ok(None) => {
                if pty_live {
                    self.roll_back_live_session(daemon, &session.id);
                }
                Err(ApplicationError::not_found(format!(
                    "terminal session {} vanished",
                    session.id
                )))
            }
            Err(e) => {
                if pty_live {
                    self.roll_back_live_session(daemon, &session.id);
                }
                Err(e.into())
            }
        }
    }

    /// Create a Claude Code session in the permanent "sdk" runspace: pre-mint the Claude session
    /// id and the tab id, spawn the shell through the daemon, submit the launch command into its
    /// PTY, and only then announce the session for Workbench adoption. Transactional from the
    /// caller's view — a failed launch tears the session down and returns an error, so a retry
    /// can never stack a second live session on a half-open one. No webview involvement anywhere.
    pub fn open_sdk_session(
        &mut self,
        daemon: &impl TerminalDaemon,
        params: OpenSdkSessionParams,
    ) -> ApplicationResult<SdkSessionSpec> {
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
            if let Some(spec) = self.recover_sdk_session(daemon, id, params.model.as_deref())? {
                return Ok(spec);
            }
        }

        // Relative paths would resolve against the app process, not the SDK caller that
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

        let claude_session_id = params
            .claude_session_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let tab_id = uuid::Uuid::new_v4().to_string();
        let initial_command =
            crate::sdk::sdk_initial_command(&claude_session_id, params.model.as_deref());
        let env = vec![(
            crate::MONICA_SDK_SESSION_ID_ENV.to_string(),
            claude_session_id.clone(),
        )];

        let new = NewTerminalSession {
            runspace_id: Some(crate::sdk_runspace_id().to_string()),
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
        // loses here on the primary key — before its own launch write — and only tears
        // down its Claude-less shell.
        if let Err(e) = self.m.repos.create_claude_session(NewClaudeSession {
            claude_session_id: claude_session_id.clone(),
            runspace_id: crate::sdk_runspace_id().to_string(),
            tab_id: tab_id.clone(),
            terminal_session_id: session.id.clone(),
            cwd: params.cwd.clone(),
            name: params.title.clone(),
        }) {
            self.roll_back_live_session(daemon, &session.id);
            return Err(ApplicationError::external(format!(
                "failed to reserve the claude session mapping for session {}: {e:#}; \
                 this spawn was terminated (its launch was never submitted); if a \
                 concurrent open owns this id, a retry resolves to it",
                session.id
            )));
        }

        if let Err(e) = daemon.write_input(&session.id, format!("{initial_command}\r").as_bytes())
        {
            self.roll_back_live_session(daemon, &session.id);
            // The launch never happened, so the reservation must not outlive it — freeing
            // the id keeps a same-id retry a clean fresh open. Best-effort: if this fails,
            // the row was already ended by the rollback's coupled transition, which still
            // refuses reuse.
            if let Err(e) = self.m.repos.delete_claude_session(&claude_session_id) {
                log::error!(
                    target: "monica_application::sdk",
                    "failed to delete the unlaunched reservation {claude_session_id}: {e}"
                );
            }
            return Err(ApplicationError::external(format!(
                "failed to submit the claude launch into session {}: {e:#}; \
                 the session was terminated, so retrying is safe",
                session.id
            )));
        }

        match self.m.repos.mark_claude_session_launched(&claude_session_id) {
            Ok(true) => {}
            // The PTY settled before the launch was confirmed (a write into a dead session
            // is a silent no-op), so nothing runs under this id — fail the open.
            Ok(false) => {
                self.roll_back_live_session(daemon, &session.id);
                if let Err(e) = self.m.repos.delete_claude_session(&claude_session_id) {
                    log::error!(
                        target: "monica_application::sdk",
                        "failed to delete the unlaunched reservation {claude_session_id}: {e}"
                    );
                }
                return Err(ApplicationError::external(format!(
                    "terminal session {} exited before the claude launch was confirmed; \
                     the session was cleaned up, so retrying is safe",
                    session.id
                )));
            }
            Err(e) => {
                self.roll_back_live_session(daemon, &session.id);
                if let Err(e) = self.m.repos.delete_claude_session(&claude_session_id) {
                    log::error!(
                        target: "monica_application::sdk",
                        "failed to delete the reservation {claude_session_id} after a failed \
                         launch confirmation: {e}"
                    );
                }
                return Err(ApplicationError::external(format!(
                    "failed to confirm the claude launch for session {}: {e:#}; \
                     the session was terminated, so retrying is safe",
                    session.id
                )));
            }
        }

        let spec = SdkSessionSpec {
            runspace_id: crate::sdk_runspace_id().to_string(),
            tab_id,
            session_id: session.id,
            claude_session_id,
            cwd: params.cwd,
            initial_command,
            title: params.title,
        };
        self.m.events.emit(ApplicationEvent::SdkSessionOpened {
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
    /// (the start couldn't be recorded, or the launch never made it into the PTY): kill the
    /// process, settle the row as Failed, and settle any run waiting on its tab, so nothing
    /// adoptable or retriable lingers. The kill must come first — if the DB is the thing failing,
    /// the Failed write below fails too, and only a dead PTY lets reconcile settle the row later.
    fn roll_back_live_session(&mut self, daemon: &impl TerminalDaemon, session_id: &str) {
        if let Err(e) = daemon.terminate(session_id) {
            log::warn!(
                target: "monica_application::terminal",
                "failed to terminate rolled-back session {session_id}: {e:#}"
            );
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
    }

    /// Resolve a client-supplied claude_session_id to its existing session, if the id is
    /// already mapped. `Ok(None)` means unmapped — the caller proceeds with a fresh open
    /// under that id. A mapped id never falls through: it either resolves to the live
    /// session or errors, so a retry can never stack a second session on the same id.
    fn recover_sdk_session(
        &mut self,
        daemon: &impl TerminalDaemon,
        claude_session_id: &str,
        model: Option<&str>,
    ) -> ApplicationResult<Option<SdkSessionSpec>> {
        let Some(row) = self.m.repos.get_claude_session(claude_session_id)? else {
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
        let views = daemon.list_views().map_err(|e| {
            ApplicationError::indeterminate(format!(
                "cannot verify claude session {claude_session_id} against the terminal \
                 daemon: {e:#}; the session may still be running — retry with this same \
                 id or check the Workbench"
            ))
        })?;
        match self.m.repos.get_terminal_session(&row.terminal_session_id)? {
            Some(ts_row) => {
                let outcome = reconcile_terminal_sessions(std::slice::from_ref(&ts_row), &views);
                let terminated: Vec<String> = outcome
                    .updates
                    .iter()
                    .filter(|u| u.status.is_terminal())
                    .map(|u| u.session_id.clone())
                    .collect();
                self.m.repos.apply_terminal_session_updates(&outcome.updates)?;
                self.settle_runs_for_terminated_sessions(&terminated);
                for session_id in outcome.reap_ids {
                    daemon.reap(&session_id);
                }
            }
            None => {
                // The terminal row is gone; push a Lost update through the funnel so the
                // coupled transition ends this mapping, then refuse below.
                self.m.repos.apply_terminal_session_updates(&[TerminalSessionUpdate {
                    session_id: row.terminal_session_id.clone(),
                    status: TerminalSessionStatus::Lost,
                    pid: None,
                    exit_code: None,
                }])?;
            }
        }

        let row = self.m.repos.get_claude_session(claude_session_id)?.ok_or_else(|| {
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
            // A reservation whose launch was never confirmed: the open may still be in
            // flight on another connection, or was interrupted for good — unknowable
            // here, so neither resolving to it nor relaunching under the id is safe.
            // Indeterminate, not a rejection: a determinate error would tell the SDK
            // "nothing is left behind", and a fresh-id retry could then duplicate the
            // session an in-flight open is about to confirm.
            ClaudeSessionStatus::Pending => {
                return Err(ApplicationError::indeterminate(format!(
                    "claude session {claude_session_id} has an unconfirmed launch (an open \
                     is in flight or was interrupted); retry with this same id once it \
                     settles, or check its tab in the Workbench — do not open a fresh id \
                     for the same logical session"
                )));
            }
            ClaudeSessionStatus::Active => {}
        }

        let spec = SdkSessionSpec {
            runspace_id: row.runspace_id,
            tab_id: row.tab_id,
            session_id: row.terminal_session_id,
            claude_session_id: row.claude_session_id,
            cwd: row.cwd,
            // Informational only — the original launch already ran; this is not re-executed.
            initial_command: crate::sdk::sdk_initial_command(claude_session_id, model),
            title: row.name,
        };
        // Re-announce so a Workbench that missed the original event adopts the tab now.
        // Adoption dedupes on the terminal session id, so a repeat is a no-op there.
        self.m.events.emit(ApplicationEvent::SdkSessionOpened {
            runspace_id: spec.runspace_id.clone(),
            tab_id: spec.tab_id.clone(),
            session_id: spec.session_id.clone(),
            claude_session_id: spec.claude_session_id.clone(),
            cwd: spec.cwd.clone(),
            title: spec.title.clone(),
        });
        Ok(Some(spec))
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
