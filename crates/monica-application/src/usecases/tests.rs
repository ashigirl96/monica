use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use monica_domain::RawJson;

use crate::ports::{
    BoxFuture, EventRepository, GitGateway, ProjectRepository, PullRequestSyncStore, TaskBoardQuery,
    TaskRunStore, TaskStore, TaskSummaryFilter, UnitOfWork, WorkTransaction, WorkbenchStore,
};
use crate::{
    ApplicationError, AuthGateway, Clock, GithubGateway, SetupEnv, SetupOutcome, SetupRunner,
    TaskRunOutputs,
};
use super::runs::record_hook::{
    resolve_by_lazy_create, resolve_by_prepared_primary, resolve_by_session, RunResolveCtx,
};
use crate::{
    begin_github_device_flow, close_issue, create_raw_task, execute_run, github_auth_status,
    logout_github,
    make_main_by_terminal_tab, open_bench, prepare_claude_for_run, primary_terminal_tab,
    record_hook, register_project_with_default_branch,
    start_run,
    sync_next_pull_request,
    track_github_issue, AgentSignal, Continuation, HookContext, MakeMainOutcome, Provider, RefType,
    SignalKind,
    wait_for_github_device_flow, Agent, DisplayStatus, Event, ExternalReference, GithubAuthStatus,
    GithubDeviceFlow, GithubIssue, GithubPullRequest, GithubPullRequestRef,
    GithubPullRequestStatus, NewTask, NewTaskRun, Project, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncStatus, Task,
    TaskBench, TaskKind, TaskRun, TaskRunObservation, TaskRunStatus, TaskRunWaitReason, TaskStatus,
    TaskSummaryRow, TrackGithubIssueInput,
};
use crate::ports::{
    NotebookGateway, TerminalAttachment, TerminalCreateRequest, TerminalDaemon,
    TerminalSessionRepository, Workspace,
};
use crate::{
    ApplicationEvent, Backend, DaemonSessionView, EventSink, LintFinding, Monica, NewTerminalSession,
    NotebookDoc, TerminalSession, TerminalSessionKind, TerminalSessionStatus, TerminalSessionUpdate,
    TerminalStateSnapshot,
};
use std::sync::{Arc, Mutex};

// --- Agent-signal test builders -------------------------------------------------------------------
// The use-case tests drive `record_hook` with typed `AgentSignal`s (the provider JSON -> signal
// decoding is covered by the adapter decoder's own tests in `monica-infra::agents`). `raw_stdin` is
// irrelevant to these assertions, so the shim feeds a constant.

fn mk_signal(session: Option<&str>, label: &str, kind: SignalKind) -> AgentSignal {
    AgentSignal {
        session_id: session.map(str::to_string),
        event_label: Some(label.to_string()),
        kind,
    }
}

fn started(session: &str, continuation: Continuation) -> AgentSignal {
    mk_signal(Some(session), "SessionStart", SignalKind::SessionStarted { continuation })
}

fn started_no_session(continuation: Continuation) -> AgentSignal {
    mk_signal(None, "SessionStart", SignalKind::SessionStarted { continuation })
}

fn prompt(session: &str) -> AgentSignal {
    mk_signal(Some(session), "UserPromptSubmit", SignalKind::PromptSubmitted)
}

fn turn_completed(session: &str, subagents_running: bool) -> AgentSignal {
    mk_signal(Some(session), "Stop", SignalKind::TurnCompleted { subagents_running })
}

fn subagent_finished(session: &str, subagents_running: bool) -> AgentSignal {
    mk_signal(Some(session), "SubagentStop", SignalKind::SubagentFinished { subagents_running })
}

fn session_ended(session: &str) -> AgentSignal {
    mk_signal(Some(session), "SessionEnd", SignalKind::SessionEnded)
}

fn input_required(session: Option<&str>, reason: TaskRunWaitReason) -> AgentSignal {
    mk_signal(
        session,
        "PreToolUse",
        SignalKind::UserInputRequired { reason, plan_file_path: None },
    )
}

fn input_resolved(session: &str) -> AgentSignal {
    mk_signal(Some(session), "PostToolUse", SignalKind::UserInputResolved)
}

fn inert_event(session: &str, label: &str) -> AgentSignal {
    mk_signal(Some(session), label, SignalKind::Inert)
}

/// Thin shim mirroring the production boundary: a decoded Claude signal handed to `record_hook`.
fn record_claude_hook<R, A>(
    repos: &mut R,
    outputs: &A,
    ctx: HookContext<'_>,
    signal: &AgentSignal,
) -> Result<crate::HookReport>
where
    R: TaskStore + TaskRunStore + EventRepository + Clock,
    A: TaskRunOutputs,
{
    record_hook(repos, outputs, ctx, Agent::Claude, Some(signal), "{}")
}

#[derive(Default)]
struct FakeRepos {
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
}

impl FakeRepos {
    fn insert_project(&self, project: Project) {
        self.state
            .borrow_mut()
            .projects
            .insert(project.id.clone(), project);
    }

    fn insert_task_for_run(&mut self, project_id: Option<String>) -> String {
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
        state.tasks.insert(task.id.clone(), task.clone());
        Ok(task)
    }

    fn do_insert_task_with_ref(
        &self,
        new: NewTask,
        mut external: ExternalReference,
    ) -> Result<Task> {
        let task = self.do_insert_task(new)?;
        external.id = 1;
        external.task_id = task.id.clone();
        self.state
            .borrow_mut()
            .refs
            .entry(task.id.clone())
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
            .primary_task_run_id = Some(task_run_id.to_string());
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
                    id: task.id.clone(),
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
    fn upsert_project(&self, project: &Project) -> Result<Project> {
        self.insert_project(project.clone());
        Ok(project.clone())
    }

    fn get_project(&self, id: &str) -> Result<Option<Project>> {
        Ok(self.state.borrow().projects.get(id).cloned())
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
            id: id.clone(),
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
        if let Some(task) = state.tasks.get_mut(&new.task_id) {
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
    fn begin(&self) -> Result<Box<dyn WorkTransaction + '_>> {
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

    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        self.inner.do_record_task_run_observation(task_run_id, observation)
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

struct FakeGithub;

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
}

#[derive(Default)]
struct FakeGit {
    cleaned: RefCell<bool>,
}

impl GitGateway for FakeGit {
    fn create_worktree(
        &self,
        _repo: &Path,
        _worktree: &Path,
        _branch: &str,
        _base: &str,
    ) -> Result<()> {
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
struct FakeTaskRunOutputs {
    appended: RefCell<bool>,
    last_cwd: RefCell<Option<String>>,
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
        _project: &crate::Project,
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

struct FakeAuth;

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
        id,
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

#[test]
fn register_project_records_normalized_repo_and_branch() {
    let repos = FakeRepos::default();
    let project = register_project_with_default_branch(
        &repos,
        "Owner/Repo",
        Path::new("/repo"),
        Some("trunk"),
    )
    .unwrap();
    assert_eq!(project.id, "owner/repo");
    assert_eq!(project.default_branch, "trunk");
    assert_eq!(project.path.as_deref(), Some("/repo"));
}

#[tokio::test]
async fn track_github_issue_uses_gateway_and_repositories() {
    let mut repos = FakeRepos::default();
    repos.insert_project(Project::from_repo("owner/repo"));
    let report = track_github_issue(
        &mut repos,
        &FakeGithub,
        TrackGithubIssueInput {
            repo: "Owner/Repo".to_string(),
            number: 42,
        },
    )
    .await
    .unwrap();
    assert_eq!(report.task.id, "MON-1");
    assert_eq!(report.task.project_id.as_deref(), Some("owner/repo"));
    assert_eq!(report.issue.number, 42);

    let refs = repos.list_external_refs(&report.task.id).unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].provider, Provider::Github);
    assert_eq!(refs[0].ref_type, RefType::Issue);
    assert_eq!(refs[0].number, Some(42));
}

#[test]
fn create_raw_task_links_project_and_has_no_issue_ref() {
    let mut repos = FakeRepos::default();
    repos.insert_project(Project::from_repo("owner/repo"));
    let task = create_raw_task(&mut repos, "  explore idea  ", "owner/repo").unwrap();
    assert_eq!(task.title, "explore idea");
    assert_eq!(task.project_id.as_deref(), Some("owner/repo"));
    assert!(repos.list_external_refs(&task.id).unwrap().is_empty());
}

#[test]
fn create_raw_task_rejects_blank_title() {
    let mut repos = FakeRepos::default();
    repos.insert_project(Project::from_repo("owner/repo"));
    let err = create_raw_task(&mut repos, "   ", "owner/repo").unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
}

#[test]
fn create_raw_task_rejects_unknown_project() {
    let mut repos = FakeRepos::default();
    let err = create_raw_task(&mut repos, "explore", "owner/repo").unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)), "{err:?}");
}

#[test]
fn close_issue_delegates_run_cleanup_to_git_gateway() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    repos
        .start_task_run(NewTaskRun {
            task_id: task_id.clone(),
            agent: None,
            branch: Some("issue-42".to_string()),
            worktree_path: Some("/tmp/wt".to_string()),
        })
        .unwrap();
    let git = FakeGit::default();
    let report = close_issue(&mut repos, &git, &task_id).unwrap();
    assert_eq!(report.removed_branches, vec!["issue-42"]);
    assert!(*git.cleaned.borrow());
}

fn hook_ctx<'a>(task_id: &'a str, task_run_id: Option<&'a str>) -> HookContext<'a> {
    HookContext {
        task_id: Some(task_id),
        task_run_id,
        terminal_tab_id: None,
    }
}

fn hook_ctx_in_tab<'a>(
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
fn task_with_prepared_primary(repos: &mut FakeRepos) -> (String, String) {
    let task_id = repos.insert_task_for_run(None);
    let run = repos
        .start_task_run(NewTaskRun {
            task_id: task_id.clone(),
            agent: Some(Agent::Claude),
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    repos
        .finish_task_run(&run.id, &task_id, TaskRunStatus::Prepared)
        .unwrap();
    repos.set_primary_task_run(&task_id, &run.id).unwrap();
    (task_id, run.id)
}

/// A task with a primary run claimed by `sess-1` and actively working (the steady state after
/// the Run button and the first prompt).
fn task_with_running_primary(repos: &mut FakeRepos, outputs: &FakeTaskRunOutputs) -> (String, String) {
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

#[test]
fn record_claude_hook_records_waiting_transition_and_run_output() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let run = repos
        .start_task_run(NewTaskRun {
            task_id: task_id.clone(),
            agent: Some(Agent::Claude),
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    let outputs = FakeTaskRunOutputs::default();
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run.id)),
        &input_required(None, TaskRunWaitReason::AskUserQuestion),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert_eq!(
        repos.get_task_run(&run.id).unwrap().unwrap().wait_reason,
        Some(TaskRunWaitReason::AskUserQuestion)
    );
    assert!(*outputs.appended.borrow());
}

#[test]
fn record_claude_hook_forwards_plan_file_path_from_the_signal() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);

    let plan = AgentSignal {
        session_id: Some("sess-1".to_string()),
        event_label: Some("PreToolUse".to_string()),
        kind: SignalKind::UserInputRequired {
            reason: TaskRunWaitReason::ExitPlanMode,
            plan_file_path: Some("/Users/me/.claude/plans/x.md".to_string()),
        },
    };
    record_claude_hook(&mut repos, &outputs, hook_ctx(&task_id, Some(&run_id)), &plan).unwrap();

    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::ExitPlanMode));
    assert_eq!(run.plan_file_path.as_deref(), Some("/Users/me/.claude/plans/x.md"));
}

#[test]
fn record_claude_hook_claims_prepared_primary_run_without_run_id() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_prepared_primary(&mut repos);
    let outputs = FakeTaskRunOutputs::default();

    // The session opens but nothing runs yet: the claim lands as "your turn".
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    let claimed = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(claimed.status, TaskRunStatus::WaitingForUser);
    assert_eq!(claimed.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));

    // The first prompt is what actually puts the agent to work...
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &prompt("sess-1"),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Running));
    assert_eq!(
        repos.get_task_run(&run_id).unwrap().unwrap().wait_reason,
        None
    );

    // ...and the finished turn hands the ball back to the user, not to the morgue.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert_eq!(
        repos.get_task_run(&run_id).unwrap().unwrap().wait_reason,
        Some(TaskRunWaitReason::AwaitingPrompt)
    );
}

#[test]
fn entered_waiting_for_user_marks_only_the_entering_edge() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);

    // Running -> WaitingForUser: the entering edge.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert!(report.entered_waiting_for_user);

    // A trailing Stop re-affirms the generic wait, but the run was already waiting: not an edge,
    // so it must not notify again.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert!(!report.entered_waiting_for_user);

    // Back to Running, then a terminal transition: a non-waiting landing is never an edge.
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        &prompt("sess-1"),
    )
    .unwrap();
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        &session_ended("sess-1"),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Stopped));
    assert!(!report.entered_waiting_for_user);
}

#[test]
fn record_claude_hook_does_not_claim_prepared_primary_on_stray_stop() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_prepared_primary(&mut repos);
    let outputs = FakeTaskRunOutputs::default();

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &turn_completed("sess-stray", false),
    )
    .unwrap();
    assert!(!report.task_run_linked);
    assert!(!report.task_run_created);
    assert!(report.event_recorded);
    let primary = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(primary.status, TaskRunStatus::Prepared);
    assert_eq!(primary.provider_session_id, None);
}

#[test]
fn record_claude_hook_does_not_create_runs_for_rejected_run_id() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let task_id = repos.insert_task_for_run(None);

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some("../evil")),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.unsafe_task_run_id);
    assert!(!report.task_run_linked);
    assert!(!report.task_run_created);
    assert!(repos.list_task_runs_for_task(&task_id).unwrap().is_empty());
}

#[test]
fn record_claude_hook_creates_side_run_instead_of_stealing_active_primary() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos, &outputs);

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert!(report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));

    // The primary is neither stolen nor re-pointed.
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(task.primary_task_run_id.as_deref(), Some(primary_id.as_str()));
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.status, TaskRunStatus::Running);
    assert_eq!(primary.provider_session_id.as_deref(), Some("sess-1"));

    let side = repos
        .find_task_run_by_session(&task_id, "sess-2")
        .unwrap()
        .unwrap();
    assert_ne!(side.id, primary_id);
    assert_eq!(side.status, TaskRunStatus::WaitingForUser);
    assert_eq!(side.agent, Some(Agent::Claude));
    // the session's cwd must never become a worktree_path (delete-time cleanup rips those)
    assert_eq!(side.worktree_path, None);
}

#[test]
fn record_claude_hook_fork_session_start_does_not_steal_primary_tab() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos, &outputs);
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, Some(&primary_id), "tab-main"),
        &prompt("sess-1"),
    )
    .unwrap();

    // A fork's SessionStart fires from the new tab while still carrying the source session's id.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, None, "tab-fork"),
        &started("sess-1", Continuation::Resume),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, None);
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.terminal_tab_id.as_deref(), Some("tab-main"));
    // The source run is mid-flight; the fork's start must not demote it to "your turn".
    assert_eq!(primary.status, TaskRunStatus::Running);

    // The fork's first prompt arrives under its own id and becomes a side run in the fork tab.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, None, "tab-fork"),
        &prompt("sess-2"),
    )
    .unwrap();
    assert!(report.task_run_created);
    let side = repos
        .find_task_run_by_session(&task_id, "sess-2")
        .unwrap()
        .unwrap();
    assert_eq!(side.terminal_tab_id.as_deref(), Some("tab-fork"));
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.terminal_tab_id.as_deref(), Some("tab-main"));
    assert_eq!(
        repos
            .find_task_run_by_terminal_tab("tab-main")
            .unwrap()
            .unwrap()
            .id,
        primary_id
    );
}

#[test]
fn record_claude_hook_resumed_session_rebinds_tab_on_first_prompt() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos, &outputs);
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, Some(&primary_id), "tab-main"),
        &prompt("sess-1"),
    )
    .unwrap();

    // Resuming in another tab proves nothing yet (it could be a fork)...
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, None, "tab-new"),
        &started("sess-1", Continuation::Resume),
    )
    .unwrap();
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.terminal_tab_id.as_deref(), Some("tab-main"));

    // ...the first prompt under the same session id is what moves the binding.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, None, "tab-new"),
        &prompt("sess-1"),
    )
    .unwrap();
    assert!(!report.task_run_created);
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.terminal_tab_id.as_deref(), Some("tab-new"));
}

#[test]
fn record_claude_hook_follows_side_run_through_its_lifecycle() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos, &outputs);
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &input_required(Some("sess-2"), TaskRunWaitReason::AskUserQuestion),
    )
    .unwrap();
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));

    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &input_resolved("sess-2"),
    )
    .unwrap();
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &session_ended("sess-2"),
    )
    .unwrap();
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Stopped));
    assert_eq!(
        repos.get_task_run(&primary_id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );
}

#[test]
fn record_claude_hook_compact_session_start_does_not_demote_running_primary() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos, &outputs);

    // Auto-compact fires SessionStart mid-turn under the same session id.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &started("sess-1", Continuation::Compact),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert_eq!(report.task_run_status, None);
    assert_eq!(
        repos.get_task_run(&primary_id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );
}

#[test]
fn record_claude_hook_stop_preserves_tool_specific_wait() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &input_required(Some("sess-1"), TaskRunWaitReason::AskUserQuestion),
    )
    .unwrap();

    // The Stop that trails the question must not blur "needs you" into "your turn".
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, None);
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AskUserQuestion));
}

#[test]
fn record_claude_hook_stop_during_subagent_keeps_run_running() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);

    // A Stop whose background_tasks still reports a running subagent must not flicker the run to
    // "your turn".
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", true),
    )
    .unwrap();
    assert_eq!(report.task_run_status, None);
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Running);
    assert!(run.pending_stop);

    // Once background_tasks is empty, the Stop settles the turn.
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

/// A `Stop` held by a running subagent is released by the `SubagentStop` that leaves nothing in
/// flight — the deferred transition fires and the entering edge is reported so a notification can
/// be pushed. The SubagentStop snapshot still lists the stopping agent, so it is excluded by id.
#[test]
fn record_claude_hook_deferred_stop_fires_on_last_subagent_stop() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);

    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", true),
    )
    .unwrap();
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Running);
    assert!(run.pending_stop);

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &subagent_finished("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert!(report.entered_waiting_for_user);
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    assert!(!run.pending_stop);
}

/// The subagent guard reads `background_tasks` per event, so it self-heals through Claude's
/// re-injection cycle (a `<task-notification>` UserPromptSubmit then a fresh Stop) and is not
/// fooled by a start-less `SubagentStop` whose agent is absent from the snapshot — the two
/// real-world hook glitches behind MON-73 and MON-131.
#[test]
fn record_claude_hook_subagent_guard_tracks_background_tasks() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);

    let status = |repos: &FakeRepos| repos.get_task_run(&run_id).unwrap().unwrap().status;
    let fire = |repos: &mut FakeRepos, sig: &AgentSignal| {
        record_claude_hook(repos, &outputs, hook_ctx(&task_id, None), sig).unwrap()
    };

    // Two subagents running: the Stop is held.
    fire(&mut repos, &turn_completed("sess-1", true));
    assert_eq!(status(&repos), TaskRunStatus::Running);

    // A start-less SubagentStop whose agent is not in the snapshot must not release the hold.
    fire(&mut repos, &subagent_finished("sess-1", true));
    assert_eq!(status(&repos), TaskRunStatus::Running);

    // Claude re-injects a finished subagent's result as a UserPromptSubmit; the parent is working
    // again, so the run follows to Running.
    fire(&mut repos, &prompt("sess-1"));
    assert_eq!(status(&repos), TaskRunStatus::Running);

    // The parent comes to rest with an empty background_tasks: now it settles to "your turn".
    fire(&mut repos, &turn_completed("sess-1", false));
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

#[test]
fn record_claude_hook_late_stop_does_not_resurrect_stopped_run() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();
    assert_eq!(
        repos.get_task_run(&run_id).unwrap().unwrap().status,
        TaskRunStatus::Stopped
    );

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, None);
    assert_eq!(
        repos.get_task_run(&run_id).unwrap().unwrap().status,
        TaskRunStatus::Stopped
    );
}

#[test]
fn record_claude_hook_fresh_session_start_revives_stopped_run() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();

    // Relaunching claude in the wrapper tab starts a brand-new session under the same
    // MONICA_TASK_RUN_ID; its SessionStart must bring the run back to "your turn".
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    assert_eq!(run.provider_session_id.as_deref(), Some("sess-2"));
}

#[test]
fn record_claude_hook_session_end_settles_waiting_run() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();

    // A waiting run is still a live session; its death is a fact that must land.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Stopped));
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Stopped);
    assert_eq!(run.wait_reason, None);
}

#[test]
fn record_claude_hook_stale_terminal_verdict_does_not_kill_revived_run() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();

    // Stragglers arrive through the pinned MONICA_TASK_RUN_ID after the relaunch, but neither
    // may touch the run sess-2 now owns: the dead session's SessionEnd is a stale terminal
    // verdict (session-scoped), and StopFailure is inert by design — never the run's verdict.
    for payload in [
        &session_ended("sess-1"),
        &inert_event("sess-1", "StopFailure"),
    ] {
        let report =
            record_claude_hook(&mut repos, &outputs, hook_ctx(&task_id, Some(&run_id)), payload)
                .unwrap();
        assert_eq!(report.task_run_status, None, "{payload:?}");
        let run = repos.get_task_run(&run_id).unwrap().unwrap();
        assert_eq!(run.status, TaskRunStatus::WaitingForUser, "{payload:?}");
        assert_eq!(
            run.wait_reason,
            Some(TaskRunWaitReason::AwaitingPrompt),
            "{payload:?}"
        );
    }
}

#[test]
fn record_claude_hook_resume_session_start_lands_created_run_as_awaiting_prompt() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let outputs = FakeTaskRunOutputs::default();

    // Resuming an old conversation in a bench tab of a task with no primary lazily creates a
    // run; the continuation suppression is scoped to Running, so the new run must land at
    // "your turn" instead of being parked at setting_up with no way to settle it.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, None, "tab-resume"),
        &started("sess-9", Continuation::Resume),
    )
    .unwrap();
    assert!(report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));

    let task = repos.get_task(&task_id).unwrap().unwrap();
    let primary_id = task.primary_task_run_id.expect("created run becomes primary");
    let run = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    // A resume start still carries the source session's id, so the tab claim keeps waiting
    // for the first activity event.
    assert_eq!(run.terminal_tab_id, None);
}

#[test]
fn record_claude_hook_resume_session_start_revives_stopped_run_it_resolves() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();

    // `claude --resume` of a brand-new conversation lands through the pinned run id with a
    // session the run has never seen: that is new life, same as a startup start.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        &started("sess-3", Continuation::Resume),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

#[test]
fn record_claude_hook_promotes_created_run_when_no_primary_is_set() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let outputs = FakeTaskRunOutputs::default();

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_created);

    let task = repos.get_task(&task_id).unwrap().unwrap();
    let primary_id = task.primary_task_run_id.expect("created run becomes primary");
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.provider_session_id.as_deref(), Some("sess-1"));
    assert_eq!(primary.status, TaskRunStatus::WaitingForUser);
    assert_eq!(primary.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

#[test]
fn record_claude_hook_repairs_dangling_primary_pointer() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    repos.set_primary_task_run(&task_id, "run-999").unwrap();
    let outputs = FakeTaskRunOutputs::default();

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_created);

    let task = repos.get_task(&task_id).unwrap().unwrap();
    let primary_id = task.primary_task_run_id.unwrap();
    assert_ne!(primary_id, "run-999");
    assert!(repos.get_task_run(&primary_id).unwrap().is_some());
}

#[test]
fn record_claude_hook_does_not_create_runs_for_non_session_starting_events() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, _) = task_with_running_primary(&mut repos, &outputs);

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &turn_completed("sess-unknown", false),
    )
    .unwrap();
    assert!(!report.task_run_linked);
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, None);
    assert!(report.event_recorded);
    assert_eq!(repos.list_task_runs_for_task(&task_id).unwrap().len(), 1);
}

#[test]
fn record_claude_hook_does_not_create_runs_without_a_session_id() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, _) = task_with_running_primary(&mut repos, &outputs);

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &started_no_session(Continuation::Fresh),
    )
    .unwrap();
    assert!(!report.task_run_linked);
    assert!(!report.task_run_created);
}

#[test]
fn record_claude_hook_creates_side_run_on_user_prompt_submit() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, _) = task_with_running_primary(&mut repos, &outputs);

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &prompt("sess-2"),
    )
    .unwrap();
    assert!(report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Running));
}

#[test]
fn record_claude_hook_does_not_create_runs_for_done_tasks() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, _) = task_with_running_primary(&mut repos, &outputs);
    repos.update_task_status(&task_id, TaskStatus::Closed).unwrap();

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();
    assert!(!report.task_run_created);
    assert!(!report.task_run_linked);
    assert_eq!(
        repos.get_task(&task_id).unwrap().unwrap().status,
        TaskStatus::Closed
    );
}

#[test]
fn record_claude_hook_records_terminal_tab_id_from_context() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, _) = task_with_running_primary(&mut repos, &outputs);

    record_claude_hook(
        &mut repos,
        &outputs,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-7"),
        },
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();

    let side = repos
        .find_task_run_by_session(&task_id, "sess-2")
        .unwrap()
        .unwrap();
    assert_eq!(side.terminal_tab_id.as_deref(), Some("tab-7"));
    assert_eq!(
        repos
            .find_task_run_by_terminal_tab("tab-7")
            .unwrap()
            .unwrap()
            .id,
        side.id
    );
}

#[test]
fn make_main_by_terminal_tab_promotes_side_run_and_reports_no_ops() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos, &outputs);

    assert_eq!(
        make_main_by_terminal_tab(&repos, "tab-unknown").unwrap(),
        MakeMainOutcome::NotFound
    );

    // Side run born in tab-2, then a restarted claude in the same tab: newest run must win.
    record_claude_hook(
        &mut repos,
        &outputs,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-2"),
        },
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();
    record_claude_hook(
        &mut repos,
        &outputs,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-2"),
        },
        &started("sess-3", Continuation::Fresh),
    )
    .unwrap();
    let latest_in_tab = repos
        .find_task_run_by_session(&task_id, "sess-3")
        .unwrap()
        .unwrap();

    let outcome = make_main_by_terminal_tab(&repos, "tab-2").unwrap();
    assert_eq!(
        outcome,
        MakeMainOutcome::Changed {
            task_id: task_id.clone(),
            task_run_id: latest_in_tab.id.clone(),
            status: TaskRunStatus::WaitingForUser,
        }
    );
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(
        task.primary_task_run_id.as_deref(),
        Some(latest_in_tab.id.as_str())
    );
    assert_ne!(task.primary_task_run_id.as_deref(), Some(primary_id.as_str()));

    assert_eq!(
        make_main_by_terminal_tab(&repos, "tab-2").unwrap(),
        MakeMainOutcome::AlreadyMain
    );
}

#[test]
fn make_main_by_terminal_tab_refuses_while_primary_is_mid_prepare() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let task_id = repos.insert_task_for_run(None);
    // A SettingUp primary, as left behind by start_run while execute_run is in flight.
    let preparing = repos
        .start_task_run(NewTaskRun {
            task_id: task_id.clone(),
            agent: None,
            branch: Some("issue-1".to_string()),
            worktree_path: None,
        })
        .unwrap();
    repos.set_primary_task_run(&task_id, &preparing.id).unwrap();

    record_claude_hook(
        &mut repos,
        &outputs,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-2"),
        },
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();

    assert_eq!(
        make_main_by_terminal_tab(&repos, "tab-2").unwrap(),
        MakeMainOutcome::PrimaryBusy
    );
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(task.primary_task_run_id.as_deref(), Some(preparing.id.as_str()));
}

#[test]
fn primary_terminal_tab_resolves_through_primary_run() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let task_id = repos.insert_task_for_run(None);
    assert_eq!(primary_terminal_tab(&repos, &task_id).unwrap(), None);

    record_claude_hook(
        &mut repos,
        &outputs,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-1"),
        },
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert_eq!(
        primary_terminal_tab(&repos, &task_id).unwrap().as_deref(),
        Some("tab-1")
    );
}

#[test]
fn record_claude_hook_prefers_explicit_run_id_over_session_lookup() {
    let mut repos = FakeRepos::default();
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos, &outputs);
    let other = repos
        .start_task_run(NewTaskRun {
            task_id: task_id.clone(),
            agent: Some(Agent::Claude),
            branch: None,
            worktree_path: None,
        })
        .unwrap();

    // sess-1 belongs to the primary, but the explicit run id must win.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&other.id)),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert!(!report.task_run_created);
    assert_eq!(
        repos.get_task_run(&other.id).unwrap().unwrap().status,
        TaskRunStatus::WaitingForUser
    );
    assert_ne!(other.id, primary_id);
}

#[tokio::test]
async fn sync_pull_requests_records_branch_gateway_result() {
    let mut repos = FakeRepos::default();
    repos.state.borrow_mut().pr_branch_candidate = Some(PullRequestBranchSyncCandidate {
        task_id: "MON-1".to_string(),
        repo: "owner/repo".to_string(),
        branch: "issue-42".to_string(),
    });
    let result = sync_next_pull_request(&mut repos, &FakeGithub)
        .await
        .unwrap();
    assert_eq!(result.status, PullRequestSyncStatus::Synced);
    assert_eq!(repos.state.borrow().pr_branch_success_count, 1);
}

#[test]
fn github_auth_status_uses_auth_gateway() {
    let status = github_auth_status(&FakeAuth);
    assert!(status.authenticated);
    assert_eq!(status.source, "fake");
}

#[tokio::test]
async fn github_auth_flow_usecases_delegate_to_auth_gateway() {
    let auth = FakeAuth;
    let flow = begin_github_device_flow(&auth).await.unwrap();
    assert_eq!(flow.user_code, "CODE");
    let status = wait_for_github_device_flow(&auth, &flow).await.unwrap();
    assert_eq!(status.login.as_deref(), Some("user"));
    logout_github(&auth).await.unwrap();
}

#[test]
fn default_bench_cwd_prefers_project_path() {
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    assert_eq!(
        super::runs::open_bench::default_bench_cwd(Some(&project), Some("/home/user")),
        "/test/repo"
    );
}

#[test]
fn default_bench_cwd_falls_back_to_home_dir_when_no_project_path() {
    let project = Project::from_repo("owner/repo");
    assert_eq!(
        super::runs::open_bench::default_bench_cwd(Some(&project), Some("/home/user")),
        "/home/user"
    );
}

#[test]
fn default_bench_cwd_falls_back_to_tmp_when_no_project_and_no_home() {
    assert_eq!(
        super::runs::open_bench::default_bench_cwd(None, None),
        "/tmp"
    );
}

#[test]
fn open_bench_falls_back_to_project_path_when_worktree_path_is_empty() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let run = repos
        .start_task_run(NewTaskRun {
            task_id: task_id.clone(),
            agent: None,
            branch: None,
            worktree_path: Some(String::new()),
        })
        .unwrap();
    repos.set_primary_task_run(&task_id, &run.id).unwrap();

    let outputs = FakeTaskRunOutputs::default();
    let bench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    assert!(bench.created);
    assert_eq!(bench.cwd, "/test/repo");
}

#[test]
fn open_bench_creates_bench_on_first_call_and_reuses_on_second() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let outputs = FakeTaskRunOutputs::default();

    let bench: TaskBench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    assert!(bench.created);
    assert_eq!(bench.cwd, "/test/repo");
    assert_eq!(bench.task_id, task_id);

    let bench2: TaskBench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    assert!(!bench2.created);
    assert_eq!(bench2.runspace_id, bench.runspace_id);
}

fn env_value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

#[test]
fn open_bench_writes_hook_settings_into_resolved_cwd() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let outputs = FakeTaskRunOutputs::default();

    let bench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    assert_eq!(env_value(&bench.env, "MONICA_CWD"), Some(bench.cwd.as_str()));
    assert_eq!(outputs.last_cwd.borrow().as_deref(), Some(bench.cwd.as_str()));
}

#[test]
fn task_shell_env_uses_existing_bench_cwd() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let outputs = FakeTaskRunOutputs::default();

    let bench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    let env = super::runs::task_shell_env(&repos, &outputs, &task_id).unwrap();
    assert_eq!(env_value(&env, "MONICA_CWD"), Some(bench.cwd.as_str()));
}

#[test]
fn task_shell_env_falls_back_to_worktree_when_no_bench() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    // `/tmp` exists, so it passes the is_usable_worktree existence check.
    let run = repos
        .start_task_run(NewTaskRun {
            task_id: task_id.clone(),
            agent: None,
            branch: None,
            worktree_path: Some("/tmp".to_string()),
        })
        .unwrap();
    repos.set_primary_task_run(&task_id, &run.id).unwrap();

    let outputs = FakeTaskRunOutputs::default();
    let env = super::runs::task_shell_env(&repos, &outputs, &task_id).unwrap();
    assert_eq!(env_value(&env, "MONICA_CWD"), Some("/tmp"));
}

#[test]
fn task_shell_env_falls_back_to_project_path_when_no_bench_no_worktree() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let outputs = FakeTaskRunOutputs::default();
    let env = super::runs::task_shell_env(&repos, &outputs, &task_id).unwrap();
    assert_eq!(env_value(&env, "MONICA_CWD"), Some("/test/repo"));
}


#[derive(Default)]
struct FakeSetupRunner {
    outcome: RefCell<Option<SetupOutcome>>,
}

impl SetupRunner for FakeSetupRunner {
    fn run_setup_script(
        &self,
        _worktree: &Path,
        _log_path: &Path,
        _env: &SetupEnv,
        _timeout: std::time::Duration,
    ) -> Result<SetupOutcome> {
        Ok(self
            .outcome
            .borrow()
            .clone()
            .unwrap_or(SetupOutcome::Succeeded))
    }
}

/// The registered project all run tests use; `path` is required by `execute_run`.
fn insert_runnable_project(repos: &FakeRepos) {
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/repo".to_string());
    repos.insert_project(project);
}

fn insert_issue_backed_task(repos: &mut FakeRepos, issue_number: i64) -> String {
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
}

#[test]
fn start_run_names_branch_from_mon_id_and_creates_bench() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let prep = start_run(&mut repos, &task_id).unwrap();

    assert_eq!(prep.branch, "mon-1");
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(task.primary_task_run_id.as_deref(), Some(prep.task_run_id.as_str()));
    let (_, cwd) = repos.get_bench_for_task(&task_id).unwrap().unwrap();
    assert_eq!(cwd, "/repo");
}

#[test]
fn start_run_prefers_linked_issue_number_for_branch() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = insert_issue_backed_task(&mut repos, 9);

    let prep = start_run(&mut repos, &task_id).unwrap();
    assert_eq!(prep.branch, "issue-9");
}

#[test]
fn start_run_rejects_active_primary_run() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    start_run(&mut repos, &task_id).unwrap();

    let err = start_run(&mut repos, &task_id).unwrap_err();
    assert!(matches!(err, ApplicationError::Conflict(_)), "{err:?}");
    assert!(err.to_string().contains("already has an active run"), "{err}");
}

#[test]
fn start_run_rejects_closed_task() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    repos.update_task_status(&task_id, TaskStatus::Closed).unwrap();

    let err = start_run(&mut repos, &task_id).unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
    assert!(err.to_string().contains("is closed"), "{err}");
}

#[test]
fn start_run_missing_task_is_not_found() {
    let mut repos = FakeRepos::default();
    let err = start_run(&mut repos, "MON-404").unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)), "{err:?}");
}

#[test]
fn execute_run_records_failed_on_setup_failure() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let prep = start_run(&mut repos, &task_id).unwrap();
    let setup = FakeSetupRunner {
        outcome: RefCell::new(Some(SetupOutcome::Failed {
            code: Some(1),
            timed_out: false,
        })),
    };

    let status = execute_run(
        &mut repos,
        &FakeGit::default(),
        &setup,
        &FakeTaskRunOutputs::default(),
        &task_id,
        &prep.task_run_id,
    )
    .unwrap();

    assert_eq!(status, TaskRunStatus::Failed);
    let run = repos.get_task_run(&prep.task_run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Failed);
    assert_eq!(
        run.worktree_path.as_deref(),
        Some("/repo/.worktrees/mon-1"),
        "worktree path is recorded even when setup fails"
    );
}

#[test]
fn execute_run_prepares_run_and_pins_bench_to_worktree() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let prep = start_run(&mut repos, &task_id).unwrap();

    let status = execute_run(
        &mut repos,
        &FakeGit::default(),
        &FakeSetupRunner::default(),
        &FakeTaskRunOutputs::default(),
        &task_id,
        &prep.task_run_id,
    )
    .unwrap();

    assert_eq!(status, TaskRunStatus::Prepared);
    let run = repos.get_task_run(&prep.task_run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Prepared);
    let (_, cwd) = repos.get_bench_for_task(&task_id).unwrap().unwrap();
    assert_eq!(cwd, "/repo/.worktrees/mon-1");
}

#[test]
fn prepare_claude_for_run_rejects_non_prepared_primary() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    start_run(&mut repos, &task_id).unwrap();

    let err = prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap_err();
    assert!(err.to_string().contains("expected prepared"), "{err}");
}

#[test]
fn prepare_claude_for_run_rejects_missing_worktree() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let prep = start_run(&mut repos, &task_id).unwrap();
    repos
        .finish_task_run(&prep.task_run_id, &task_id, TaskRunStatus::Prepared)
        .unwrap();

    let err = prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap_err();
    assert!(err.to_string().contains("no worktree path"), "{err}");

    repos
        .set_task_run_worktree_path(&prep.task_run_id, "/nonexistent/worktree")
        .unwrap();
    let err = prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap_err();
    assert!(err.to_string().contains("worktree does not exist"), "{err}");
}

fn prepared_run_with_worktree(repos: &mut FakeRepos, task_id: &str, prompt_body: &str) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    let prep = start_run(repos, task_id).unwrap();
    repos
        .finish_task_run(&prep.task_run_id, task_id, TaskRunStatus::Prepared)
        .unwrap();

    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let worktree =
        std::env::temp_dir().join(format!("monica-prep-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(worktree.join(".monica")).unwrap();
    std::fs::write(worktree.join(".monica/prompt.md"), prompt_body).unwrap();
    repos
        .set_task_run_worktree_path(&prep.task_run_id, &worktree.to_string_lossy())
        .unwrap();
    worktree
}

#[test]
fn prepare_claude_for_run_seeds_prompt_for_issue_backed_task() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = insert_issue_backed_task(&mut repos, 7);

    let worktree = prepared_run_with_worktree(&mut repos, &task_id, "do the thing");
    let result =
        prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap();
    std::fs::remove_dir_all(&worktree).ok();

    assert_eq!(result.initial_command, "claude 'do the thing'");
}

#[test]
fn prepare_claude_for_run_ignores_prompt_for_raw_task() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = create_raw_task(&mut repos, "explore idea", "owner/repo")
        .unwrap()
        .id;

    let worktree = prepared_run_with_worktree(&mut repos, &task_id, "leftover prompt");
    let result =
        prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap();
    std::fs::remove_dir_all(&worktree).ok();

    assert_eq!(result.initial_command, "claude");
}

// --- resolve rule unit tests ---

fn make_task(id: &str, status: TaskStatus, primary_run_id: Option<&str>) -> Task {
    Task {
        id: id.to_string(),
        kind: TaskKind::Development,
        status,
        phase: None,
        title: "test".to_string(),
        body: String::new(),
        project_id: None,
        labels: Vec::new(),
        details: RawJson::empty_object(),
        source: None,
        primary_task_run_id: primary_run_id.map(str::to_string),
        closed_at: None,
        created_at: "2026-06-02T00:00:00.000Z".to_string(),
        updated_at: "2026-06-02T00:00:00.000Z".to_string(),
    }
}

fn make_run(id: &str, task_id: &str, status: TaskRunStatus) -> TaskRun {
    TaskRun {
        id: id.to_string(),
        task_id: task_id.to_string(),
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

#[test]
fn resolve_by_session_returns_none_without_session_id() {
    let mut repos = FakeRepos::default();
    let task = make_task("t1", TaskStatus::Ready, None);
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: None,
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_session(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_session_returns_run_when_found() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();

    record_claude_hook(
        &mut repos,
        &FakeTaskRunOutputs::default(),
        HookContext { task_id: Some(&task_id), task_run_id: None, terminal_tab_id: None },
        &started("sess-1", Continuation::Fresh),
    ).unwrap();

    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        starts_session: false,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_session(&ctx, &mut repos).unwrap();
    assert!(result.is_some());
    assert!(!result.unwrap().created);
}

#[test]
fn resolve_by_prepared_primary_skips_non_prepared() {
    let task = make_task("t1", TaskStatus::InProgress, Some("run-1"));
    let run = make_run("run-1", "t1", TaskRunStatus::Running);
    let mut repos = FakeRepos::default();
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    let result = resolve_by_prepared_primary(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_prepared_primary_skips_non_starting_event() {
    let task = make_task("t1", TaskStatus::Ready, Some("run-1"));
    let run = make_run("run-1", "t1", TaskRunStatus::Prepared);
    let mut repos = FakeRepos::default();
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        starts_session: false,
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    let result = resolve_by_prepared_primary(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_prepared_primary_claims_on_session_start() {
    let task = make_task("t1", TaskStatus::Ready, Some("run-1"));
    let run = make_run("run-1", "t1", TaskRunStatus::Prepared);
    let mut repos = FakeRepos::default();
    repos.seed_run(run.clone());
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    let result = resolve_by_prepared_primary(&ctx, &mut repos).unwrap();
    let resolved = result.unwrap();
    assert!(!resolved.created);
    let resolved_run = resolved.run.unwrap();
    assert_eq!(resolved_run.id, "run-1");
    // The atomic claim stamped the session, and the returned snapshot reflects the post-claim row.
    assert_eq!(resolved_run.provider_session_id.as_deref(), Some("sess-1"));
}

#[test]
fn resolve_by_prepared_primary_loses_race_when_already_claimed() {
    let task = make_task("t1", TaskStatus::Ready, Some("run-1"));
    let mut run = make_run("run-1", "t1", TaskRunStatus::Prepared);
    // Another SessionStart won the claim first: the run is prepared but already carries a session.
    run.provider_session_id = Some("sess-winner".to_string());
    let mut repos = FakeRepos::default();
    repos.seed_run(run.clone());
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-loser"),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    // The loser changes 0 rows and falls through (Ok(None)) so lazy-create makes it a side run.
    assert!(resolve_by_prepared_primary(&ctx, &mut repos).unwrap().is_none());
    assert_eq!(
        repos.get_task_run("run-1").unwrap().unwrap().provider_session_id.as_deref(),
        Some("sess-winner")
    );
}

#[test]
fn resolve_by_lazy_create_rejects_without_session_id() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: None,
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_lazy_create_rejects_non_starting_event() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        starts_session: false,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_lazy_create_rejects_when_explicit_run_id_rejected() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: true,
        provider_session_id: Some("sess-1"),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_lazy_create_rejects_closed_task() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    repos.mark_task_closed(&task_id).unwrap();
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_lazy_create_creates_primary_when_none_exists() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    let resolved = result.unwrap();
    assert!(resolved.created);
    let run = resolved.run.unwrap();
    let updated_task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(updated_task.primary_task_run_id.as_deref(), Some(run.id.as_str()));
}

#[test]
fn resolve_by_lazy_create_creates_side_run_when_primary_exists() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let existing_primary = make_run("run-existing", &task_id, TaskRunStatus::Running);
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: Some(&existing_primary),
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    let resolved = result.unwrap();
    assert!(resolved.created);
    let updated_task = repos.get_task(&task_id).unwrap().unwrap();
    assert!(updated_task.primary_task_run_id.is_none());
}

// ---------------------------------------------------------------------------
// Façade orchestration tests
//
// The pure decision functions (task_run_settlement_for_*, reconcile_terminal_sessions) and the
// store CAS guard (settle_task_run_if_live) are tested elsewhere. These exercise the composition
// the façade adds on top: fetch rows → call the pure verdict → apply → emit, end to end against a
// fake backend, asserting the emitted ApplicationEvents.
// ---------------------------------------------------------------------------

impl FakeRepos {
    fn seed_run(&self, run: TaskRun) {
        self.state.borrow_mut().runs.insert(run.id.clone(), run);
    }

    fn seed_session(&self, session: TerminalSession) {
        self.state.borrow_mut().terminal_sessions.push(session);
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

    fn load_terminal_state(&self) -> Result<TerminalStateSnapshot> {
        Ok(TerminalStateSnapshot { runspaces: Vec::new() })
    }

    fn save_terminal_state(&mut self, _snapshot: &TerminalStateSnapshot) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone, Default)]
struct RecordingSink(Arc<Mutex<Vec<ApplicationEvent>>>);

impl RecordingSink {
    fn events(&self) -> Vec<ApplicationEvent> {
        self.0.lock().unwrap().clone()
    }
}

impl EventSink for RecordingSink {
    fn emit(&self, event: ApplicationEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[derive(Default)]
struct FakeNotebookGateway;

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
struct FakeWorkspace;

impl Workspace for FakeWorkspace {
    fn scaffold_monica(&self, _dir: &Path) -> Result<Vec<(String, bool)>> {
        Ok(vec![(".monica/setup.sh".to_string(), true)])
    }
}

struct FakeDaemon {
    create_fails: bool,
}

impl TerminalDaemon for FakeDaemon {
    fn create(&self, _request: TerminalCreateRequest) -> Result<Option<u32>> {
        if self.create_fails {
            Err(anyhow!("daemon spawn failed"))
        } else {
            Ok(Some(4321))
        }
    }
    fn attach(&self, _session_id: &str, _replay_bytes: Option<u32>) -> Result<TerminalAttachment> {
        Ok(TerminalAttachment { replay: String::new(), rows: 24, cols: 80 })
    }
    fn detach(&self, _session_id: &str) -> Result<()> {
        Ok(())
    }
    fn terminate(&self, _session_id: &str) -> Result<()> {
        Ok(())
    }
    fn list_views(&self) -> Result<Vec<DaemonSessionView>> {
        Ok(Vec::new())
    }
    fn reap(&self, _session_id: &str) {}
}

struct FakeBackend;

impl Backend for FakeBackend {
    type Repos = FakeRepos;
    type Git = FakeGit;
    type Github = FakeGithub;
    type Auth = FakeAuth;
    type Setup = FakeSetupRunner;
    type Outputs = FakeTaskRunOutputs;
    type Notebooks = FakeNotebookGateway;
    type Workspace = FakeWorkspace;
}

fn facade(repos: FakeRepos, sink: RecordingSink) -> Monica<FakeBackend> {
    Monica::new(
        repos,
        FakeGit::default(),
        FakeGithub,
        FakeAuth,
        FakeSetupRunner { outcome: RefCell::new(None) },
        FakeTaskRunOutputs::default(),
        FakeNotebookGateway,
        FakeWorkspace,
        Box::new(sink),
    )
}

fn driven_run(id: &str, task_id: &str, tab: &str) -> TaskRun {
    TaskRun {
        id: id.to_string(),
        task_id: task_id.to_string(),
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

fn fake_session(id: &str, tab: Option<&str>, status: TerminalSessionStatus) -> TerminalSession {
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

fn stopped_runs(events: &[ApplicationEvent]) -> Vec<String> {
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

#[test]
fn facade_settles_run_on_terminal_exit() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-1", "MON-1", "tab-1"));
    repos.seed_session(fake_session("ts-1", Some("tab-1"), TerminalSessionStatus::Exited));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica
        .executions()
        .settle_runs_for_terminated_sessions(&["ts-1".to_string()]);

    assert_eq!(stopped_runs(&sink.events()), vec!["run-1".to_string()]);
}

#[test]
fn facade_skips_stale_exit_after_tab_respawn() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-1", "MON-1", "tab-1"));
    repos.seed_session(fake_session("ts-1", Some("tab-1"), TerminalSessionStatus::Exited));
    // A newer session in the same tab makes ts-1 no longer the latest.
    repos.seed_session(fake_session("ts-2", Some("tab-1"), TerminalSessionStatus::Running));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica
        .executions()
        .settle_runs_for_terminated_sessions(&["ts-1".to_string()]);

    assert!(sink.events().is_empty());
}

#[test]
fn facade_skips_exit_for_session_without_tab() {
    let repos = FakeRepos::default();
    repos.seed_session(fake_session("ts-1", None, TerminalSessionStatus::Exited));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica
        .executions()
        .settle_runs_for_terminated_sessions(&["ts-1".to_string()]);

    assert!(sink.events().is_empty());
}

#[test]
fn facade_does_not_settle_prepared_run_on_exit() {
    let repos = FakeRepos::default();
    let mut prepared = driven_run("run-1", "MON-1", "tab-1");
    prepared.status = TaskRunStatus::Prepared;
    repos.seed_run(prepared);
    repos.seed_session(fake_session("ts-1", Some("tab-1"), TerminalSessionStatus::Exited));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica
        .executions()
        .settle_runs_for_terminated_sessions(&["ts-1".to_string()]);

    assert!(sink.events().is_empty());
}

#[test]
fn facade_orphan_sweep_settles_only_dead_tabs() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-dead", "MON-1", "tab-dead"));
    repos.seed_run(driven_run("run-live", "MON-2", "tab-live"));
    repos.seed_session(fake_session("ts-dead", Some("tab-dead"), TerminalSessionStatus::Exited));
    repos.seed_session(fake_session("ts-live", Some("tab-live"), TerminalSessionStatus::Running));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica.executions().settle_orphaned_runs();

    assert_eq!(stopped_runs(&sink.events()), vec!["run-dead".to_string()]);
}

#[test]
fn facade_mark_all_sessions_lost_settles_live_sessions_only() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-1", "MON-1", "tab-1"));
    repos.seed_session(fake_session("ts-live", Some("tab-1"), TerminalSessionStatus::Running));
    // Already terminal: excluded from the lost set and not re-settled.
    repos.seed_session(fake_session("ts-done", Some("tab-2"), TerminalSessionStatus::Exited));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica.executions().mark_all_sessions_lost().unwrap();

    assert_eq!(stopped_runs(&sink.events()), vec!["run-1".to_string()]);
}

#[test]
fn facade_create_terminal_session_failure_marks_failed_and_settles() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-1", "MON-1", "tab-1"));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());
    let daemon = FakeDaemon { create_fails: true };
    let new = NewTerminalSession {
        runspace_id: Some("rs-1".to_string()),
        tab_id: Some("tab-1".to_string()),
        kind: TerminalSessionKind::Shell,
        cwd: "/".to_string(),
        shell: "/bin/zsh".to_string(),
        rows: 24,
        cols: 80,
    };

    let session = monica.executions().create_terminal_session(&daemon, new, Vec::new()).unwrap();

    assert_eq!(session.status, TerminalSessionStatus::Failed);
    assert_eq!(stopped_runs(&sink.events()), vec!["run-1".to_string()]);
}

#[tokio::test]
async fn facade_sync_pull_requests_counts_and_announces() {
    let repos = FakeRepos::default();
    repos.state.borrow_mut().pr_branch_candidate = Some(PullRequestBranchSyncCandidate {
        task_id: "MON-1".to_string(),
        repo: "owner/repo".to_string(),
        branch: "issue-1".to_string(),
    });
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    let count = monica.synchronization().sync_pull_requests(5, true).await.unwrap();

    assert_eq!(count, 1);
    assert!(sink
        .events()
        .iter()
        .any(|e| matches!(e, ApplicationEvent::PullRequestSyncCompleted { synced_count: 1 })));
}

#[tokio::test]
async fn facade_sync_pull_requests_stays_silent_without_announce() {
    let repos = FakeRepos::default();
    repos.state.borrow_mut().pr_branch_candidate = Some(PullRequestBranchSyncCandidate {
        task_id: "MON-1".to_string(),
        repo: "owner/repo".to_string(),
        branch: "issue-1".to_string(),
    });
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    let count = monica.synchronization().sync_pull_requests(5, false).await.unwrap();

    assert_eq!(count, 1);
    assert!(sink.events().is_empty());
}

#[tokio::test]
async fn facade_init_project_prefers_git_branch_over_github() {
    let repos = FakeRepos::default();
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    // FakeGit::detect_repo -> "owner/repo", detect_default_branch -> Some("main"): GitHub fallback
    // is never consulted.
    let report = monica.projects().init_project(None, Path::new("/repo")).await.unwrap();

    assert_eq!(report.project.repo, "owner/repo");
    assert_eq!(report.project.default_branch, "main");
    assert!(!report.scaffold.is_empty());
}
