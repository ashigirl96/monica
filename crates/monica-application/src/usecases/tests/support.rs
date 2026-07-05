use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use monica_domain::RawJson;

use crate::ports::{
    AgentDecoders, BoxFuture, EventRepository, GitGateway, NotebookGateway,
    NotificationOutboxStore, ProjectRepository, PullRequestSyncStore, TaskBoardQuery, TaskRunStore,
    TaskStore, TaskSummaryFilter, TerminalAttachment, TerminalCreateRequest, TerminalDaemon,
    TerminalSessionRepository, UnitOfWork, WorkTransaction, WorkbenchStore, Workspace,
};
use crate::usecases::runs::record_hook;
use crate::prelude::{
    Agent, AgentSignal, Continuation, DisplayStatus, Event, ExternalReference, LintFinding,
    NewNotificationIntent, NewTask, NewTaskRun, NewTerminalSession, NotebookDoc,
    NotificationIntent, Project, Provider, RefType, SignalKind, Task, TaskId, TaskKind, TaskRun,
    TaskRunId, TaskRunStatus, TaskRunWaitReason, TaskStatus, TerminalSession,
    TerminalSessionKind, TerminalSessionStatus,
};
use crate::{
    ApplicationEvent, AuthGateway, Backend, Clock, DaemonSessionView, EventSink, ExecutionProfile,
    GithubAuthStatus, GithubDeviceFlow, GithubGateway, GithubIssue, GithubPullRequest,
    GithubPullRequestRef, GithubPullRequestStatus, HookContext, Monica,
    PullRequestBranchSyncCandidate, PullRequestStatusSyncCandidate, RepoPullRequest, SetupEnv,
    SetupOutcome,
    SetupRunner, TaskRunObservation, TaskRunOutputs, TaskSummaryRow, TerminalSessionUpdate,
    TerminalStateSnapshot,
};
// --- Agent-signal test builders -------------------------------------------------------------------
// The use-case tests drive `record_hook` with typed `AgentSignal`s (the provider JSON -> signal
// decoding is covered by the adapter decoder's own tests in `monica-adapters::agents`). `raw_stdin` is
// irrelevant to these assertions, so the shim feeds a constant.

fn mk_signal(session: Option<&str>, label: &str, kind: SignalKind) -> AgentSignal {
    AgentSignal {
        session_id: session.map(str::to_string),
        event_label: Some(label.to_string()),
        kind,
    }
}

pub(crate) fn started(session: &str, continuation: Continuation) -> AgentSignal {
    mk_signal(Some(session), "SessionStart", SignalKind::SessionStarted { continuation })
}

pub(crate) fn started_no_session(continuation: Continuation) -> AgentSignal {
    mk_signal(None, "SessionStart", SignalKind::SessionStarted { continuation })
}

pub(crate) fn prompt(session: &str) -> AgentSignal {
    mk_signal(Some(session), "UserPromptSubmit", SignalKind::PromptSubmitted)
}

pub(crate) fn turn_completed(session: &str, subagents_running: bool) -> AgentSignal {
    mk_signal(Some(session), "Stop", SignalKind::TurnCompleted { subagents_running })
}

pub(crate) fn subagent_finished(session: &str, subagents_running: bool) -> AgentSignal {
    mk_signal(Some(session), "SubagentStop", SignalKind::SubagentFinished { subagents_running })
}

pub(crate) fn session_ended(session: &str) -> AgentSignal {
    mk_signal(Some(session), "SessionEnd", SignalKind::SessionEnded)
}

pub(crate) fn input_required(session: Option<&str>, reason: TaskRunWaitReason) -> AgentSignal {
    mk_signal(
        session,
        "PreToolUse",
        SignalKind::UserInputRequired { reason, plan_file_path: None },
    )
}

pub(crate) fn input_resolved(session: &str) -> AgentSignal {
    mk_signal(Some(session), "PostToolUse", SignalKind::UserInputResolved)
}

pub(crate) fn inert_event(session: &str, label: &str) -> AgentSignal {
    mk_signal(Some(session), label, SignalKind::Inert)
}

/// Thin shim mirroring the production boundary: a decoded Claude signal handed to `record_hook`.
pub(crate) fn record_claude_hook<R, A>(
    repos: &mut R,
    outputs: &A,
    ctx: HookContext<'_>,
    signal: &AgentSignal,
) -> Result<crate::HookReport>
where
    R: TaskStore + TaskRunStore + EventRepository + Clock + UnitOfWork,
    A: TaskRunOutputs,
{
    record_hook(repos, outputs, ctx, Agent::Claude, Some(signal), "{}")
}

#[derive(Default)]
pub(crate) struct FakeRepos {
    state: RefCell<FakeState>,
}

#[derive(Default)]
struct FakeState {
    projects: HashMap<String, Project>,
    tasks: HashMap<String, Task>,
    refs: HashMap<String, Vec<ExternalReference>>,
    runs: HashMap<String, TaskRun>,
    events: Vec<Event>,
    benches: BTreeMap<String, (String, String)>,
    /// Insertion order is creation order, so the last match for a tab is its latest session.
    terminal_sessions: Vec<TerminalSession>,
    next_task: i64,
    next_run: i64,
    next_session: i64,
    pr_branch_candidate: Option<PullRequestBranchSyncCandidate>,
    pr_status_candidate: Option<PullRequestStatusSyncCandidate>,
    pr_branch_success_count: usize,
    mark_started_fails: bool,
    branch_sync_candidates: Vec<PullRequestBranchSyncCandidate>,
    bulk_recorded: Vec<(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)>,
}

impl FakeRepos {
    pub(crate) fn insert_project(&self, project: Project) {
        self.state
            .borrow_mut()
            .projects
            .insert(project.id.clone(), project);
    }

    pub(crate) fn set_branch_sync_candidates(
        &self,
        candidates: Vec<PullRequestBranchSyncCandidate>,
    ) {
        self.state.borrow_mut().branch_sync_candidates = candidates;
    }

    pub(crate) fn bulk_recorded(
        &self,
    ) -> Vec<(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)> {
        self.state.borrow().bulk_recorded.clone()
    }

    pub(crate) fn insert_task_for_run(&mut self, project_id: Option<String>) -> String {
        self.insert_task(NewTask {
            kind: TaskKind::Development,
            status: TaskStatus::Ready,
            title: "tracked".to_string(),
            body: String::new(),
            phase: None,
            project_id,
            labels: Vec::new(),
            details: RawJson::empty_object(),
            source: None,
        })
        .unwrap()
        .id
        .into_string()
    }
}

// Bodies of the mutating TaskStore ops live as `&self` inherent methods (interior mutability via
// the RefCell), so both `impl TaskStore for FakeRepos` and the `FakeUow` transaction — which only
// holds a shared `&FakeRepos` — can share them.
impl FakeRepos {
    fn do_insert_task(&self, new: NewTask) -> Result<Task> {
        let mut state = self.state.borrow_mut();
        state.next_task += 1;
        let id = format!("MON-{}", state.next_task);
        let task = task_from_new(id, new);
        state.tasks.insert(task.id.to_string(), task.clone());
        Ok(task)
    }

    fn do_insert_task_with_ref(
        &self,
        new: NewTask,
        mut external: ExternalReference,
    ) -> Result<Task> {
        let task = self.do_insert_task(new)?;
        external.id = 1;
        external.task_id = task.id.to_string();
        self.state
            .borrow_mut()
            .refs
            .entry(task.id.to_string())
            .or_default()
            .push(external);
        Ok(task)
    }

    fn do_mark_task_closed(&self, id: &str) -> Result<Task> {
        let mut state = self.state.borrow_mut();
        let task = state
            .tasks
            .get_mut(id)
            .ok_or_else(|| anyhow!("task not found: {id}"))?;
        task.status = TaskStatus::Closed;
        task.closed_at = Some("2026-06-02T00:00:00.000Z".to_string());
        Ok(task.clone())
    }

    fn do_mark_task(&self, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()> {
        let mut state = self.state.borrow_mut();
        let task = state
            .tasks
            .get_mut(id)
            .ok_or_else(|| anyhow!("task not found: {id}"))?;
        task.status = status;
        task.phase = note.map(ToString::to_string);
        Ok(())
    }
}

impl TaskStore for FakeRepos {
    fn insert_task(&mut self, new: NewTask) -> Result<Task> {
        self.do_insert_task(new)
    }

    fn insert_task_with_ref(&mut self, new: NewTask, external: ExternalReference) -> Result<Task> {
        self.do_insert_task_with_ref(new, external)
    }

    fn get_task(&self, id: &str) -> Result<Option<Task>> {
        Ok(self.state.borrow().tasks.get(id).cloned())
    }

    fn mark_task_closed(&mut self, id: &str) -> Result<Task> {
        self.do_mark_task_closed(id)
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        Ok(self.state.borrow().tasks.values().cloned().collect())
    }

    fn set_primary_task_run(&self, task_id: &str, task_run_id: &str) -> Result<()> {
        self.state
            .borrow_mut()
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| anyhow!("task not found: {task_id}"))?
            .primary_task_run_id = Some(TaskRunId::from_store(task_run_id.to_string()));
        Ok(())
    }

    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<()> {
        self.state
            .borrow_mut()
            .tasks
            .get_mut(id)
            .ok_or_else(|| anyhow!("task not found: {id}"))?
            .status = status;
        Ok(())
    }

    fn mark_task(&mut self, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()> {
        self.do_mark_task(id, status, note)
    }

    fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalReference>> {
        Ok(self
            .state
            .borrow()
            .refs
            .get(task_id)
            .cloned()
            .unwrap_or_default())
    }
}

impl TaskBoardQuery for FakeRepos {
    fn list_task_summaries(
        &self,
        filter: TaskSummaryFilter,
        _project: Option<&str>,
    ) -> Result<Vec<TaskSummaryRow>> {
        let rows = self
            .state
            .borrow()
            .tasks
            .values()
            .map(|task| {
                let display = DisplayStatus::from_task_and_run(task.status, None);
                TaskSummaryRow {
                    id: task.id.to_string(),
                    title: task.title.clone(),
                    project: task.project_id.clone(),
                    github_issue_number: None,
                    github_pull_requests: Vec::<GithubPullRequestRef>::new(),
                    task_status: task.status,
                    task_run_status: None,
                    task_run_wait_reason: None,
                    has_plan: false,
                    status: display,
                    prepare_eligible: display.prepare_eligible(),
                    run_eligible: display.run_eligible(),
                    is_active: display.is_active(),
                    has_open_pull_request: false,
                    branch: None,
                    side_runs_running: 0,
                    side_runs_waiting_for_user: 0,
                    side_runs_failed: 0,
                }
            })
            .filter(|row| filter.matches(row.status))
            .collect();
        Ok(rows)
    }
}

impl PullRequestSyncStore for FakeRepos {
    fn next_pull_request_branch_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestBranchSyncCandidate>> {
        Ok(self.state.borrow().pr_branch_candidate.clone())
    }

    fn next_pull_request_status_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestStatusSyncCandidate>> {
        Ok(self.state.borrow().pr_status_candidate.clone())
    }

    fn all_branch_sync_candidates(&self) -> Result<Vec<PullRequestBranchSyncCandidate>> {
        Ok(self.state.borrow().branch_sync_candidates.clone())
    }

    fn record_pull_request_branch_sync_success(
        &mut self,
        _candidate: &PullRequestBranchSyncCandidate,
        pull_requests: &[GithubPullRequest],
    ) -> Result<()> {
        let mut state = self.state.borrow_mut();
        state.pr_branch_success_count = pull_requests.len();
        state.pr_branch_candidate = None;
        Ok(())
    }

    fn bulk_record_branch_sync_success(
        &mut self,
        entries: &[(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)],
    ) -> Result<()> {
        self.state
            .borrow_mut()
            .bulk_recorded
            .extend_from_slice(entries);
        Ok(())
    }

    fn record_pull_request_branch_sync_failure(
        &mut self,
        _candidate: &PullRequestBranchSyncCandidate,
        _error: &str,
    ) -> Result<()> {
        self.state.borrow_mut().pr_branch_candidate = None;
        Ok(())
    }

    fn record_pull_request_status_sync_success(
        &mut self,
        _candidate: &PullRequestStatusSyncCandidate,
        _pull_request: &GithubPullRequest,
    ) -> Result<()> {
        self.state.borrow_mut().pr_status_candidate = None;
        Ok(())
    }

    fn record_pull_request_status_sync_failure(
        &mut self,
        _candidate: &PullRequestStatusSyncCandidate,
        _error: &str,
    ) -> Result<()> {
        self.state.borrow_mut().pr_status_candidate = None;
        Ok(())
    }

    fn force_clear_pr_sync_state(&mut self) -> Result<()> {
        Ok(())
    }
}

impl ProjectRepository for FakeRepos {
    fn upsert_project(&self, project: &Project, _profile: &ExecutionProfile) -> Result<Project> {
        self.insert_project(project.clone());
        Ok(project.clone())
    }

    fn get_project(&self, id: &str) -> Result<Option<Project>> {
        Ok(self.state.borrow().projects.get(id).cloned())
    }

    fn get_execution_profile(&self, _id: &str) -> Result<Option<ExecutionProfile>> {
        Ok(Some(ExecutionProfile::default()))
    }

    fn list_projects(&self) -> Result<Vec<Project>> {
        Ok(self.state.borrow().projects.values().cloned().collect())
    }

    fn set_project_field(&self, _id: &str, _key: &str, _value: &str) -> Result<()> {
        Ok(())
    }
}

fn run_number(run_id: &str) -> i64 {
    run_id
        .strip_prefix("run-")
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// Mirrors the SQLite predicate for a tab-driven run still settle-able by terminal death:
/// Running/WaitingForUser, or SettingUp once a session has been observed.
fn is_live_driven_run(run: &TaskRun) -> bool {
    matches!(
        run.status,
        TaskRunStatus::Running | TaskRunStatus::WaitingForUser
    ) || (run.status == TaskRunStatus::SettingUp && run.provider_session_id.is_some())
}

// Mutating TaskRunStore ops as `&self` inherent helpers, shared by the trait impl and `FakeUow`.
impl FakeRepos {
    fn do_start_task_run(&self, new: NewTaskRun) -> Result<TaskRun> {
        let mut state = self.state.borrow_mut();
        state.next_run += 1;
        let id = format!("run-{}", state.next_run);
        let run = TaskRun {
            id: TaskRunId::from_store(id.clone()),
            task_id: new.task_id.clone(),
            agent: new.agent,
            branch: new.branch,
            worktree_path: new.worktree_path,
            status: TaskRunStatus::SettingUp,
            wait_reason: None,
            settings_path: None,
            provider_session_id: None,
            terminal_tab_id: None,
            last_event_name: None,
            last_event_at: None,
            plan_file_path: None,
            pending_stop: false,
            metadata: RawJson::empty_object(),
            created_at: "2026-06-02T00:00:00.000Z".to_string(),
            updated_at: "2026-06-02T00:00:00.000Z".to_string(),
        };
        state.runs.insert(id, run.clone());
        if let Some(task) = state.tasks.get_mut(new.task_id.as_str()) {
            if task.status != TaskStatus::Closed {
                task.status = TaskStatus::InProgress;
            }
        }
        Ok(run)
    }

    fn do_finish_task_run(
        &self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        let mut state = self.state.borrow_mut();
        state
            .runs
            .get_mut(task_run_id)
            .ok_or_else(|| anyhow!("task run not found: {task_run_id}"))?
            .status = status;
        if let Some(task) = state.tasks.get_mut(task_id) {
            if task.status != TaskStatus::Closed {
                task.status = TaskStatus::InProgress;
            }
        }
        Ok(())
    }

    fn do_settle_task_run_if_live(&self, task_run_id: &str, task_id: &str) -> Result<bool> {
        let mut state = self.state.borrow_mut();
        let Some(run) = state.runs.get_mut(task_run_id) else {
            return Ok(false);
        };
        if run.task_id != task_id || !is_live_driven_run(run) {
            return Ok(false);
        }
        run.status = TaskRunStatus::Stopped;
        run.wait_reason = None;
        Ok(true)
    }

    fn do_record_task_run_observation(
        &self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        let mut state = self.state.borrow_mut();
        let run = state
            .runs
            .get_mut(task_run_id)
            .ok_or_else(|| anyhow!("task run not found: {task_run_id}"))?;
        if let Some(status) = observation.status {
            run.status = status;
        }
        if let Some(wait_reason) = observation.wait_reason {
            run.wait_reason = wait_reason;
        }
        if let Some(session) = observation.provider_session_id {
            run.provider_session_id = Some(session.to_string());
        }
        if let Some(tab) = observation.terminal_tab_id {
            run.terminal_tab_id = Some(tab.to_string());
        }
        if let Some(plan) = observation.plan_file_path {
            run.plan_file_path = Some(plan.to_string());
        }
        // Mirror the store's subagent guard from the typed observation: a held turn-complete keeps
        // pending_stop; the releasing subagent-finish fires the deferred transition.
        let was_pending = run.pending_stop;
        if observation.release_stop && was_pending {
            run.status = TaskRunStatus::WaitingForUser;
            run.wait_reason = Some(TaskRunWaitReason::AwaitingPrompt);
        }
        run.pending_stop = if observation.hold_stop && run.status == TaskRunStatus::Running {
            true
        } else if observation.release_stop || observation.status.is_some() {
            false
        } else {
            was_pending
        };
        run.last_event_name = observation.event_label.map(ToString::to_string);
        run.last_event_at = Some(observation.at.to_string());
        Ok(())
    }
}

impl TaskRunStore for FakeRepos {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
        self.do_start_task_run(new)
    }

    fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        self.do_finish_task_run(task_run_id, task_id, status)
    }

    fn set_task_run_settings_path(&self, task_run_id: &str, settings_path: &str) -> Result<()> {
        self.state
            .borrow_mut()
            .runs
            .get_mut(task_run_id)
            .ok_or_else(|| anyhow!("task run not found: {task_run_id}"))?
            .settings_path = Some(settings_path.to_string());
        Ok(())
    }

    fn set_task_run_worktree_path(&self, task_run_id: &str, worktree_path: &str) -> Result<()> {
        self.state
            .borrow_mut()
            .runs
            .get_mut(task_run_id)
            .ok_or_else(|| anyhow!("task run not found: {task_run_id}"))?
            .worktree_path = Some(worktree_path.to_string());
        Ok(())
    }

    fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
        Ok(self.state.borrow().runs.get(id).cloned())
    }

    fn find_task_run_by_session(
        &self,
        task_id: &str,
        provider_session_id: &str,
    ) -> Result<Option<TaskRun>> {
        Ok(self
            .state
            .borrow()
            .runs
            .values()
            .filter(|run| {
                run.task_id == task_id
                    && run.provider_session_id.as_deref() == Some(provider_session_id)
            })
            // mirrors sqlite: most recently observed first, run number as tie-break
            .max_by_key(|run| (run.last_event_at.clone(), run_number(&run.id)))
            .cloned())
    }

    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>> {
        Ok(self
            .state
            .borrow()
            .runs
            .values()
            .filter(|run| run.terminal_tab_id.as_deref() == Some(terminal_tab_id))
            .max_by_key(|run| (run.last_event_at.clone(), run_number(&run.id)))
            .cloned())
    }

    fn list_task_runs_for_task(&self, task_id: &str) -> Result<Vec<TaskRun>> {
        Ok(self
            .state
            .borrow()
            .runs
            .values()
            .filter(|run| run.task_id == task_id)
            .cloned()
            .collect())
    }

    fn list_driven_task_runs_with_tab(&self) -> Result<Vec<TaskRun>> {
        Ok(self
            .state
            .borrow()
            .runs
            .values()
            .filter(|run| run.terminal_tab_id.is_some() && is_live_driven_run(run))
            .cloned()
            .collect())
    }

    fn settle_task_run_if_live(&mut self, task_run_id: &str, task_id: &str) -> Result<bool> {
        self.do_settle_task_run_if_live(task_run_id, task_id)
    }

    fn claim_prepared_run(&self, task_run_id: &str, provider_session_id: &str) -> Result<bool> {
        // Mirror the SQLite guard: WHERE id=? AND status='prepared' AND provider_session_id IS NULL.
        let mut state = self.state.borrow_mut();
        let Some(run) = state.runs.get_mut(task_run_id) else {
            return Ok(false);
        };
        if run.status == TaskRunStatus::Prepared && run.provider_session_id.is_none() {
            run.provider_session_id = Some(provider_session_id.to_string());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn create_lazy_run_for_session(
        &mut self,
        new: NewTaskRun,
        make_primary_if_missing: bool,
    ) -> Result<TaskRun> {
        let task_id = new.task_id.clone();
        let run = self.do_start_task_run(new)?;
        if make_primary_if_missing {
            self.set_primary_task_run(&task_id, &run.id)?;
        }
        Ok(run)
    }

    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        self.do_record_task_run_observation(task_run_id, observation)
    }
}

impl EventRepository for FakeRepos {
    fn insert_event(
        &self,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        kind: &str,
        payload_json: &str,
    ) -> Result<Event> {
        let mut state = self.state.borrow_mut();
        let event = Event {
            id: state.events.len() as i64 + 1,
            task_id: task_id.map(ToString::to_string),
            task_run_id: task_run_id.map(ToString::to_string),
            kind: kind.to_string(),
            payload: RawJson(payload_json.to_string()),
            created_at: "2026-06-02T00:00:00.000Z".to_string(),
        };
        state.events.push(event.clone());
        Ok(event)
    }

    fn list_events(&self, task_id: Option<&str>) -> Result<Vec<Event>> {
        Ok(self
            .state
            .borrow()
            .events
            .iter()
            .filter(|event| task_id.is_none_or(|id| event.task_id.as_deref() == Some(id)))
            .cloned()
            .collect())
    }
}

impl Clock for FakeRepos {
    fn now_iso(&self) -> Result<String> {
        Ok("2026-06-02T00:00:00.000Z".to_string())
    }
}

impl NotificationOutboxStore for FakeRepos {
    fn enqueue_notification(
        &mut self,
        _intent: NewNotificationIntent,
    ) -> Result<NotificationIntent> {
        Ok(NotificationIntent {
            id: 1,
            dedupe_key: _intent.dedupe_key,
            kind: _intent.kind,
            title: _intent.title,
            body: _intent.body,
            task_id: _intent.task_id,
            task_run_id: _intent.task_run_id,
            created_at: "2026-06-02T00:00:00.000Z".to_string(),
            delivered_at: None,
            error: None,
            attempts: 0,
        })
    }

    fn list_pending_notifications(&self, _limit: usize) -> Result<Vec<NotificationIntent>> {
        Ok(Vec::new())
    }

    fn mark_notification_delivered(&self, _id: i64) -> Result<()> {
        Ok(())
    }

    fn mark_notification_failed(&self, _id: i64, _error: &str) -> Result<()> {
        Ok(())
    }

    fn cancel_notifications_for_run(&self, _task_run_id: &str) -> Result<()> {
        Ok(())
    }
}

impl FakeRepos {
    fn do_create_bench(&self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()> {
        self.state
            .borrow_mut()
            .benches
            .insert(task_id.to_string(), (runspace_id.to_string(), cwd.to_string()));
        Ok(())
    }
}

impl WorkbenchStore for FakeRepos {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>> {
        Ok(self.state.borrow().benches.get(task_id).cloned())
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>> {
        Ok(self.state.borrow().benches.values().cloned().collect())
    }

    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()> {
        self.do_create_bench(task_id, runspace_id, cwd)
    }

    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()> {
        if let Some(entry) = self.state.borrow_mut().benches.get_mut(task_id) {
            entry.1 = cwd.to_string();
        }
        Ok(())
    }
}

impl UnitOfWork for FakeRepos {
    fn begin(&mut self) -> Result<Box<dyn WorkTransaction + '_>> {
        Ok(Box::new(FakeUow { inner: self }))
    }
}

/// A no-rollback transaction over a shared `&FakeRepos`: every write goes straight to the shared
/// `RefCell`, and `commit` is a no-op. The SQLite store covers real rollback; the fake only needs
/// the use-case path (begin → writes → commit) to behave like direct calls.
struct FakeUow<'a> {
    inner: &'a FakeRepos,
}

impl WorkTransaction for FakeUow<'_> {
    fn commit(self: Box<Self>) -> Result<()> {
        Ok(())
    }
}

impl TaskStore for FakeUow<'_> {
    fn insert_task(&mut self, new: NewTask) -> Result<Task> {
        self.inner.do_insert_task(new)
    }

    fn insert_task_with_ref(&mut self, new: NewTask, external: ExternalReference) -> Result<Task> {
        self.inner.do_insert_task_with_ref(new, external)
    }

    fn get_task(&self, id: &str) -> Result<Option<Task>> {
        self.inner.get_task(id)
    }

    fn mark_task_closed(&mut self, id: &str) -> Result<Task> {
        self.inner.do_mark_task_closed(id)
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        self.inner.list_tasks()
    }

    fn set_primary_task_run(&self, task_id: &str, task_run_id: &str) -> Result<()> {
        self.inner.set_primary_task_run(task_id, task_run_id)
    }

    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<()> {
        self.inner.update_task_status(id, status)
    }

    fn mark_task(&mut self, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()> {
        self.inner.do_mark_task(id, status, note)
    }

    fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalReference>> {
        self.inner.list_external_refs(task_id)
    }
}

impl TaskRunStore for FakeUow<'_> {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
        self.inner.do_start_task_run(new)
    }

    fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        self.inner.do_finish_task_run(task_run_id, task_id, status)
    }

    fn set_task_run_settings_path(&self, task_run_id: &str, settings_path: &str) -> Result<()> {
        self.inner.set_task_run_settings_path(task_run_id, settings_path)
    }

    fn set_task_run_worktree_path(&self, task_run_id: &str, worktree_path: &str) -> Result<()> {
        self.inner.set_task_run_worktree_path(task_run_id, worktree_path)
    }

    fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
        self.inner.get_task_run(id)
    }

    fn find_task_run_by_session(
        &self,
        task_id: &str,
        provider_session_id: &str,
    ) -> Result<Option<TaskRun>> {
        self.inner.find_task_run_by_session(task_id, provider_session_id)
    }

    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>> {
        self.inner.find_task_run_by_terminal_tab(terminal_tab_id)
    }

    fn list_task_runs_for_task(&self, task_id: &str) -> Result<Vec<TaskRun>> {
        self.inner.list_task_runs_for_task(task_id)
    }

    fn list_driven_task_runs_with_tab(&self) -> Result<Vec<TaskRun>> {
        self.inner.list_driven_task_runs_with_tab()
    }

    fn settle_task_run_if_live(&mut self, task_run_id: &str, task_id: &str) -> Result<bool> {
        self.inner.do_settle_task_run_if_live(task_run_id, task_id)
    }

    fn claim_prepared_run(&self, task_run_id: &str, provider_session_id: &str) -> Result<bool> {
        self.inner.claim_prepared_run(task_run_id, provider_session_id)
    }

    fn create_lazy_run_for_session(
        &mut self,
        new: NewTaskRun,
        make_primary_if_missing: bool,
    ) -> Result<TaskRun> {
        let task_id = new.task_id.clone();
        let run = self.inner.do_start_task_run(new)?;
        if make_primary_if_missing {
            self.inner.set_primary_task_run(&task_id, &run.id)?;
        }
        Ok(run)
    }

    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        self.inner.do_record_task_run_observation(task_run_id, observation)
    }
}

impl EventRepository for FakeUow<'_> {
    fn insert_event(
        &self,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        kind: &str,
        payload_json: &str,
    ) -> Result<Event> {
        self.inner.insert_event(task_id, task_run_id, kind, payload_json)
    }

    fn list_events(&self, task_id: Option<&str>) -> Result<Vec<Event>> {
        self.inner.list_events(task_id)
    }
}

impl Clock for FakeUow<'_> {
    fn now_iso(&self) -> Result<String> {
        self.inner.now_iso()
    }
}

impl WorkbenchStore for FakeUow<'_> {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>> {
        self.inner.get_bench_for_task(task_id)
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>> {
        self.inner.list_bench_runspace_map()
    }

    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()> {
        self.inner.do_create_bench(task_id, runspace_id, cwd)
    }

    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()> {
        self.inner.update_bench_cwd(task_id, cwd)
    }
}

pub(crate) struct FakeGithub;

impl GithubGateway for FakeGithub {
    fn fetch_issue<'a>(&'a self, repo: &'a str, number: i64) -> BoxFuture<'a, Result<GithubIssue>> {
        Box::pin(async move {
            Ok(GithubIssue {
                number,
                title: format!("{repo} issue"),
                body: Some("body".to_string()),
                url: format!("https://github.com/{repo}/issues/{number}"),
            })
        })
    }

    fn fetch_default_branch<'a>(&'a self, _repo: &'a str) -> BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async { Ok(Some("main".to_string())) })
    }

    fn fetch_pull_requests_by_branch<'a>(
        &'a self,
        repo: &'a str,
        _branch: &'a str,
    ) -> BoxFuture<'a, Result<Vec<GithubPullRequest>>> {
        Box::pin(async move {
            Ok(vec![GithubPullRequest {
                repo: repo.to_string(),
                number: 8,
                url: format!("https://github.com/{repo}/pull/8"),
                status: GithubPullRequestStatus::Open,
            }])
        })
    }

    fn fetch_pull_request<'a>(
        &'a self,
        repo: &'a str,
        number: i64,
    ) -> BoxFuture<'a, Result<GithubPullRequest>> {
        Box::pin(async move {
            Ok(GithubPullRequest {
                repo: repo.to_string(),
                number,
                url: format!("https://github.com/{repo}/pull/{number}"),
                status: GithubPullRequestStatus::Merged,
            })
        })
    }

    fn fetch_recent_pull_requests<'a>(
        &'a self,
        _repo: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RepoPullRequest>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// A `GithubGateway` whose repo-wide PR listing is scripted per repo, for the bulk-sync usecase.
/// `None` for a repo yields an error (to exercise per-repo failure isolation).
pub(crate) struct RecentPrGithub {
    by_repo: HashMap<String, Option<Vec<RepoPullRequest>>>,
}

impl RecentPrGithub {
    pub(crate) fn new(by_repo: HashMap<String, Option<Vec<RepoPullRequest>>>) -> Self {
        Self { by_repo }
    }
}

impl GithubGateway for RecentPrGithub {
    fn fetch_issue<'a>(
        &'a self,
        _repo: &'a str,
        _number: i64,
    ) -> BoxFuture<'a, Result<GithubIssue>> {
        Box::pin(async { Err(anyhow!("unused")) })
    }

    fn fetch_default_branch<'a>(&'a self, _repo: &'a str) -> BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async { Err(anyhow!("unused")) })
    }

    fn fetch_pull_requests_by_branch<'a>(
        &'a self,
        _repo: &'a str,
        _branch: &'a str,
    ) -> BoxFuture<'a, Result<Vec<GithubPullRequest>>> {
        Box::pin(async { Err(anyhow!("unused")) })
    }

    fn fetch_pull_request<'a>(
        &'a self,
        _repo: &'a str,
        _number: i64,
    ) -> BoxFuture<'a, Result<GithubPullRequest>> {
        Box::pin(async { Err(anyhow!("unused")) })
    }

    fn fetch_recent_pull_requests<'a>(
        &'a self,
        repo: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RepoPullRequest>>> {
        let outcome = self.by_repo.get(repo).cloned();
        Box::pin(async move {
            match outcome {
                Some(Some(pull_requests)) => Ok(pull_requests),
                Some(None) => Err(anyhow!("fetch failed for {repo}")),
                None => Ok(Vec::new()),
            }
        })
    }
}

#[derive(Default)]
pub(crate) struct FakeGit {
    cleaned: RefCell<bool>,
    create_worktree_error: RefCell<Option<String>>,
}

impl FakeGit {
    pub(crate) fn with_create_worktree_error(message: impl Into<String>) -> Self {
        Self {
            create_worktree_error: RefCell::new(Some(message.into())),
            ..Default::default()
        }
    }

    pub(crate) fn cleaned(&self) -> bool {
        *self.cleaned.borrow()
    }
}

impl GitGateway for FakeGit {
    fn create_worktree(
        &self,
        _repo: &Path,
        _worktree: &Path,
        _branch: &str,
        _base: &str,
    ) -> Result<()> {
        if let Some(msg) = self.create_worktree_error.borrow().clone() {
            return Err(anyhow!(msg));
        }
        Ok(())
    }

    fn cleanup_task_runs(&self, _repo: &Path, runs: &[TaskRun]) -> Result<Vec<String>> {
        *self.cleaned.borrow_mut() = true;
        Ok(runs.iter().filter_map(|run| run.branch.clone()).collect())
    }

    fn detect_repo(&self) -> Result<String> {
        Ok("owner/repo".to_string())
    }

    fn detect_default_branch(&self, _repo: &str) -> Option<String> {
        Some("main".to_string())
    }
}

#[derive(Default)]
pub(crate) struct FakeTaskRunOutputs {
    appended: RefCell<bool>,
    last_cwd: RefCell<Option<String>>,
}

impl FakeTaskRunOutputs {
    pub(crate) fn hook_event_appended(&self) -> bool {
        *self.appended.borrow()
    }

    pub(crate) fn last_cwd(&self) -> Option<String> {
        self.last_cwd.borrow().clone()
    }
}

impl TaskRunOutputs for FakeTaskRunOutputs {
    fn task_run_dir(&self, task_run_id: &str) -> Result<PathBuf> {
        Ok(PathBuf::from("/tmp").join(task_run_id))
    }

    fn setup_log_path(&self, task_run_id: &str) -> Result<PathBuf> {
        Ok(self.task_run_dir(task_run_id)?.join("setup.log"))
    }

    fn prepare_task_shell_env(
        &self,
        task_id: &str,
        _project: &Project,
        _profile: &crate::ExecutionProfile,
        _task_run_id: Option<&str>,
        cwd: &std::path::Path,
    ) -> Result<crate::TaskShellEnv> {
        *self.last_cwd.borrow_mut() = Some(cwd.to_string_lossy().into_owned());
        Ok(crate::TaskShellEnv {
            env: vec![
                ("MONICA_TASK_ID".to_string(), task_id.to_string()),
                ("MONICA_CWD".to_string(), cwd.to_string_lossy().into_owned()),
            ],
            settings_path: format!("/tmp/tasks/{task_id}/claude-settings.json"),
            wrapper_path: format!("/tmp/tasks/{task_id}/bin/claude"),
        })
    }

    fn append_hook_event(
        &self,
        _task_run_id: &str,
        _at: &str,
        _event_label: Option<&str>,
        _raw_stdin: &str,
    ) -> Result<()> {
        *self.appended.borrow_mut() = true;
        Ok(())
    }
}

pub(crate) struct FakeAuth;

impl AuthGateway for FakeAuth {
    fn status(&self) -> GithubAuthStatus {
        GithubAuthStatus {
            authenticated: true,
            source: "fake".to_string(),
            login: Some("user".to_string()),
            access_expires_at: None,
            refresh_expires_at: None,
            reauth_required: false,
            message: None,
        }
    }

    fn begin_device_flow<'a>(&'a self) -> BoxFuture<'a, Result<GithubDeviceFlow>> {
        Box::pin(async {
            Ok(GithubDeviceFlow {
                user_code: "CODE".to_string(),
                verification_uri: "https://github.com/login/device".to_string(),
                expires_at: 1,
                interval: 1,
                device_code: "device".to_string(),
            })
        })
    }

    fn wait_for_device_flow<'a>(
        &'a self,
        _flow: &'a GithubDeviceFlow,
    ) -> BoxFuture<'a, Result<GithubAuthStatus>> {
        Box::pin(async move { Ok(self.status()) })
    }

    fn logout<'a>(&'a self) -> BoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

fn task_from_new(id: String, new: NewTask) -> Task {
    Task {
        id: TaskId::from_store(id),
        kind: new.kind,
        status: new.status,
        phase: new.phase,
        title: new.title,
        body: new.body,
        project_id: new.project_id,
        labels: new.labels,
        details: new.details,
        source: new.source,
        primary_task_run_id: None,
        closed_at: None,
        created_at: "2026-06-02T00:00:00.000Z".to_string(),
        updated_at: "2026-06-02T00:00:00.000Z".to_string(),
    }
}


pub(crate) fn hook_ctx<'a>(task_id: &'a str, task_run_id: Option<&'a str>) -> HookContext<'a> {
    HookContext {
        task_id: Some(task_id),
        task_run_id,
        terminal_tab_id: None,
    }
}

pub(crate) fn hook_ctx_in_tab<'a>(
    task_id: &'a str,
    task_run_id: Option<&'a str>,
    terminal_tab_id: &'a str,
) -> HookContext<'a> {
    HookContext {
        task_id: Some(task_id),
        task_run_id,
        terminal_tab_id: Some(terminal_tab_id),
    }
}

/// A task whose primary run is Prepared but not yet claimed by any session.
pub(crate) fn task_with_prepared_primary(repos: &mut FakeRepos) -> (String, String) {
    let task_id = repos.insert_task_for_run(None);
    let run = repos
        .start_task_run(NewTaskRun {
            task_id: TaskId::from_store(task_id.clone()),
            agent: Some(Agent::Claude),
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    repos
        .finish_task_run(&run.id, &task_id, TaskRunStatus::Prepared)
        .unwrap();
    repos.set_primary_task_run(&task_id, &run.id).unwrap();
    (task_id, run.id.into_string())
}

/// A task with a primary run claimed by `sess-1` and actively working (the steady state after
/// the Run button and the first prompt).
pub(crate) fn task_with_running_primary(repos: &mut FakeRepos, outputs: &FakeTaskRunOutputs) -> (String, String) {
    let (task_id, run_id) = task_with_prepared_primary(repos);
    record_claude_hook(
        repos,
        outputs,
        hook_ctx(&task_id, Some(&run_id)),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    record_claude_hook(
        repos,
        outputs,
        hook_ctx(&task_id, Some(&run_id)),
        &prompt("sess-1"),
    )
    .unwrap();
    (task_id, run_id)
}



#[derive(Default)]
pub(crate) struct FakeSetupRunner {
    outcome: RefCell<Option<SetupOutcome>>,
    error: RefCell<Option<String>>,
}

impl FakeSetupRunner {
    pub(crate) fn with_outcome(outcome: SetupOutcome) -> Self {
        Self { outcome: RefCell::new(Some(outcome)), ..Default::default() }
    }

    pub(crate) fn with_error(message: impl Into<String>) -> Self {
        Self { error: RefCell::new(Some(message.into())), ..Default::default() }
    }
}

impl SetupRunner for FakeSetupRunner {
    fn run_setup_script(
        &self,
        _worktree: &Path,
        _log_path: &Path,
        _env: &SetupEnv,
        _timeout: std::time::Duration,
    ) -> Result<SetupOutcome> {
        if let Some(msg) = self.error.borrow().clone() {
            return Err(anyhow!(msg));
        }
        Ok(self
            .outcome
            .borrow()
            .clone()
            .unwrap_or(SetupOutcome::Succeeded))
    }
}

/// The registered project all run tests use; `path` is required by `execute_run`.
pub(crate) fn insert_runnable_project(repos: &FakeRepos) {
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/repo".to_string());
    repos.insert_project(project);
}

pub(crate) fn insert_issue_backed_task(repos: &mut FakeRepos, issue_number: i64) -> String {
    let mut new = NewTask::new(TaskKind::Development, "tracked");
    new.project_id = Some("owner/repo".to_string());
    repos
        .insert_task_with_ref(
            new,
            ExternalReference {
                id: 0,
                task_id: String::new(),
                provider: Provider::Github,
                ref_type: RefType::Issue,
                repo: Some("owner/repo".to_string()),
                number: Some(issue_number),
                url: None,
                created_at: "2026-06-02T00:00:00.000Z".to_string(),
            },
        )
        .unwrap()
        .id
        .into_string()
}


pub(crate) fn make_task(id: &str, status: TaskStatus, primary_run_id: Option<&str>) -> Task {
    Task {
        id: TaskId::from_store(id.to_string()),
        kind: TaskKind::Development,
        status,
        phase: None,
        title: "test".to_string(),
        body: String::new(),
        project_id: None,
        labels: Vec::new(),
        details: RawJson::empty_object(),
        source: None,
        primary_task_run_id: primary_run_id.map(|s| TaskRunId::from_store(s.to_string())),
        closed_at: None,
        created_at: "2026-06-02T00:00:00.000Z".to_string(),
        updated_at: "2026-06-02T00:00:00.000Z".to_string(),
    }
}

pub(crate) fn make_run(id: &str, task_id: &str, status: TaskRunStatus) -> TaskRun {
    TaskRun {
        id: TaskRunId::from_store(id.to_string()),
        task_id: TaskId::from_store(task_id.to_string()),
        agent: Some(Agent::Claude),
        branch: None,
        worktree_path: None,
        status,
        wait_reason: None,
        settings_path: None,
        provider_session_id: None,
        terminal_tab_id: None,
        last_event_name: None,
        last_event_at: None,
        plan_file_path: None,
        pending_stop: false,
        metadata: RawJson::empty_object(),
        created_at: "2026-06-02T00:00:00.000Z".to_string(),
        updated_at: "2026-06-02T00:00:00.000Z".to_string(),
    }
}


impl FakeRepos {
    pub(crate) fn seed_run(&self, run: TaskRun) {
        self.state.borrow_mut().runs.insert(run.id.to_string(), run);
    }

    pub(crate) fn seed_session(&self, session: TerminalSession) {
        self.state.borrow_mut().terminal_sessions.push(session);
    }

    pub(crate) fn seed_pr_branch_candidate(&self, candidate: PullRequestBranchSyncCandidate) {
        self.state.borrow_mut().pr_branch_candidate = Some(candidate);
    }

    pub(crate) fn fail_mark_started(&self) {
        self.state.borrow_mut().mark_started_fails = true;
    }

    pub(crate) fn pr_branch_success_count(&self) -> usize {
        self.state.borrow().pr_branch_success_count
    }
}

impl TerminalSessionRepository for FakeRepos {
    fn create_terminal_session(&mut self, new: NewTerminalSession) -> Result<TerminalSession> {
        let mut state = self.state.borrow_mut();
        state.next_session += 1;
        let session = TerminalSession {
            id: format!("ts-{}", state.next_session),
            runspace_id: new.runspace_id,
            tab_id: new.tab_id,
            kind: new.kind,
            cwd: new.cwd,
            shell: new.shell,
            status: TerminalSessionStatus::Starting,
            pid: None,
            rows: new.rows,
            cols: new.cols,
            transcript_path: None,
            exit_code: None,
            started_at: None,
            last_seen_at: None,
            exited_at: None,
            created_at: "2026-06-02T00:00:00.000Z".to_string(),
            updated_at: "2026-06-02T00:00:00.000Z".to_string(),
        };
        state.terminal_sessions.push(session.clone());
        Ok(session)
    }

    fn mark_terminal_session_started(&self, id: &str, pid: Option<u32>) -> Result<()> {
        if self.state.borrow().mark_started_fails {
            return Err(anyhow!("mark started failed"));
        }
        if let Some(s) = self.state.borrow_mut().terminal_sessions.iter_mut().find(|s| s.id == id) {
            s.status = TerminalSessionStatus::Running;
            s.pid = pid;
        }
        Ok(())
    }

    fn update_terminal_session_status(
        &mut self,
        id: &str,
        status: TerminalSessionStatus,
        exit_code: Option<i32>,
    ) -> Result<()> {
        if let Some(s) = self.state.borrow_mut().terminal_sessions.iter_mut().find(|s| s.id == id) {
            s.status = status;
            s.exit_code = exit_code;
        }
        Ok(())
    }

    fn get_terminal_session(&self, id: &str) -> Result<Option<TerminalSession>> {
        Ok(self.state.borrow().terminal_sessions.iter().find(|s| s.id == id).cloned())
    }

    fn latest_terminal_session_for_tab(&self, tab_id: &str) -> Result<Option<TerminalSession>> {
        Ok(self
            .state
            .borrow()
            .terminal_sessions
            .iter()
            .rev()
            .find(|s| s.tab_id.as_deref() == Some(tab_id))
            .cloned())
    }

    fn list_terminal_sessions(&self, runspace_id: Option<&str>) -> Result<Vec<TerminalSession>> {
        Ok(self
            .state
            .borrow()
            .terminal_sessions
            .iter()
            .filter(|s| runspace_id.is_none_or(|r| s.runspace_id.as_deref() == Some(r)))
            .cloned()
            .collect())
    }

    fn apply_terminal_session_updates(&mut self, updates: &[TerminalSessionUpdate]) -> Result<()> {
        let mut state = self.state.borrow_mut();
        for update in updates {
            if let Some(s) =
                state.terminal_sessions.iter_mut().find(|s| s.id == update.session_id)
            {
                s.status = update.status;
                if update.pid.is_some() {
                    s.pid = update.pid;
                }
                if update.exit_code.is_some() {
                    s.exit_code = update.exit_code;
                }
            }
        }
        Ok(())
    }

    fn load_terminal_state(&self, _window_label: &str) -> Result<TerminalStateSnapshot> {
        Ok(TerminalStateSnapshot { runspaces: Vec::new() })
    }

    fn save_terminal_state(
        &mut self,
        _window_label: &str,
        _snapshot: &TerminalStateSnapshot,
    ) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone, Default)]
pub(crate) struct RecordingSink(Arc<Mutex<Vec<ApplicationEvent>>>);

impl RecordingSink {
    pub(crate) fn events(&self) -> Vec<ApplicationEvent> {
        self.0.lock().unwrap().clone()
    }
}

impl EventSink for RecordingSink {
    fn emit(&self, event: ApplicationEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[derive(Default)]
pub(crate) struct FakeNotebookGateway;

impl NotebookGateway for FakeNotebookGateway {
    fn page_counts(&self) -> Result<Vec<(String, usize)>> {
        Ok(Vec::new())
    }
    fn read_docs(&self, _slug: &str) -> Result<Option<(Vec<NotebookDoc>, Vec<LintFinding>)>> {
        Ok(None)
    }
    fn create(&self, slug: &str) -> Result<PathBuf> {
        Ok(PathBuf::from("/tmp/notebooks").join(slug))
    }
}

#[derive(Default)]
pub(crate) struct FakeWorkspace;

impl Workspace for FakeWorkspace {
    fn scaffold_monica(&self, _dir: &Path) -> Result<Vec<(String, bool)>> {
        Ok(vec![(".monica/setup.sh".to_string(), true)])
    }
}

#[derive(Default)]
pub(crate) struct FakeDaemon {
    create_fails: bool,
    write_fails: bool,
    pub(crate) created: Mutex<Vec<TerminalCreateRequest>>,
    pub(crate) written: Mutex<Vec<(String, Vec<u8>)>>,
    pub(crate) terminated: Mutex<Vec<String>>,
}

impl FakeDaemon {
    pub(crate) fn failing_create() -> Self {
        Self { create_fails: true, ..Self::default() }
    }

    pub(crate) fn failing_write() -> Self {
        Self { write_fails: true, ..Self::default() }
    }
}

impl TerminalDaemon for FakeDaemon {
    fn create(&self, request: TerminalCreateRequest) -> Result<Option<u32>> {
        self.created.lock().unwrap().push(request);
        if self.create_fails {
            Err(anyhow!("daemon spawn failed"))
        } else {
            Ok(Some(4321))
        }
    }
    fn write_input(&self, session_id: &str, data: &[u8]) -> Result<()> {
        if self.write_fails {
            return Err(anyhow!("daemon write failed"));
        }
        self.written.lock().unwrap().push((session_id.to_string(), data.to_vec()));
        Ok(())
    }
    fn attach(&self, _session_id: &str, _replay_bytes: Option<u32>) -> Result<TerminalAttachment> {
        Ok(TerminalAttachment { replay: String::new(), rows: 24, cols: 80 })
    }
    fn detach(&self, _session_id: &str) -> Result<()> {
        Ok(())
    }
    fn terminate(&self, session_id: &str) -> Result<()> {
        self.terminated.lock().unwrap().push(session_id.to_string());
        Ok(())
    }
    fn list_views(&self) -> Result<Vec<DaemonSessionView>> {
        Ok(Vec::new())
    }
    fn reap(&self, _session_id: &str) {}
}

/// Test double for the agent-decoder port. Holds the signal/label it should return so a façade
/// test can drive `ingest_agent_hook` deterministically without the real per-agent decoders.
#[derive(Default)]
pub(crate) struct TestAgentDecoders {
    signal: Option<AgentSignal>,
    label: Option<String>,
}

impl TestAgentDecoders {
    pub(crate) fn with_signal(signal: AgentSignal) -> Self {
        Self { signal: Some(signal), label: None }
    }

    pub(crate) fn with_label(label: impl Into<String>) -> Self {
        Self { signal: None, label: Some(label.into()) }
    }
}

impl AgentDecoders for TestAgentDecoders {
    fn decode(&self, _agent: Agent, _raw: &[u8]) -> Result<Option<AgentSignal>> {
        Ok(self.signal.clone())
    }
    fn event_label(&self, _raw: &[u8]) -> Option<String> {
        self.label.clone()
    }
}

pub(crate) struct FakeBackend;

impl Backend for FakeBackend {
    type Repos = FakeRepos;
    type Git = FakeGit;
    type Github = FakeGithub;
    type Auth = FakeAuth;
    type Setup = FakeSetupRunner;
    type Outputs = FakeTaskRunOutputs;
    type Notebooks = FakeNotebookGateway;
    type Workspace = FakeWorkspace;
    type Agents = TestAgentDecoders;
}

pub(crate) fn facade(repos: FakeRepos, sink: RecordingSink) -> Monica<FakeBackend> {
    facade_with_decoder(repos, sink, TestAgentDecoders::default())
}

pub(crate) fn facade_with_decoder(
    repos: FakeRepos,
    sink: RecordingSink,
    agents: TestAgentDecoders,
) -> Monica<FakeBackend> {
    Monica::new(
        repos,
        FakeGit::default(),
        FakeGithub,
        FakeAuth,
        FakeSetupRunner::default(),
        FakeTaskRunOutputs::default(),
        FakeNotebookGateway,
        FakeWorkspace,
        agents,
        Box::new(sink),
    )
}

pub(crate) fn driven_run(id: &str, task_id: &str, tab: &str) -> TaskRun {
    TaskRun {
        id: TaskRunId::from_store(id.to_string()),
        task_id: TaskId::from_store(task_id.to_string()),
        agent: None,
        branch: None,
        worktree_path: None,
        status: TaskRunStatus::Running,
        wait_reason: None,
        settings_path: None,
        provider_session_id: Some("sess".to_string()),
        terminal_tab_id: Some(tab.to_string()),
        last_event_name: None,
        last_event_at: None,
        plan_file_path: None,
        pending_stop: false,
        metadata: RawJson::empty_object(),
        created_at: "2026-06-02T00:00:00.000Z".to_string(),
        updated_at: "2026-06-02T00:00:00.000Z".to_string(),
    }
}

pub(crate) fn fake_session(id: &str, tab: Option<&str>, status: TerminalSessionStatus) -> TerminalSession {
    TerminalSession {
        id: id.to_string(),
        runspace_id: None,
        tab_id: tab.map(str::to_string),
        kind: TerminalSessionKind::Shell,
        cwd: "/".to_string(),
        shell: "/bin/zsh".to_string(),
        status,
        pid: None,
        rows: 24,
        cols: 80,
        transcript_path: None,
        exit_code: None,
        started_at: None,
        last_seen_at: None,
        exited_at: None,
        created_at: "2026-06-02T00:00:00.000Z".to_string(),
        updated_at: "2026-06-02T00:00:00.000Z".to_string(),
    }
}

pub(crate) fn stopped_runs(events: &[ApplicationEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            ApplicationEvent::TaskRunStatusChanged { task_run_id, status, .. }
                if *status == TaskRunStatus::Stopped =>
            {
                Some(task_run_id.clone())
            }
            _ => None,
        })
        .collect()
}
