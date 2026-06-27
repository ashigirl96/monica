use super::{Backend, Monica};
use crate::ports::{
    AgentDecoders, TaskRunStore, TerminalAttachment, TerminalCreateRequest, TerminalDaemon,
    TerminalSessionRepository, WorkbenchStore,
};
use crate::usecases::terminal::{
    reconcile_terminal_sessions, task_run_settlement_for_orphaned_run,
    task_run_settlement_for_terminal_exit, TerminalExitSettlement, TerminalSessionUpdate,
};
use crate::{
    Agent, ApplicationError, ApplicationEvent, ApplicationResult, EventSink, HookContext,
    HookReport, NewTerminalSession, PrepareTaskResult, RunTaskResult, TaskBench, TaskRun,
    TaskRunStatus, TerminalSession, TerminalSessionStatus, TerminalStateSnapshot,
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
        if report.entered_waiting_for_user {
            events.emit(ApplicationEvent::AwaitingUserInput {
                task_id: ctx.task_id.map(str::to_string),
                task_run_id: ctx.task_run_id.map(str::to_string),
                reason: report.task_run_wait_reason,
                task_title: report.task_title.clone(),
            });
        }
        Ok(report)
    }

    /// Create a terminal session row, then ask the daemon to spawn it. On spawn failure the
    /// session is marked `Failed` and any run waiting on this tab is settled now (rather than left
    /// to the sweep). The session is returned regardless so the frontend can bind it to its tab.
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
        match daemon.create(request) {
            Ok(pid) => {
                self.m.repos.mark_terminal_session_started(&session.id, pid)?;
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

        self.m
            .repos
            .get_terminal_session(&session.id)?
            .ok_or_else(|| {
                ApplicationError::not_found(format!("terminal session {} vanished", session.id))
            })
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
            Ok(views) => {
                let db_rows = self.m.repos.list_terminal_sessions(None)?;
                let outcome = reconcile_terminal_sessions(&db_rows, &views);
                self.m.repos.apply_terminal_session_updates(&outcome.updates)?;
                // Sessions that died while the app was down only surface here; the run-first sweep
                // also retries settlements lost to a crash.
                self.settle_orphaned_runs();
                for session_id in outcome.reap_ids {
                    daemon.reap(&session_id);
                }
            }
            Err(e) => {
                log::warn!(
                    target: "monica_application::terminal",
                    "daemon unreachable; listing sessions from DB only: {e:#}"
                );
            }
        }
        Ok(self.m.repos.list_terminal_sessions(runspace_id)?)
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

    pub fn load_terminal_state(&self) -> ApplicationResult<TerminalStateSnapshot> {
        Ok(self.m.repos.load_terminal_state()?)
    }

    pub fn save_terminal_state(&mut self, snapshot: &TerminalStateSnapshot) -> ApplicationResult<()> {
        Ok(self.m.repos.save_terminal_state(snapshot)?)
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
