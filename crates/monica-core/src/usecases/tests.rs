use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::interfaces::{
    AuthGateway, BoxFuture, Clock, EventRepository, GitGateway, GithubGateway, ProjectRepository,
    RunArtifacts, TaskRepository, TaskRunRepository,
};
use crate::{
    begin_github_device_flow, delete_issue, github_auth_status, logout_github, record_claude_hook,
    register_project_with_default_branch, sync_next_pull_request, track_github_issue,
    wait_for_github_device_flow, Agent, DisplayStatus, Event, ExternalRef, GithubAuthStatus,
    GithubDeviceFlow, GithubIssue, GithubPullRequest, GithubPullRequestRef,
    GithubPullRequestStatus, NewTask, NewTaskRun, Project, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncCandidate, PullRequestSyncStatus, Task,
    TaskKind, TaskRun, TaskRunObservation, TaskRunStatus, TaskRunWaitReason, TaskStatus,
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
    next_task: i64,
    next_run: i64,
    pr_branch_candidate: Option<PullRequestBranchSyncCandidate>,
    pr_candidate: Option<PullRequestSyncCandidate>,
    pr_status_candidate: Option<PullRequestStatusSyncCandidate>,
    pr_branch_success_count: usize,
    pr_success_count: usize,
    issue_sync_candidate_lookups: usize,
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
        Ok(self
            .state
            .borrow()
            .tasks
            .get(id)
            .filter(|task| task.deleted_at.is_none())
            .cloned())
    }

    fn mark_task_deleted(&mut self, id: &str) -> Result<Task> {
        let mut state = self.state.borrow_mut();
        let task = state
            .tasks
            .get_mut(id)
            .ok_or_else(|| anyhow!("task not found: {id}"))?;
        task.deleted_at = Some("2026-06-02T00:00:00.000Z".to_string());
        Ok(task.clone())
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        Ok(self
            .state
            .borrow()
            .tasks
            .values()
            .filter(|task| task.deleted_at.is_none())
            .cloned()
            .collect())
    }

    fn list_task_summaries(
        &self,
        status: Option<DisplayStatus>,
        _project: Option<&str>,
    ) -> Result<Vec<TaskSummaryRow>> {
        let rows = self
            .state
            .borrow()
            .tasks
            .values()
            .map(|task| TaskSummaryRow {
                id: task.id.clone(),
                title: task.title.clone(),
                project: task.project_id.clone(),
                github_issue_number: None,
                github_pull_requests: Vec::<GithubPullRequestRef>::new(),
                task_status: task.status,
                task_run_status: None,
                task_run_wait_reason: None,
                status: DisplayStatus::from_task_and_run(task.status, None),
                branch: None,
            })
            .filter(|row| status.is_none_or(|status| status == row.status))
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

    fn next_pull_request_sync_candidate(&self) -> Result<Option<PullRequestSyncCandidate>> {
        self.state.borrow_mut().issue_sync_candidate_lookups += 1;
        Ok(self.state.borrow().pr_candidate.clone())
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

    fn record_pull_request_sync_success(
        &mut self,
        _candidate: &PullRequestSyncCandidate,
        pull_requests: &[GithubPullRequest],
    ) -> Result<()> {
        let mut state = self.state.borrow_mut();
        state.pr_success_count = pull_requests.len();
        state.pr_candidate = None;
        Ok(())
    }

    fn record_pull_request_sync_failure(
        &mut self,
        _candidate: &PullRequestSyncCandidate,
        _error: &str,
    ) -> Result<()> {
        self.state.borrow_mut().pr_candidate = None;
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
            last_event_name: None,
            last_event_at: None,
            metadata: json!({}),
            created_at: "2026-06-02T00:00:00.000Z".to_string(),
            updated_at: "2026-06-02T00:00:00.000Z".to_string(),
        };
        state.runs.insert(id, run.clone());
        if let Some(task) = state.tasks.get_mut(&new.task_id) {
            task.status = TaskStatus::InProgress;
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
            if task.status != TaskStatus::Done {
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

    fn fetch_linked_pull_requests<'a>(
        &'a self,
        repo: &'a str,
        _issue_number: i64,
    ) -> BoxFuture<'a, Result<Vec<GithubPullRequest>>> {
        Box::pin(async move {
            Ok(vec![GithubPullRequest {
                repo: repo.to_string(),
                number: 7,
                url: format!("https://github.com/{repo}/pull/7"),
                status: GithubPullRequestStatus::Open,
            }])
        })
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
struct FakeArtifacts {
    appended: RefCell<bool>,
}

impl RunArtifacts for FakeArtifacts {
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
    ) -> Result<crate::TaskShellEnv> {
        Ok(crate::TaskShellEnv {
            env: vec![
                ("MONICA_TASK_ID".to_string(), task_id.to_string()),
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
        deleted_at: None,
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
fn delete_issue_delegates_run_cleanup_to_git_gateway() {
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
    let report = delete_issue(&mut repos, &git, &task_id).unwrap();
    assert_eq!(report.removed_branches, vec!["issue-42"]);
    assert!(*git.cleaned.borrow());
}

#[test]
fn record_claude_hook_records_waiting_transition_and_artifact() {
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
    let artifacts = FakeArtifacts::default();
    let report = record_claude_hook(
        &mut repos,
        &artifacts,
        Some(&task_id),
        Some(&run.id),
        r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}"#,
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert_eq!(
        repos.get_task_run(&run.id).unwrap().unwrap().wait_reason,
        Some(TaskRunWaitReason::AskUserQuestion)
    );
    assert!(*artifacts.appended.borrow());
}

#[test]
fn record_claude_hook_claims_prepared_primary_run_without_run_id() {
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
    repos
        .finish_task_run(&run.id, &task_id, TaskRunStatus::Prepared)
        .unwrap();
    repos.set_primary_task_run(&task_id, &run.id).unwrap();
    let artifacts = FakeArtifacts::default();

    let report = record_claude_hook(
        &mut repos,
        &artifacts,
        Some(&task_id),
        None,
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#,
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Running));
    assert_eq!(
        repos.get_task_run(&run.id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );

    // The claimed run is no longer prepared; the same session keeps driving it.
    let report = record_claude_hook(
        &mut repos,
        &artifacts,
        Some(&task_id),
        None,
        r#"{"hook_event_name":"Stop","session_id":"sess-1"}"#,
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Stopped));
}

#[test]
fn record_claude_hook_does_not_steal_active_primary_run_from_another_session() {
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
    repos
        .finish_task_run(&run.id, &task_id, TaskRunStatus::Prepared)
        .unwrap();
    repos.set_primary_task_run(&task_id, &run.id).unwrap();
    let artifacts = FakeArtifacts::default();

    record_claude_hook(
        &mut repos,
        &artifacts,
        Some(&task_id),
        Some(&run.id),
        r#"{"hook_event_name":"SessionStart","session_id":"sess-1"}"#,
    )
    .unwrap();

    let report = record_claude_hook(
        &mut repos,
        &artifacts,
        Some(&task_id),
        None,
        r#"{"hook_event_name":"SessionStart","session_id":"sess-2"}"#,
    )
    .unwrap();
    assert!(!report.task_run_linked);
    assert_eq!(report.task_run_status, None);
    assert!(report.event_recorded);
    assert_eq!(
        repos.get_task_run(&run.id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );
}

#[tokio::test]
async fn sync_pull_requests_records_branch_gateway_result_without_issue_lookup() {
    let mut repos = FakeRepos::default();
    repos.state.borrow_mut().pr_branch_candidate = Some(PullRequestBranchSyncCandidate {
        task_id: "MON-1".to_string(),
        repo: "owner/repo".to_string(),
        branch: "issue-42".to_string(),
    });
    repos.state.borrow_mut().pr_candidate = Some(PullRequestSyncCandidate {
        task_id: "MON-1".to_string(),
        source_ref_id: 1,
        repo: "owner/repo".to_string(),
        issue_number: 42,
    });
    let result = sync_next_pull_request(&mut repos, &FakeGithub)
        .await
        .unwrap();
    assert_eq!(result.status, PullRequestSyncStatus::Synced);
    assert_eq!(repos.state.borrow().pr_branch_success_count, 1);
    assert_eq!(repos.state.borrow().pr_success_count, 0);
    assert_eq!(repos.state.borrow().issue_sync_candidate_lookups, 0);
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
