use anyhow::Result;
use monica_core::NewTask;
use monica_core::NewTaskRun;
use monica_core::{
    BenchRepository, Clock, DisplayStatus, Event, EventRepository, ExternalRef, GithubPullRequest,
    Project, ProjectRepository, PullRequestBranchSyncCandidate, PullRequestStatusSyncCandidate,
    Task, TaskRepository, TaskRun, TaskRunObservation, TaskRunRepository,
    TaskRunStatus, TaskStatus, TaskSummaryRow,
};
use serde_json::Value;

use super::SqliteStore;

impl TaskRepository for SqliteStore {
    fn insert_task(&mut self, new: NewTask) -> Result<Task> {
        SqliteStore::insert_task(self, new)
    }

    fn insert_task_with_ref(&mut self, new: NewTask, external: ExternalRef) -> Result<Task> {
        SqliteStore::insert_task_with_ref(self, new, external)
    }

    fn get_task(&self, id: &str) -> Result<Option<Task>> {
        SqliteStore::get_task(self, id)
    }

    fn mark_task_deleted(&mut self, id: &str) -> Result<Task> {
        SqliteStore::mark_task_deleted(self, id)
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        SqliteStore::list_tasks(self)
    }

    fn list_task_summaries(
        &self,
        status: Option<DisplayStatus>,
        project: Option<&str>,
    ) -> Result<Vec<TaskSummaryRow>> {
        SqliteStore::list_task_summaries(self, status, project)
    }

    fn set_primary_task_run(&self, task_id: &str, task_run_id: &str) -> Result<()> {
        SqliteStore::set_primary_task_run(self, task_id, task_run_id)
    }

    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<()> {
        SqliteStore::update_task_status(self, id, status)
    }

    fn mark_task(&mut self, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()> {
        SqliteStore::mark_task(self, id, status, note)
    }

    fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalRef>> {
        SqliteStore::list_external_refs(self, task_id)
    }

    fn next_pull_request_branch_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestBranchSyncCandidate>> {
        SqliteStore::next_pull_request_branch_sync_candidate(self)
    }

    fn next_pull_request_status_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestStatusSyncCandidate>> {
        SqliteStore::next_pull_request_status_sync_candidate(self)
    }

    fn record_pull_request_branch_sync_success(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        pull_requests: &[GithubPullRequest],
    ) -> Result<()> {
        SqliteStore::record_pull_request_branch_sync_success(self, candidate, pull_requests)
    }

    fn record_pull_request_branch_sync_failure(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        error: &str,
    ) -> Result<()> {
        SqliteStore::record_pull_request_branch_sync_failure(self, candidate, error)
    }

    fn record_pull_request_status_sync_success(
        &mut self,
        candidate: &PullRequestStatusSyncCandidate,
        pull_request: &GithubPullRequest,
    ) -> Result<()> {
        SqliteStore::record_pull_request_status_sync_success(self, candidate, pull_request)
    }

    fn record_pull_request_status_sync_failure(
        &mut self,
        candidate: &PullRequestStatusSyncCandidate,
        error: &str,
    ) -> Result<()> {
        SqliteStore::record_pull_request_status_sync_failure(self, candidate, error)
    }
}

impl ProjectRepository for SqliteStore {
    fn upsert_project(&self, project: &Project) -> Result<Project> {
        SqliteStore::upsert_project(self, project)
    }

    fn get_project(&self, id: &str) -> Result<Option<Project>> {
        SqliteStore::get_project(self, id)
    }

    fn list_projects(&self) -> Result<Vec<Project>> {
        SqliteStore::list_projects(self)
    }

    fn set_project_field(&self, id: &str, key: &str, value: &str) -> Result<()> {
        SqliteStore::set_project_field(self, id, key, value)
    }
}

impl TaskRunRepository for SqliteStore {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
        SqliteStore::start_task_run(self, new)
    }

    fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        SqliteStore::finish_task_run(self, task_run_id, task_id, status)
    }

    fn set_task_run_settings_path(&self, task_run_id: &str, settings_path: &str) -> Result<()> {
        SqliteStore::set_task_run_settings_path(self, task_run_id, settings_path)
    }

    fn set_task_run_worktree_path(&self, task_run_id: &str, worktree_path: &str) -> Result<()> {
        SqliteStore::set_task_run_worktree_path(self, task_run_id, worktree_path)
    }

    fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
        SqliteStore::get_task_run(self, id)
    }

    fn find_task_run_by_session(
        &self,
        task_id: &str,
        provider_session_id: &str,
    ) -> Result<Option<TaskRun>> {
        SqliteStore::find_task_run_by_session(self, task_id, provider_session_id)
    }

    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>> {
        SqliteStore::find_task_run_by_terminal_tab(self, terminal_tab_id)
    }

    fn list_task_runs_for_task(&self, task_id: &str) -> Result<Vec<TaskRun>> {
        SqliteStore::list_task_runs_for_task(self, task_id)
    }

    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        SqliteStore::record_task_run_observation(self, task_run_id, observation)
    }
}

impl EventRepository for SqliteStore {
    fn insert_event(
        &self,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        kind: &str,
        payload: &Value,
    ) -> Result<Event> {
        SqliteStore::insert_event(self, task_id, task_run_id, kind, payload)
    }

    fn list_events(&self, task_id: Option<&str>) -> Result<Vec<Event>> {
        SqliteStore::list_events(self, task_id)
    }
}

impl BenchRepository for SqliteStore {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>> {
        SqliteStore::get_bench_for_task(self, task_id)
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>> {
        SqliteStore::list_bench_runspace_map(self)
    }

    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()> {
        SqliteStore::create_bench(self, task_id, runspace_id, cwd)
    }

    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()> {
        SqliteStore::update_bench_cwd(self, task_id, cwd)
    }
}

impl Clock for SqliteStore {
    fn now_iso(&self) -> Result<String> {
        SqliteStore::now_iso(self)
    }
}
