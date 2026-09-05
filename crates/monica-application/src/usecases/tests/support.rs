use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use monica_domain::RawJson;

use crate::ports::{
    AgentDecoders, BoxFuture, EventRepository, GitGateway, NotificationOutboxStore,
    GithubIssueSyncStore, ProjectRepository, PullRequestSyncStore, TabAttachment, TaskBoardQuery,
    TaskRunStore, TaskStore,
    TaskSummaryFilter, TerminalAttachment, TerminalCreateRequest, TerminalDaemon,
    TerminalSessionRepository, UnitOfWork, WorkTransaction, WorkbenchStore, Workspace,
};
use crate::usecases::runs::record_hook;
use crate::prelude::{
    Agent, AgentSessionId, AgentSignal, Continuation, DisplayStatus, Event, ExternalReference,
    NewNotificationIntent, NewTask, NewTaskRun, NewTerminalSession,
    NotificationIntent, Project, Provider, RefType, RunspaceId, SignalKind, Task, TaskId, TaskKind, TaskRun,
    TaskRunId, TaskRunStatus, TaskRunWaitReason, TaskStatus, TerminalSession,
    AgentSessionStatus,
    TerminalSessionKind, TerminalSessionStatus,
};
use crate::{
    ApplicationEvent, AuthGateway, Backend, Clock, DaemonSessionView, EventSink, ExecutionProfile,
    FetchedIssue, GithubAuthStatus, GithubGateway, GithubIssue, GithubIssueState,
    GithubPullRequest, OpenIssueRef,
    GithubPullRequestRef, GithubPullRequestStatus, HookContext, Monica,
    PullRequestBranchSyncCandidate, RepoPullRequest, SetupEnv,
    SetupOutcome, UnresolvedPullRequestRef,
    SetupRunner, TaskRunObservation, TaskRunOutputs, TaskSummaryRow, TerminalSessionUpdate,
    TerminalStateSnapshot,
};
// The use-case tests drive `record_hook` with typed `AgentSignal`s (the agent JSON -> signal
// decoding is covered by the adapter decoder's own tests in `monica-adapters::agents`). `raw_stdin` is
// irrelevant to these assertions, so the shim feeds a constant.

fn mk_signal(session: Option<&str>, label: &str, kind: SignalKind) -> AgentSignal {
    AgentSignal {
        agent_session_id: session.map(AgentSessionId::from_agent),
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
pub(crate) fn record_claude_hook<R>(
    repos: &mut R,
    ctx: HookContext<'_>,
    signal: &AgentSignal,
) -> crate::ApplicationResult<crate::HookReport>
where
    R: TaskStore + TaskRunStore + EventRepository + Clock + UnitOfWork + TerminalSessionRepository,
{
    record_hook(repos, ctx, Agent::Claude, Some(signal), "{}")
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
    next_ref: i64,
    /// Mirrors `github_issue_ref_states`, keyed by external_ref id. Reads resolve titles through
    /// it exactly as the SQL `COALESCE(issue_state.title, tasks.title, '')` does, so the fake and
    /// the real store can't disagree about which title a tracked task shows.
    issue_ref_states: HashMap<i64, (String, GithubIssueState)>,
    branch_sync_candidates: Vec<PullRequestBranchSyncCandidate>,
    unresolved_pr_refs: Vec<UnresolvedPullRequestRef>,
    bulk_recorded: Vec<(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)>,
    status_recorded: Vec<(UnresolvedPullRequestRef, GithubPullRequest)>,
    explanations: Vec<monica_domain::Explanation>,
    next_explanation: i64,
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

    pub(crate) fn set_unresolved_pr_refs(&self, refs: Vec<UnresolvedPullRequestRef>) {
        self.state.borrow_mut().unresolved_pr_refs = refs;
    }

    pub(crate) fn bulk_recorded(
        &self,
    ) -> Vec<(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)> {
        self.state.borrow().bulk_recorded.clone()
    }

    pub(crate) fn status_recorded(&self) -> Vec<(UnresolvedPullRequestRef, GithubPullRequest)> {
        self.state.borrow().status_recorded.clone()
    }

    pub(crate) fn issue_ref_state(&self, external_ref_id: i64) -> Option<(String, GithubIssueState)> {
        self.state
            .borrow()
            .issue_ref_states
            .get(&external_ref_id)
            .cloned()
    }

    pub(crate) fn clear_issue_ref_states(&self) {
        self.state.borrow_mut().issue_ref_states.clear();
    }

    /// Override the stored snapshot with the cached issue title, mirroring the store's COALESCE.
    fn resolve_title(&self, mut task: Task) -> Task {
        let state = self.state.borrow();
        let cached = state
            .refs
            .get(task.id.as_str())
            .and_then(|refs| {
                refs.iter()
                    .filter(|r| r.ref_type == RefType::Issue)
                    .max_by_key(|r| r.id)
            })
            .and_then(|r| state.issue_ref_states.get(&r.id));
        if let Some((title, _)) = cached {
            task.title = title.clone();
        }
        task
    }

    pub(crate) fn insert_task_for_run(&mut self, project_id: Option<String>) -> TaskId {
        self.insert_task(NewTask {
            kind: TaskKind::Development,
            status: TaskStatus::Ready,
            title: Some("tracked".to_string()),
            body: None,
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
        state.tasks.insert(task.id.to_string(), task.clone());
        Ok(task)
    }

    fn do_insert_task_with_ref(
        &self,
        new: NewTask,
        mut external: ExternalReference,
    ) -> Result<Task> {
        let task = self.do_insert_task(new)?;
        {
            let mut state = self.state.borrow_mut();
            state.next_ref += 1;
            external.id = state.next_ref;
        }
        external.task_id = task.id.to_string();
        self.state
            .borrow_mut()
            .refs
            .entry(task.id.to_string())
            .or_default()
            .push(external);
        Ok(task)
    }

    fn do_find_open_task_by_external_ref(
        &self,
        provider: Provider,
        ref_type: RefType,
        repo: &str,
        number: i64,
    ) -> Result<Option<Task>> {
        let state = self.state.borrow();
        // Every fake task shares one created_at, so the `MON-<n>` counter stands in for creation
        // order when picking the newest match.
        let found = state
            .refs
            .values()
            .flatten()
            .filter(|r| {
                r.provider == provider
                    && r.ref_type == ref_type
                    && r.repo.as_deref() == Some(repo)
                    && r.number == Some(number)
            })
            .filter_map(|r| state.tasks.get(&r.task_id))
            .filter(|t| t.status != TaskStatus::Closed)
            .max_by_key(|t| {
                t.id.as_str()
                    .strip_prefix("MON-")
                    .and_then(|n| n.parse::<i64>().ok())
                    .unwrap_or(0)
            })
            .cloned();
        drop(state);
        Ok(found.map(|t| self.resolve_title(t)))
    }

    fn do_mark_task_closed(&self, id: &TaskId) -> Result<Task> {
        let mut state = self.state.borrow_mut();
        let task = state
            .tasks
            .get_mut(id.as_str())
            .ok_or_else(|| anyhow!("task not found: {id}"))?;
        task.status = TaskStatus::Closed;
        task.closed_at = Some("2026-06-02T00:00:00.000Z".to_string());
        Ok(task.clone())
    }

    fn do_mark_task(&self, id: &TaskId, status: TaskStatus, note: Option<&str>) -> Result<()> {
        let mut state = self.state.borrow_mut();
        let task = state
            .tasks
            .get_mut(id.as_str())
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

    fn get_task(&self, id: &TaskId) -> Result<Option<Task>> {
        let task = self.state.borrow().tasks.get(id.as_str()).cloned();
        Ok(task.map(|t| self.resolve_title(t)))
    }

    fn mark_task_closed(&mut self, id: &TaskId) -> Result<Task> {
        self.do_mark_task_closed(id)
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        let tasks: Vec<Task> = self.state.borrow().tasks.values().cloned().collect();
        Ok(tasks.into_iter().map(|t| self.resolve_title(t)).collect())
    }

    fn set_primary_task_run(&self, task_id: &TaskId, task_run_id: &TaskRunId) -> Result<()> {
        self.state
            .borrow_mut()
            .tasks
            .get_mut(task_id.as_str())
            .ok_or_else(|| anyhow!("task not found: {task_id}"))?
            .primary_task_run_id = Some(task_run_id.clone());
        Ok(())
    }

    fn update_task_status(&self, id: &TaskId, status: TaskStatus) -> Result<()> {
        self.state
            .borrow_mut()
            .tasks
            .get_mut(id.as_str())
            .ok_or_else(|| anyhow!("task not found: {id}"))?
            .status = status;
        Ok(())
    }

    fn mark_task(&mut self, id: &TaskId, status: TaskStatus, note: Option<&str>) -> Result<()> {
        self.do_mark_task(id, status, note)
    }

    fn list_external_refs(&self, task_id: &TaskId) -> Result<Vec<ExternalReference>> {
        Ok(self
            .state
            .borrow()
            .refs
            .get(task_id.as_str())
            .cloned()
            .unwrap_or_default())
    }

    fn find_open_task_by_external_ref(
        &self,
        provider: Provider,
        ref_type: RefType,
        repo: &str,
        number: i64,
    ) -> Result<Option<Task>> {
        self.do_find_open_task_by_external_ref(provider, ref_type, repo, number)
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
                let resolved = self.resolve_title(task.clone());
                TaskSummaryRow {
                    id: task.id.to_string(),
                    parent_task_id: task.parent_task_id.as_ref().map(|p| p.to_string()),
                    title: resolved.title,
                    project: task.project_id.clone(),
                    github_issue_number: None,
                    github_issue_url: None,
                    github_issue_state: None,
                    github_pull_requests: Vec::<GithubPullRequestRef>::new(),
                    task_status: task.status,
                    task_run_status: None,
                    task_run_wait_reason: None,
                    has_plan: false,
                    status: display,
                    prepare_eligible: display.prepare_eligible(),
                    run_eligible: display.run_eligible(),
                    run_needs_prepare: display.run_needs_prepare(false),
                    attach_eligible: display.attach_eligible(),
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
    fn all_branch_sync_candidates(&self) -> Result<Vec<PullRequestBranchSyncCandidate>> {
        Ok(self.state.borrow().branch_sync_candidates.clone())
    }

    fn all_unresolved_pull_request_refs(&self) -> Result<Vec<UnresolvedPullRequestRef>> {
        Ok(self.state.borrow().unresolved_pr_refs.clone())
    }

    fn bulk_record_pr_sync(
        &mut self,
        branch_entries: &[(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)],
        status_entries: &[(UnresolvedPullRequestRef, GithubPullRequest)],
    ) -> Result<()> {
        let mut state = self.state.borrow_mut();
        state.bulk_recorded.extend_from_slice(branch_entries);
        state.status_recorded.extend_from_slice(status_entries);
        Ok(())
    }
}

impl GithubIssueSyncStore for FakeRepos {
    fn all_open_task_issue_refs(&self) -> Result<Vec<OpenIssueRef>> {
        let state = self.state.borrow();
        let mut refs: Vec<OpenIssueRef> = state
            .refs
            .values()
            .flatten()
            .filter(|r| r.ref_type == RefType::Issue && r.provider == Provider::Github)
            .filter(|r| {
                state
                    .tasks
                    .get(&r.task_id)
                    .is_some_and(|t| t.status != TaskStatus::Closed)
            })
            .filter_map(|r| {
                Some(OpenIssueRef {
                    external_ref_id: r.id,
                    repo: r.repo.clone()?,
                    number: r.number?,
                })
            })
            .collect();
        refs.sort_by_key(|r| r.external_ref_id);
        Ok(refs)
    }

    fn bulk_record_issue_sync(&mut self, entries: &[(i64, FetchedIssue)]) -> Result<()> {
        for (external_ref_id, issue) in entries {
            let child_task_id = {
                let state = self.state.borrow();
                state
                    .refs
                    .values()
                    .flatten()
                    .find(|r| r.id == *external_ref_id)
                    .map(|r| r.task_id.clone())
            };
            // Same resolution the SQL store does: the parent is whichever open task tracks the
            // parent issue, in the repo that owns it, and never the child itself.
            let parent_task_id = match (&child_task_id, &issue.parent) {
                (Some(child), Some(address)) => self
                    .do_find_open_task_by_external_ref(
                        Provider::Github,
                        RefType::Issue,
                        &address.repo,
                        address.number,
                    )?
                    .map(|task| task.id)
                    .filter(|id| id.as_str() != child.as_str()),
                _ => None,
            };
            let mut state = self.state.borrow_mut();
            state
                .issue_ref_states
                .insert(*external_ref_id, (issue.title.clone(), issue.state));
            if let Some(task) = child_task_id.and_then(|id| state.tasks.get_mut(&id)) {
                task.parent_task_id = parent_task_id;
            }
        }
        Ok(())
    }

    fn upsert_issue_ref_state(
        &mut self,
        task_id: &str,
        repo: &str,
        number: i64,
        title: &str,
        state: GithubIssueState,
    ) -> Result<()> {
        let mut fake = self.state.borrow_mut();
        let external_ref_id = fake.refs.get(task_id).and_then(|refs| {
            refs.iter()
                .filter(|r| {
                    r.ref_type == RefType::Issue
                        && r.repo.as_deref() == Some(repo)
                        && r.number == Some(number)
                })
                .map(|r| r.id)
                .max()
        });
        if let Some(external_ref_id) = external_ref_id {
            fake.issue_ref_states
                .insert(external_ref_id, (title.to_string(), state));
        }
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
    ) || (run.status == TaskRunStatus::SettingUp && run.agent_session_id.is_some())
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
            agent_session_id: None,
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
        task_run_id: &TaskRunId,
        task_id: &TaskId,
        status: TaskRunStatus,
    ) -> Result<()> {
        let mut state = self.state.borrow_mut();
        state
            .runs
            .get_mut(task_run_id.as_str())
            .ok_or_else(|| anyhow!("task run not found: {task_run_id}"))?
            .status = status;
        if let Some(task) = state.tasks.get_mut(task_id.as_str()) {
            if task.status != TaskStatus::Closed {
                task.status = TaskStatus::InProgress;
            }
        }
        Ok(())
    }

    fn do_settle_task_run_if_live(&self, task_run_id: &TaskRunId, task_id: &TaskId) -> Result<bool> {
        let mut state = self.state.borrow_mut();
        let Some(run) = state.runs.get_mut(task_run_id.as_str()) else {
            return Ok(false);
        };
        if &run.task_id != task_id || !is_live_driven_run(run) {
            return Ok(false);
        }
        run.status = TaskRunStatus::Stopped;
        run.wait_reason = None;
        Ok(true)
    }

    fn do_attach_terminal_tab_to_task(
        &self,
        new: NewTaskRun,
        terminal_tab_id: &str,
        agent_session_id: Option<&AgentSessionId>,
    ) -> Result<TabAttachment> {
        let previous: Vec<(TaskRunId, TaskId)> = self
            .state
            .borrow()
            .runs
            .values()
            .filter(|run| run.terminal_tab_id.as_deref() == Some(terminal_tab_id))
            .map(|run| (run.id.clone(), run.task_id.clone()))
            .collect();
        // Mirrors the store: settle before unbinding, or a live run losing its tab could never
        // reach a terminal status again.
        for (run_id, task_id) in &previous {
            self.do_settle_task_run_if_live(run_id, task_id)?;
        }
        {
            let mut state = self.state.borrow_mut();
            for run in state.runs.values_mut() {
                if run.terminal_tab_id.as_deref() == Some(terminal_tab_id) {
                    run.terminal_tab_id = None;
                    if agent_session_id.is_some() && run.agent_session_id.as_ref() == agent_session_id {
                        run.agent_session_id = None;
                    }
                }
            }
        }

        let run = self.do_start_task_run(new)?;
        let run = {
            let mut state = self.state.borrow_mut();
            let stored = state
                .runs
                .get_mut(run.id.as_str())
                .ok_or_else(|| anyhow!("attached task run {} not found", run.id))?;
            stored.status = TaskRunStatus::Running;
            stored.terminal_tab_id = Some(terminal_tab_id.to_string());
            stored.agent_session_id = agent_session_id.cloned();
            stored.clone()
        };
        Ok(TabAttachment {
            run,
            detached_run_ids: previous.into_iter().map(|(id, _)| id).collect(),
        })
    }

    fn do_record_task_run_observation(
        &self,
        task_run_id: &TaskRunId,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        let mut state = self.state.borrow_mut();
        let run = state
            .runs
            .get_mut(task_run_id.as_str())
            .ok_or_else(|| anyhow!("task run not found: {task_run_id}"))?;
        if let Some(status) = observation.status {
            run.status = status;
        }
        if let Some(wait_reason) = observation.wait_reason {
            run.wait_reason = wait_reason;
        }
        if let Some(session) = observation.agent_session_id {
            run.agent_session_id = Some(session.clone());
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
        task_run_id: &TaskRunId,
        task_id: &TaskId,
        status: TaskRunStatus,
    ) -> Result<()> {
        self.do_finish_task_run(task_run_id, task_id, status)
    }

    fn set_task_run_worktree_path(&self, task_run_id: &TaskRunId, worktree_path: &str) -> Result<()> {
        self.state
            .borrow_mut()
            .runs
            .get_mut(task_run_id.as_str())
            .ok_or_else(|| anyhow!("task run not found: {task_run_id}"))?
            .worktree_path = Some(worktree_path.to_string());
        Ok(())
    }

    fn set_task_run_agent(&self, task_run_id: &TaskRunId, agent: Agent) -> Result<()> {
        self.state
            .borrow_mut()
            .runs
            .get_mut(task_run_id.as_str())
            .ok_or_else(|| anyhow!("task run not found: {task_run_id}"))?
            .agent = Some(agent);
        Ok(())
    }

    fn get_task_run(&self, id: &TaskRunId) -> Result<Option<TaskRun>> {
        Ok(self.state.borrow().runs.get(id.as_str()).cloned())
    }

    fn find_task_run_by_session(
        &self,
        task_id: &TaskId,
        agent_session_id: &AgentSessionId,
    ) -> Result<Option<TaskRun>> {
        Ok(self
            .state
            .borrow()
            .runs
            .values()
            .filter(|run| {
                &run.task_id == task_id
                    && run.agent_session_id.as_ref() == Some(agent_session_id)
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

    fn list_task_runs_for_task(&self, task_id: &TaskId) -> Result<Vec<TaskRun>> {
        Ok(self
            .state
            .borrow()
            .runs
            .values()
            .filter(|run| &run.task_id == task_id)
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

    fn settle_task_run_if_live(&mut self, task_run_id: &TaskRunId, task_id: &TaskId) -> Result<bool> {
        self.do_settle_task_run_if_live(task_run_id, task_id)
    }

    fn claim_prepared_run(
        &self,
        task_run_id: &TaskRunId,
        agent_session_id: &AgentSessionId,
    ) -> Result<bool> {
        // Mirror the SQLite guard: WHERE id=? AND status='prepared' AND agent_session_id IS NULL.
        let mut state = self.state.borrow_mut();
        let Some(run) = state.runs.get_mut(task_run_id.as_str()) else {
            return Ok(false);
        };
        if run.status == TaskRunStatus::Prepared && run.agent_session_id.is_none() {
            run.agent_session_id = Some(agent_session_id.clone());
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

    fn attach_terminal_tab_to_task(
        &mut self,
        new: NewTaskRun,
        terminal_tab_id: &str,
        agent_session_id: Option<&AgentSessionId>,
    ) -> Result<TabAttachment> {
        self.do_attach_terminal_tab_to_task(new, terminal_tab_id, agent_session_id)
    }

    fn record_task_run_observation(
        &mut self,
        task_run_id: &TaskRunId,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        self.do_record_task_run_observation(task_run_id, observation)
    }
}

impl EventRepository for FakeRepos {
    fn insert_event(
        &self,
        task_id: Option<&TaskId>,
        task_run_id: Option<&TaskRunId>,
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

    fn list_events(&self, task_id: Option<&TaskId>) -> Result<Vec<Event>> {
        Ok(self
            .state
            .borrow()
            .events
            .iter()
            .filter(|event| {
                task_id.is_none_or(|id| event.task_id.as_deref() == Some(id.as_str()))
            })
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

    fn cancel_notifications_for_run(&self, _task_run_id: &TaskRunId) -> Result<()> {
        Ok(())
    }

    fn cancel_notification_by_dedupe_key(&self, _dedupe_key: &str) -> Result<()> {
        Ok(())
    }
}

impl FakeRepos {
    fn do_create_bench(&self, task_id: &TaskId, runspace_id: &RunspaceId, cwd: &str) -> Result<()> {
        self.state
            .borrow_mut()
            .benches
            .insert(task_id.to_string(), (runspace_id.to_string(), cwd.to_string()));
        Ok(())
    }
}

impl WorkbenchStore for FakeRepos {
    fn get_bench_for_task(&self, task_id: &TaskId) -> Result<Option<(RunspaceId, String)>> {
        Ok(self
            .state
            .borrow()
            .benches
            .get(task_id.as_str())
            .map(|(runspace_id, cwd)| (RunspaceId::from_store(runspace_id.clone()), cwd.clone())))
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(RunspaceId, TaskId)>> {
        Ok(self
            .state
            .borrow()
            .benches
            .iter()
            .map(|(task_id, (runspace_id, _cwd))| {
                (RunspaceId::from_store(runspace_id.clone()), TaskId::from_store(task_id.clone()))
            })
            .collect())
    }

    fn create_bench(
        &mut self,
        task_id: &TaskId,
        runspace_id: &RunspaceId,
        cwd: &str,
    ) -> Result<()> {
        self.do_create_bench(task_id, runspace_id, cwd)
    }

    fn update_bench_cwd(&self, task_id: &TaskId, cwd: &str) -> Result<()> {
        if let Some(entry) = self.state.borrow_mut().benches.get_mut(task_id.as_str()) {
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

    fn get_task(&self, id: &TaskId) -> Result<Option<Task>> {
        self.inner.get_task(id)
    }

    fn mark_task_closed(&mut self, id: &TaskId) -> Result<Task> {
        self.inner.do_mark_task_closed(id)
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        self.inner.list_tasks()
    }

    fn set_primary_task_run(&self, task_id: &TaskId, task_run_id: &TaskRunId) -> Result<()> {
        self.inner.set_primary_task_run(task_id, task_run_id)
    }

    fn update_task_status(&self, id: &TaskId, status: TaskStatus) -> Result<()> {
        self.inner.update_task_status(id, status)
    }

    fn mark_task(&mut self, id: &TaskId, status: TaskStatus, note: Option<&str>) -> Result<()> {
        self.inner.do_mark_task(id, status, note)
    }

    fn list_external_refs(&self, task_id: &TaskId) -> Result<Vec<ExternalReference>> {
        self.inner.list_external_refs(task_id)
    }

    fn find_open_task_by_external_ref(
        &self,
        provider: Provider,
        ref_type: RefType,
        repo: &str,
        number: i64,
    ) -> Result<Option<Task>> {
        self.inner
            .do_find_open_task_by_external_ref(provider, ref_type, repo, number)
    }
}

impl TaskRunStore for FakeUow<'_> {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
        self.inner.do_start_task_run(new)
    }

    fn finish_task_run(
        &mut self,
        task_run_id: &TaskRunId,
        task_id: &TaskId,
        status: TaskRunStatus,
    ) -> Result<()> {
        self.inner.do_finish_task_run(task_run_id, task_id, status)
    }

    fn set_task_run_worktree_path(&self, task_run_id: &TaskRunId, worktree_path: &str) -> Result<()> {
        self.inner.set_task_run_worktree_path(task_run_id, worktree_path)
    }

    fn set_task_run_agent(&self, task_run_id: &TaskRunId, agent: Agent) -> Result<()> {
        self.inner.set_task_run_agent(task_run_id, agent)
    }

    fn get_task_run(&self, id: &TaskRunId) -> Result<Option<TaskRun>> {
        self.inner.get_task_run(id)
    }

    fn find_task_run_by_session(
        &self,
        task_id: &TaskId,
        agent_session_id: &AgentSessionId,
    ) -> Result<Option<TaskRun>> {
        self.inner.find_task_run_by_session(task_id, agent_session_id)
    }

    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>> {
        self.inner.find_task_run_by_terminal_tab(terminal_tab_id)
    }

    fn list_task_runs_for_task(&self, task_id: &TaskId) -> Result<Vec<TaskRun>> {
        self.inner.list_task_runs_for_task(task_id)
    }

    fn list_driven_task_runs_with_tab(&self) -> Result<Vec<TaskRun>> {
        self.inner.list_driven_task_runs_with_tab()
    }

    fn settle_task_run_if_live(&mut self, task_run_id: &TaskRunId, task_id: &TaskId) -> Result<bool> {
        self.inner.do_settle_task_run_if_live(task_run_id, task_id)
    }

    fn claim_prepared_run(
        &self,
        task_run_id: &TaskRunId,
        agent_session_id: &AgentSessionId,
    ) -> Result<bool> {
        self.inner.claim_prepared_run(task_run_id, agent_session_id)
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

    fn attach_terminal_tab_to_task(
        &mut self,
        new: NewTaskRun,
        terminal_tab_id: &str,
        agent_session_id: Option<&AgentSessionId>,
    ) -> Result<TabAttachment> {
        self.inner
            .do_attach_terminal_tab_to_task(new, terminal_tab_id, agent_session_id)
    }

    fn record_task_run_observation(
        &mut self,
        task_run_id: &TaskRunId,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        self.inner.do_record_task_run_observation(task_run_id, observation)
    }
}

impl EventRepository for FakeUow<'_> {
    fn insert_event(
        &self,
        task_id: Option<&TaskId>,
        task_run_id: Option<&TaskRunId>,
        kind: &str,
        payload_json: &str,
    ) -> Result<Event> {
        self.inner.insert_event(task_id, task_run_id, kind, payload_json)
    }

    fn list_events(&self, task_id: Option<&TaskId>) -> Result<Vec<Event>> {
        self.inner.list_events(task_id)
    }
}

impl Clock for FakeUow<'_> {
    fn now_iso(&self) -> Result<String> {
        self.inner.now_iso()
    }
}

impl WorkbenchStore for FakeUow<'_> {
    fn get_bench_for_task(&self, task_id: &TaskId) -> Result<Option<(RunspaceId, String)>> {
        self.inner.get_bench_for_task(task_id)
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(RunspaceId, TaskId)>> {
        self.inner.list_bench_runspace_map()
    }

    fn create_bench(
        &mut self,
        task_id: &TaskId,
        runspace_id: &RunspaceId,
        cwd: &str,
    ) -> Result<()> {
        self.inner.do_create_bench(task_id, runspace_id, cwd)
    }

    fn update_bench_cwd(&self, task_id: &TaskId, cwd: &str) -> Result<()> {
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
                state: GithubIssueState::Open,
            })
        })
    }

    fn fetch_issues<'a>(
        &'a self,
        repo: &'a str,
        numbers: &'a [i64],
    ) -> BoxFuture<'a, Result<Vec<FetchedIssue>>> {
        Box::pin(async move {
            Ok(numbers
                .iter()
                .map(|number| FetchedIssue {
                    number: *number,
                    title: format!("{repo} issue"),
                    state: GithubIssueState::Open,
                    parent: None,
                })
                .collect())
        })
    }

    fn fetch_default_branch<'a>(&'a self, _repo: &'a str) -> BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async { Ok(Some("main".to_string())) })
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

/// A gateway whose issue title can be swapped between calls, so a re-track can be told apart from
/// a re-sync of the stored title (`FakeGithub` always answers with the same title).
pub(crate) struct RetitlingGithub {
    title: RefCell<String>,
}

impl RetitlingGithub {
    pub(crate) fn new(title: &str) -> Self {
        Self { title: RefCell::new(title.to_string()) }
    }

    pub(crate) fn set_title(&self, title: &str) {
        *self.title.borrow_mut() = title.to_string();
    }
}

impl GithubGateway for RetitlingGithub {
    fn fetch_issue<'a>(&'a self, repo: &'a str, number: i64) -> BoxFuture<'a, Result<GithubIssue>> {
        let title = self.title.borrow().clone();
        Box::pin(async move {
            Ok(GithubIssue {
                number,
                title,
                body: Some("body".to_string()),
                url: format!("https://github.com/{repo}/issues/{number}"),
                state: GithubIssueState::Open,
            })
        })
    }

    fn fetch_issues<'a>(
        &'a self,
        _repo: &'a str,
        numbers: &'a [i64],
    ) -> BoxFuture<'a, Result<Vec<FetchedIssue>>> {
        let title = self.title.borrow().clone();
        Box::pin(async move {
            Ok(numbers
                .iter()
                .map(|number| FetchedIssue {
                    number: *number,
                    title: title.clone(),
                    state: GithubIssueState::Open,
                    parent: None,
                })
                .collect())
        })
    }

    fn fetch_default_branch<'a>(&'a self, _repo: &'a str) -> BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async { Ok(Some("main".to_string())) })
    }

    fn fetch_pull_request<'a>(
        &'a self,
        _repo: &'a str,
        _number: i64,
    ) -> BoxFuture<'a, Result<GithubPullRequest>> {
        Box::pin(async { Err(anyhow::anyhow!("not used")) })
    }

    fn fetch_recent_pull_requests<'a>(
        &'a self,
        _repo: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RepoPullRequest>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// A `GithubGateway` whose repo-wide PR listing is scripted per repo, for the bulk-sync usecase.
/// `None` for a repo yields an error (to exercise per-repo failure isolation). Individual PR
/// fetches are scripted with [`with_pull_request`] and recorded so tests can assert which
/// unresolved refs fell through to a by-number fetch.
pub(crate) struct RecentPrGithub {
    by_repo: HashMap<String, Option<Vec<RepoPullRequest>>>,
    pull_requests: HashMap<(String, i64), GithubPullRequest>,
    fetched_pull_requests: RefCell<Vec<(String, i64)>>,
}

impl RecentPrGithub {
    pub(crate) fn new(by_repo: HashMap<String, Option<Vec<RepoPullRequest>>>) -> Self {
        Self {
            by_repo,
            pull_requests: HashMap::new(),
            fetched_pull_requests: RefCell::new(Vec::new()),
        }
    }

    pub(crate) fn with_pull_request(mut self, pull_request: GithubPullRequest) -> Self {
        self.pull_requests.insert(
            (pull_request.repo.clone(), pull_request.number),
            pull_request,
        );
        self
    }

    pub(crate) fn fetched_pull_requests(&self) -> Vec<(String, i64)> {
        self.fetched_pull_requests.borrow().clone()
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

    fn fetch_issues<'a>(
        &'a self,
        _repo: &'a str,
        _numbers: &'a [i64],
    ) -> BoxFuture<'a, Result<Vec<FetchedIssue>>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn fetch_default_branch<'a>(&'a self, _repo: &'a str) -> BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async { Err(anyhow!("unused")) })
    }

    fn fetch_pull_request<'a>(
        &'a self,
        repo: &'a str,
        number: i64,
    ) -> BoxFuture<'a, Result<GithubPullRequest>> {
        self.fetched_pull_requests
            .borrow_mut()
            .push((repo.to_string(), number));
        let outcome = self.pull_requests.get(&(repo.to_string(), number)).cloned();
        Box::pin(async move {
            outcome.ok_or_else(|| anyhow!("no scripted pull request for {repo}#{number}"))
        })
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

/// A `GithubGateway` whose issue batch is scripted per repo, for the issue bulk-sync usecase.
/// `None` for a repo yields an error (to exercise per-repo failure isolation). Requested numbers
/// are recorded so tests can assert which refs were asked for.
pub(crate) struct RepoIssueGithub {
    by_repo: HashMap<String, Option<Vec<FetchedIssue>>>,
    requested: RefCell<Vec<(String, Vec<i64>)>>,
}

impl RepoIssueGithub {
    pub(crate) fn new(by_repo: HashMap<String, Option<Vec<FetchedIssue>>>) -> Self {
        Self {
            by_repo,
            requested: RefCell::new(Vec::new()),
        }
    }

    pub(crate) fn requested(&self) -> Vec<(String, Vec<i64>)> {
        self.requested.borrow().clone()
    }
}

impl GithubGateway for RepoIssueGithub {
    fn fetch_issue<'a>(
        &'a self,
        _repo: &'a str,
        _number: i64,
    ) -> BoxFuture<'a, Result<GithubIssue>> {
        Box::pin(async { Err(anyhow!("unused")) })
    }

    fn fetch_issues<'a>(
        &'a self,
        repo: &'a str,
        numbers: &'a [i64],
    ) -> BoxFuture<'a, Result<Vec<FetchedIssue>>> {
        self.requested
            .borrow_mut()
            .push((repo.to_string(), numbers.to_vec()));
        let outcome = self.by_repo.get(repo).cloned();
        Box::pin(async move {
            match outcome {
                Some(Some(issues)) => Ok(issues
                    .into_iter()
                    .filter(|i| numbers.contains(&i.number))
                    .collect()),
                Some(None) => Err(anyhow!("fetch failed for {repo}")),
                None => Ok(Vec::new()),
            }
        })
    }

    fn fetch_default_branch<'a>(&'a self, _repo: &'a str) -> BoxFuture<'a, Result<Option<String>>> {
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
        _repo: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RepoPullRequest>>> {
        Box::pin(async { Ok(Vec::new()) })
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
    removed_dirs: Arc<Mutex<Vec<String>>>,
}

impl FakeTaskRunOutputs {
    /// Monica に move した後も削除記録を観測できるよう、共有ハンドルを渡す。
    pub(crate) fn removed_dirs_handle(&self) -> Arc<Mutex<Vec<String>>> {
        Arc::clone(&self.removed_dirs)
    }
}

impl crate::ports::ShellScaffolding for FakeTaskRunOutputs {
    fn prepare_base_shell_env(&self, _cwd: &std::path::Path) -> Result<Vec<(String, String)>> {
        Ok(Vec::new())
    }
}

impl TaskRunOutputs for FakeTaskRunOutputs {
    fn task_run_dir(&self, task_run_id: &TaskRunId) -> Result<PathBuf> {
        Ok(PathBuf::from("/tmp").join(task_run_id.as_str()))
    }

    fn setup_log_path(&self, task_run_id: &TaskRunId) -> Result<PathBuf> {
        Ok(self.task_run_dir(task_run_id)?.join("setup.log"))
    }

    fn prepare_task_shell_env(
        &self,
        task_id: &TaskId,
        project: &Project,
        _task_run_id: Option<&TaskRunId>,
    ) -> Result<Vec<(String, String)>> {
        Ok(vec![
            ("MONICA_TASK_ID".to_string(), task_id.to_string()),
            ("MONICA_PROJECT_ID".to_string(), project.id.clone()),
        ])
    }
}

impl crate::ports::ExplanationOutputs for FakeTaskRunOutputs {
    fn write_scaffold(&self, explanation_id: &str, _title: &str) -> Result<PathBuf> {
        Ok(PathBuf::from("/tmp/explanations")
            .join(explanation_id)
            .join("index.html"))
    }

    fn remove_dir(&self, explanation_id: &str) -> Result<()> {
        self.removed_dirs
            .lock()
            .unwrap()
            .push(explanation_id.to_string());
        Ok(())
    }
}

pub(crate) struct FakeAuth;

impl AuthGateway for FakeAuth {
    fn status(&self) -> GithubAuthStatus {
        GithubAuthStatus {
            authenticated: true,
            message: None,
        }
    }
}

fn task_from_new(id: String, new: NewTask) -> Task {
    Task {
        id: TaskId::from_store(id),
        kind: new.kind,
        status: new.status,
        phase: new.phase,
        title: new.title.unwrap_or_default(),
        body: new.body.unwrap_or_default(),
        project_id: new.project_id,
        labels: new.labels,
        details: new.details,
        source: new.source,
        primary_task_run_id: None,
        parent_task_id: None,
        closed_at: None,
        created_at: "2026-06-02T00:00:00.000Z".to_string(),
        updated_at: "2026-06-02T00:00:00.000Z".to_string(),
    }
}


pub(crate) fn hook_ctx<'a>(
    task_id: &'a TaskId,
    task_run_id: Option<&'a TaskRunId>,
) -> HookContext<'a> {
    HookContext {
        task_id: Some(task_id),
        task_run_id,
        ..HookContext::default()
    }
}

pub(crate) fn hook_ctx_in_tab<'a>(
    task_id: &'a TaskId,
    task_run_id: Option<&'a TaskRunId>,
    terminal_tab_id: &'a str,
) -> HookContext<'a> {
    HookContext {
        task_id: Some(task_id),
        task_run_id,
        terminal_tab_id: Some(terminal_tab_id),
        ..HookContext::default()
    }
}

/// A terminal session in a tab launched without `MONICA_TASK_ID` — the shape `monica task attach`
/// runs inside. `agent_session_id` is what the tab's hooks have already reported.
pub(crate) fn raw_tab_session(
    repos: &mut FakeRepos,
    tab_id: &str,
    agent_session_id: Option<&str>,
) -> String {
    raw_tab_session_at(repos, tab_id, agent_session_id, "/repo")
}

pub(crate) fn raw_tab_session_at(
    repos: &mut FakeRepos,
    tab_id: &str,
    agent_session_id: Option<&str>,
    cwd: &str,
) -> String {
    let session = repos
        .create_terminal_session(NewTerminalSession {
            runspace_id: None,
            tab_id: Some(tab_id.to_string()),
            kind: TerminalSessionKind::Shell,
            cwd: cwd.to_string(),
            shell: "/bin/zsh".to_string(),
            rows: 24,
            cols: 80,
        })
        .unwrap();
    if let Some(agent_session_id) = agent_session_id {
        repos
            .set_terminal_session_agent_status(
                &session.id,
                Some(AgentSessionStatus::Running),
                None,
                Some(&AgentSessionId::from_agent(agent_session_id)),
            )
            .unwrap();
    }
    session.id
}

/// The hook identity a tab with no `MONICA_TASK_ID` carries: tab + session only.
pub(crate) fn hook_ctx_raw_tab<'a>(
    terminal_tab_id: &'a str,
    terminal_session_id: &'a str,
) -> HookContext<'a> {
    HookContext {
        terminal_tab_id: Some(terminal_tab_id),
        terminal_session_id: Some(terminal_session_id),
        ..HookContext::default()
    }
}

/// A task whose primary run is Prepared but not yet claimed by any session.
pub(crate) fn task_with_prepared_primary(repos: &mut FakeRepos) -> (TaskId, TaskRunId) {
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
pub(crate) fn task_with_running_primary(repos: &mut FakeRepos) -> (TaskId, TaskRunId) {
    let (task_id, run_id) = task_with_prepared_primary(repos);
    record_claude_hook(
        repos,
        hook_ctx(&task_id, Some(&run_id)),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    record_claude_hook(
        repos,
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
    insert_runnable_project_at(repos, "/repo");
}

pub(crate) fn insert_runnable_project_at(repos: &FakeRepos, path: &str) {
    let mut project = Project::from_repo("owner/repo");
    project.path = Some(path.to_string());
    repos.insert_project(project);
}

/// A real directory on disk, for the paths a use case stats before handing them to a terminal.
pub(crate) fn temp_dir_named(prefix: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub(crate) fn insert_issue_backed_task(repos: &mut FakeRepos, issue_number: i64) -> TaskId {
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
        parent_task_id: None,
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
        agent_session_id: None,
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
            agent_status: None,
            agent_wait_reason: None,
            agent_session_id: None,
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

    fn set_terminal_session_agent_status(
        &self,
        id: &str,
        agent_status: Option<AgentSessionStatus>,
        agent_wait_reason: Option<TaskRunWaitReason>,
        agent_session_id: Option<&AgentSessionId>,
    ) -> Result<bool> {
        if let Some(s) = self.state.borrow_mut().terminal_sessions.iter_mut().find(|s| s.id == id) {
            let changed = s.agent_status != agent_status || s.agent_wait_reason != agent_wait_reason;
            s.agent_status = agent_status;
            s.agent_wait_reason = agent_wait_reason;
            s.agent_session_id = agent_session_id.cloned();
            return Ok(changed);
        }
        Ok(false)
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

    fn list_terminal_sessions(
        &self,
        runspace_id: Option<&RunspaceId>,
    ) -> Result<Vec<TerminalSession>> {
        Ok(self
            .state
            .borrow()
            .terminal_sessions
            .iter()
            .filter(|s| runspace_id.is_none_or(|r| s.runspace_id.as_ref() == Some(r)))
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

impl crate::ports::ExplanationStore for FakeRepos {
    fn list_explanations(&self) -> Result<Vec<monica_domain::Explanation>> {
        let mut list: Vec<_> = self.state.borrow().explanations.clone();
        list.reverse();
        Ok(list)
    }

    fn get_explanation(&self, id: &str) -> Result<Option<monica_domain::Explanation>> {
        Ok(self
            .state
            .borrow()
            .explanations
            .iter()
            .find(|e| e.id == id)
            .cloned())
    }

    fn insert_explanation(
        &mut self,
        new: monica_domain::NewExplanation,
    ) -> Result<monica_domain::Explanation> {
        let mut state = self.state.borrow_mut();
        // len()+1 だと delete 後の insert で id が再利用され、counter table 方式の SqliteStore と
        // 挙動が乖離する。単調増加カウンタで実装に揃える。
        state.next_explanation += 1;
        let n = state.next_explanation;
        let explanation = monica_domain::Explanation {
            id: monica_domain::ExplanationId::from_store(format!("expl-{n}")),
            title: new.title,
            summary: new.summary,
            mode: new.mode,
            agent_session_id: new.agent_session_id,
            terminal_session_id: new.terminal_session_id,
            created_at: "2026-07-11T00:00:00.000Z".to_string(),
            repo_name: None,
        };
        state.explanations.push(explanation.clone());
        Ok(explanation)
    }

    fn delete_explanation(&mut self, id: &str) -> Result<()> {
        self.state
            .borrow_mut()
            .explanations
            .retain(|e| e.id != id);
        Ok(())
    }
}

// usecase テストで note を使うものはまだない — Backend::Repos の trait bound を満たすためのスタブ。
// 最初に使うテストと一緒に、必要なメソッドだけ本物の挙動を実装すること。
impl crate::ports::NoteStore for FakeRepos {
    fn create_note(&mut self, _day_boundary_hour: u8) -> Result<monica_domain::Note> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn create_essay_note(&mut self, _day_boundary_hour: u8) -> Result<monica_domain::Note> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn create_project_note(
        &mut self,
        _project_id: &str,
        _day_boundary_hour: u8,
    ) -> Result<monica_domain::Note> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn get_or_create_primary_note(
        &mut self,
        _project_id: &str,
        _day_boundary_hour: u8,
    ) -> Result<monica_domain::Note> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn list_essay_notes(&self) -> Result<Vec<monica_domain::NoteSummary>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn set_essay_status(
        &mut self,
        _id: &str,
        _status: monica_domain::EssayStatus,
    ) -> Result<Option<monica_domain::Note>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn get_or_create_daily_note(&mut self, _date: &str) -> Result<monica_domain::Note> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn get_note(&self, _id: &str) -> Result<Option<monica_domain::Note>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn get_note_block(
        &self,
        _note_id: &str,
        _block_id: &str,
    ) -> Result<Option<monica_domain::RawJson>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn list_notes(
        &self,
        _from: Option<&str>,
        _to: Option<&str>,
    ) -> Result<Vec<monica_domain::NoteSummary>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn list_all_note_contents(&self) -> Result<Vec<monica_domain::RawJson>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn list_project_notes(
        &self,
        _project_id: &str,
        _limit: usize,
        _offset: usize,
    ) -> Result<Vec<monica_domain::NoteSummary>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn search_notes(&self, _q: &str, _limit: usize) -> Result<Vec<monica_domain::NoteSummary>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn update_note(
        &mut self,
        _id: &str,
        _update: monica_domain::UpdateNote,
    ) -> Result<crate::ports::NoteUpdate> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn delete_note(&mut self, _id: &str) -> Result<bool> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn restore_note(&mut self, _id: &str) -> Result<Option<monica_domain::Note>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn daily_note_counts(
        &self,
        _from: Option<&str>,
        _to: Option<&str>,
        _kind: Option<&str>,
    ) -> Result<Vec<monica_domain::DailyNoteCount>> {
        unimplemented!("no usecase test exercises notes yet")
    }

    fn logical_today(&self, _day_boundary_hour: u8) -> Result<String> {
        unimplemented!("no usecase test exercises notes yet")
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
pub(crate) struct FakeWorkspace;

impl Workspace for FakeWorkspace {
    fn scaffold_monica(&self, _dir: &Path) -> Result<Vec<(String, bool)>> {
        Ok(vec![(".monica/setup.sh".to_string(), true)])
    }
}

pub(crate) struct FakeDaemon {
    create_fails: bool,
}

impl FakeDaemon {
    pub(crate) fn failing_create() -> Self {
        Self { create_fails: true }
    }
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
    type Workspace = FakeWorkspace;
    type Agents = TestAgentDecoders;
}

pub(crate) fn facade(repos: FakeRepos, sink: RecordingSink) -> Monica<FakeBackend> {
    facade_with_decoder(repos, sink, TestAgentDecoders::default())
}

pub(crate) fn facade_with_outputs(
    repos: FakeRepos,
    sink: RecordingSink,
    outputs: FakeTaskRunOutputs,
) -> Monica<FakeBackend> {
    Monica::new(
        repos,
        FakeGit::default(),
        FakeGithub,
        FakeAuth,
        FakeSetupRunner::default(),
        outputs,
        FakeWorkspace,
        TestAgentDecoders::default(),
        Box::new(sink),
    )
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
        agent_session_id: Some(AgentSessionId::from_agent("sess")),
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
        agent_status: None,
        agent_wait_reason: None,
        agent_session_id: None,
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
