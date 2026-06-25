use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::interfaces::{
    AuthGateway, BenchRepository, BoxFuture, Clock, EventRepository, GitGateway, GithubGateway,
    ProjectRepository, TaskRunOutputs, SetupEnv, SetupOutcome, SetupRunner, TaskRepository,
    TaskRunRepository, TaskSummaryFilter,
};
use super::record_hook::{
    resolve_by_lazy_create, resolve_by_prepared_primary, resolve_by_session, RunResolveCtx,
};
use crate::{
    begin_github_device_flow, close_issue, create_raw_task, execute_run, github_auth_status,
    logout_github,
    make_main_by_terminal_tab, open_bench, prepare_claude_for_run, primary_terminal_tab,
    record_claude_hook, register_project_with_default_branch,
    start_run, subagents_in_flight_after,
    sync_next_pull_request,
    track_github_issue, HookContext, MakeMainOutcome, RefType,
    wait_for_github_device_flow, Agent, DisplayStatus, Event, ExternalRef, GithubAuthStatus,
    GithubDeviceFlow, GithubIssue, GithubPullRequest, GithubPullRequestRef,
    GithubPullRequestStatus, NewTask, NewTaskRun, Project, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncStatus, Task,
    TaskBench, TaskKind, TaskRun, TaskRunObservation, TaskRunStatus, TaskRunWaitReason, TaskStatus,
    TaskSummaryRow, TrackGithubIssueInput,
};

#[derive(Default)]
struct FakeRepos {
    state: RefCell<FakeState>,
}

#[derive(Default)]
struct FakeState {
    projects: HashMap<String, Project>,
    tasks: HashMap<String, Task>,
    refs: HashMap<String, Vec<ExternalRef>>,
    runs: HashMap<String, TaskRun>,
    events: Vec<Event>,
    benches: BTreeMap<String, (String, String)>,
    next_task: i64,
    next_run: i64,
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
            details: json!({}),
            source: None,
        })
        .unwrap()
        .id
    }
}

impl TaskRepository for FakeRepos {
    fn insert_task(&mut self, new: NewTask) -> Result<Task> {
        let mut state = self.state.borrow_mut();
        state.next_task += 1;
        let id = format!("MON-{}", state.next_task);
        let task = task_from_new(id, new);
        state.tasks.insert(task.id.clone(), task.clone());
        Ok(task)
    }

    fn insert_task_with_ref(&mut self, new: NewTask, mut external: ExternalRef) -> Result<Task> {
        let task = self.insert_task(new)?;
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

    fn get_task(&self, id: &str) -> Result<Option<Task>> {
        Ok(self.state.borrow().tasks.get(id).cloned())
    }

    fn mark_task_closed(&mut self, id: &str) -> Result<Task> {
        let mut state = self.state.borrow_mut();
        let task = state
            .tasks
            .get_mut(id)
            .ok_or_else(|| anyhow!("task not found: {id}"))?;
        task.status = TaskStatus::Closed;
        task.closed_at = Some("2026-06-02T00:00:00.000Z".to_string());
        Ok(task.clone())
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        Ok(self.state.borrow().tasks.values().cloned().collect())
    }

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
        let mut state = self.state.borrow_mut();
        let task = state
            .tasks
            .get_mut(id)
            .ok_or_else(|| anyhow!("task not found: {id}"))?;
        task.status = status;
        task.phase = note.map(ToString::to_string);
        Ok(())
    }

    fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalRef>> {
        Ok(self
            .state
            .borrow()
            .refs
            .get(task_id)
            .cloned()
            .unwrap_or_default())
    }

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

impl TaskRunRepository for FakeRepos {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
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
            metadata: json!({}),
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

    fn finish_task_run(
        &mut self,
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

    fn record_task_run_observation(
        &mut self,
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
        // Mirror the store's subagent guard: a Stop with subagents still in flight is held
        // (pending_stop); the SubagentStop that leaves nothing in flight fires the deferred
        // transition. `subagents_in_flight_after` excludes a SubagentStop's own listed agent.
        let hold_stop = observation.event_name == Some("Stop")
            && subagents_in_flight_after(observation.event_name, observation.metadata);
        let release_stop = observation.event_name == Some("SubagentStop")
            && !subagents_in_flight_after(observation.event_name, observation.metadata);
        let was_pending = run.pending_stop;
        if release_stop && was_pending {
            run.status = TaskRunStatus::WaitingForUser;
            run.wait_reason = Some(TaskRunWaitReason::AwaitingPrompt);
        }
        run.pending_stop = if hold_stop && run.status == TaskRunStatus::Running {
            true
        } else if release_stop || observation.status.is_some() {
            false
        } else {
            was_pending
        };
        run.last_event_name = observation.event_name.map(ToString::to_string);
        run.last_event_at = Some(observation.at.to_string());
        Ok(())
    }
}

impl EventRepository for FakeRepos {
    fn insert_event(
        &self,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        kind: &str,
        payload: &Value,
    ) -> Result<Event> {
        let mut state = self.state.borrow_mut();
        let event = Event {
            id: state.events.len() as i64 + 1,
            task_id: task_id.map(ToString::to_string),
            task_run_id: task_run_id.map(ToString::to_string),
            kind: kind.to_string(),
            payload: payload.clone(),
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

impl BenchRepository for FakeRepos {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>> {
        Ok(self.state.borrow().benches.get(task_id).cloned())
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>> {
        Ok(self.state.borrow().benches.values().cloned().collect())
    }

    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()> {
        self.state
            .borrow_mut()
            .benches
            .insert(task_id.to_string(), (runspace_id.to_string(), cwd.to_string()));
        Ok(())
    }

    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()> {
        if let Some(entry) = self.state.borrow_mut().benches.get_mut(task_id) {
            entry.1 = cwd.to_string();
        }
        Ok(())
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
        _event_name: Option<&str>,
        _parsed: &Option<Value>,
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
    assert!(create_raw_task(&mut repos, "   ", "owner/repo").is_err());
}

#[test]
fn create_raw_task_rejects_unknown_project() {
    let mut repos = FakeRepos::default();
    assert!(create_raw_task(&mut repos, "explore", "owner/repo").is_err());
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#,
    )
    .unwrap();
    record_claude_hook(
        repos,
        outputs,
        hook_ctx(&task_id, Some(&run_id)),
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}"#,
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
fn record_claude_hook_claims_prepared_primary_run_without_run_id() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_prepared_primary(&mut repos);
    let outputs = FakeTaskRunOutputs::default();

    // The session opens but nothing runs yet: the claim lands as "your turn".
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-1"}"#,
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert!(!report.entered_waiting_for_user);

    // Back to Running, then a terminal transition: a non-waiting landing is never an edge.
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"sess-1"}"#,
    )
    .unwrap();
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        r#"{"hook_event_name":"SessionEnd","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-stray"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-2","cwd":"/work/tree"}"#,
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
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"sess-1"}"#,
    )
    .unwrap();

    // A fork's SessionStart fires from the new tab while still carrying the source session's id.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, None, "tab-fork"),
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1","source":"resume"}"#,
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
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"sess-2"}"#,
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
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"sess-1"}"#,
    )
    .unwrap();

    // Resuming in another tab proves nothing yet (it could be a fork)...
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, None, "tab-new"),
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1","source":"resume"}"#,
    )
    .unwrap();
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.terminal_tab_id.as_deref(), Some("tab-main"));

    // ...the first prompt under the same session id is what moves the binding.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx_in_tab(&task_id, None, "tab-new"),
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-2"}"#,
    )
    .unwrap();

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","session_id":"sess-2"}"#,
    )
    .unwrap();
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));

    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        r#"{"hook_event_name":"PostToolUse","tool_name":"AskUserQuestion","session_id":"sess-2"}"#,
    )
    .unwrap();
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        r#"{"hook_event_name":"SessionEnd","session_id":"sess-2"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1","source":"compact"}"#,
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
        r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","session_id":"sess-1"}"#,
    )
    .unwrap();

    // The Stop that trails the question must not blur "needs you" into "your turn".
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        r#"{"hook_event_name":"Stop","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-1","background_tasks":[{"id":"a","status":"running"}]}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-1","background_tasks":[]}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-1","background_tasks":[{"id":"a","status":"running"}]}"#,
    )
    .unwrap();
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Running);
    assert!(run.pending_stop);

    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        r#"{"hook_event_name":"SubagentStop","session_id":"sess-1","agent_id":"a","background_tasks":[{"id":"a","status":"running"}]}"#,
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
    let fire = |repos: &mut FakeRepos, raw: &str| {
        record_claude_hook(repos, &outputs, hook_ctx(&task_id, None), raw).unwrap()
    };

    // Two subagents running: the Stop is held.
    fire(&mut repos, r#"{"hook_event_name":"Stop","session_id":"sess-1","background_tasks":[{"id":"a","status":"running"},{"id":"b","status":"running"}]}"#);
    assert_eq!(status(&repos), TaskRunStatus::Running);

    // A start-less SubagentStop whose agent is not in the snapshot must not release the hold.
    fire(&mut repos, r#"{"hook_event_name":"SubagentStop","session_id":"sess-1","agent_id":"ghost","background_tasks":[{"id":"a","status":"running"},{"id":"b","status":"running"}]}"#);
    assert_eq!(status(&repos), TaskRunStatus::Running);

    // Claude re-injects a finished subagent's result as a UserPromptSubmit; the parent is working
    // again, so the run follows to Running.
    fire(&mut repos, r#"{"hook_event_name":"UserPromptSubmit","session_id":"sess-1","prompt":"<task-notification>\n<task-id>x</task-id>"}"#);
    assert_eq!(status(&repos), TaskRunStatus::Running);

    // The parent comes to rest with an empty background_tasks: now it settles to "your turn".
    fire(&mut repos, r#"{"hook_event_name":"Stop","session_id":"sess-1","background_tasks":[]}"#);
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
        r#"{"hook_event_name":"SessionEnd","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"SessionEnd","session_id":"sess-1"}"#,
    )
    .unwrap();

    // Relaunching claude in the wrapper tab starts a brand-new session under the same
    // MONICA_TASK_RUN_ID; its SessionStart must bring the run back to "your turn".
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        r#"{"hook_event_name":"SessionStart","session_id":"sess-2","source":"startup"}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-1"}"#,
    )
    .unwrap();

    // A waiting run is still a live session; its death is a fact that must land.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, None),
        r#"{"hook_event_name":"SessionEnd","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"SessionEnd","session_id":"sess-1"}"#,
    )
    .unwrap();
    record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        r#"{"hook_event_name":"SessionStart","session_id":"sess-2","source":"startup"}"#,
    )
    .unwrap();

    // Stragglers arrive through the pinned MONICA_TASK_RUN_ID after the relaunch, but neither
    // may touch the run sess-2 now owns: the dead session's SessionEnd is a stale terminal
    // verdict (session-scoped), and StopFailure is inert by design — never the run's verdict.
    for payload in [
        r#"{"hook_event_name":"SessionEnd","session_id":"sess-1"}"#,
        r#"{"hook_event_name":"StopFailure","session_id":"sess-1"}"#,
    ] {
        let report =
            record_claude_hook(&mut repos, &outputs, hook_ctx(&task_id, Some(&run_id)), payload)
                .unwrap();
        assert_eq!(report.task_run_status, None, "{payload}");
        let run = repos.get_task_run(&run_id).unwrap().unwrap();
        assert_eq!(run.status, TaskRunStatus::WaitingForUser, "{payload}");
        assert_eq!(
            run.wait_reason,
            Some(TaskRunWaitReason::AwaitingPrompt),
            "{payload}"
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-9","source":"resume"}"#,
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
        r#"{"hook_event_name":"SessionEnd","session_id":"sess-1"}"#,
    )
    .unwrap();

    // `claude --resume` of a brand-new conversation lands through the pinned run id with a
    // session the run has never seen: that is new life, same as a startup start.
    let report = record_claude_hook(
        &mut repos,
        &outputs,
        hook_ctx(&task_id, Some(&run_id)),
        r#"{"hook_event_name":"SessionStart","session_id":"sess-3","source":"resume"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"Stop","session_id":"sess-unknown"}"#,
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
        r#"{"hook_event_name":"SessionStart"}"#,
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
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"sess-2"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-2"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-2"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-2"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-3"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-2"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#,
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
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#,
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
        super::open_bench::default_bench_cwd(Some(&project), Some("/home/user")),
        "/test/repo"
    );
}

#[test]
fn default_bench_cwd_falls_back_to_home_dir_when_no_project_path() {
    let project = Project::from_repo("owner/repo");
    assert_eq!(
        super::open_bench::default_bench_cwd(Some(&project), Some("/home/user")),
        "/home/user"
    );
}

#[test]
fn default_bench_cwd_falls_back_to_tmp_when_no_project_and_no_home() {
    assert_eq!(
        super::open_bench::default_bench_cwd(None, None),
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
    let env = super::task_shell_env(&repos, &outputs, &task_id).unwrap();
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
    let env = super::task_shell_env(&repos, &outputs, &task_id).unwrap();
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
    let env = super::task_shell_env(&repos, &outputs, &task_id).unwrap();
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
            ExternalRef {
                id: 0,
                task_id: String::new(),
                ref_type: RefType::GithubIssue,
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
    assert!(err.to_string().contains("already has an active run"), "{err}");
}

#[test]
fn start_run_rejects_closed_task() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    repos.update_task_status(&task_id, TaskStatus::Closed).unwrap();

    let err = start_run(&mut repos, &task_id).unwrap_err();
    assert!(err.to_string().contains("is closed"), "{err}");
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
        details: json!({}),
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
        metadata: json!({}),
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
        event_name: Some("SessionStart"),
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

    let hook = r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#.to_string();
    record_claude_hook(
        &mut repos,
        &FakeTaskRunOutputs::default(),
        HookContext { task_id: Some(&task_id), task_run_id: None, terminal_tab_id: None },
        &hook,
    ).unwrap();

    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        event_name: Some("Prompt"),
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
        event_name: Some("SessionStart"),
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
        event_name: Some("Stop"),
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
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
        event_name: Some("SessionStart"),
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    let result = resolve_by_prepared_primary(&ctx, &mut repos).unwrap();
    let resolved = result.unwrap();
    assert!(!resolved.created);
    assert_eq!(resolved.run.unwrap().id, "run-1");
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
        event_name: Some("SessionStart"),
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
        event_name: Some("Stop"),
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
        event_name: Some("SessionStart"),
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
        event_name: Some("SessionStart"),
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
        event_name: Some("SessionStart"),
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
        event_name: Some("SessionStart"),
        agent: Agent::Claude,
        primary_run: Some(&existing_primary),
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    let resolved = result.unwrap();
    assert!(resolved.created);
    let updated_task = repos.get_task(&task_id).unwrap().unwrap();
    assert!(updated_task.primary_task_run_id.is_none());
}
