use monica_api::{
    Agent, ApiError, BoardColumn, PrepareTaskResult, RunTaskResult, TaskBench, TaskRunStatus,
    TaskSummaryRow,
};
use monica_application::{MakeMainOutcome, TaskSummaryFilter, TrackGithubIssueInput};
use serde::Serialize;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::event_sink;

#[derive(Serialize, specta::Type)]
pub struct TaskCreated {
    pub task_id: String,
    pub title: String,
}

#[derive(Serialize, specta::Type)]
pub struct ProjectOption {
    pub id: String,
}

#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "task-run:status-changed")]
pub struct TaskRunStatusChanged {
    pub(crate) task_id: String,
    pub(crate) task_run_id: String,
    pub(crate) status: TaskRunStatus,
}

#[tauri::command]
#[specta::specta]
pub fn list_task_summaries(
    app: AppHandle,
    project: Option<String>,
) -> Result<Vec<TaskSummaryRow>, ApiError> {
    let mut monica = event_sink::open(&app)?;
    Ok(monica
        .tasks()
        .list_task_summaries(TaskSummaryFilter::All, project.as_deref())?
        .into_iter()
        .map(TaskSummaryRow::from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn get_board_columns() -> Vec<BoardColumn> {
    monica_api::board_columns()
}

#[tauri::command]
#[specta::specta]
pub async fn track_github_issue(app: AppHandle, input: String) -> Result<TaskCreated, ApiError> {
    let (repo, number) =
        monica_application::parse_issue_input(&input).map_err(|e| ApiError::validation(e.to_string()))?;
    let mut monica = event_sink::open(&app)?;
    let report = monica
        .synchronization()
        .track_github_issue(TrackGithubIssueInput { repo, number })
        .await?;
    Ok(TaskCreated {
        task_id: report.task.id,
        title: report.task.title,
    })
}

#[tauri::command]
#[specta::specta]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectOption>, ApiError> {
    let mut monica = event_sink::open(&app)?;
    Ok(monica
        .projects()
        .list_projects()?
        .into_iter()
        .map(|p| ProjectOption { id: p.id })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn create_raw_task(
    app: AppHandle,
    title: String,
    project_id: String,
) -> Result<TaskCreated, ApiError> {
    let mut monica = event_sink::open(&app)?;
    let task = monica.tasks().create_raw_task(&title, &project_id)?;
    Ok(TaskCreated {
        task_id: task.id,
        title: task.title,
    })
}

#[tauri::command]
#[specta::specta]
pub fn list_bench_runspace_map(app: AppHandle) -> Result<Vec<(String, String)>, ApiError> {
    let mut monica = event_sink::open(&app)?;
    Ok(monica.executions().list_bench_runspace_map()?)
}

#[tauri::command]
#[specta::specta]
pub fn task_shell_env(app: AppHandle, task_id: String) -> Result<Vec<(String, String)>, ApiError> {
    let mut monica = event_sink::open(&app)?;
    Ok(monica.executions().task_shell_env(&task_id)?)
}

#[tauri::command]
#[specta::specta]
pub fn open_bench(app: AppHandle, task_id: String) -> Result<TaskBench, ApiError> {
    let mut monica = event_sink::open(&app)?;
    Ok(TaskBench::from(monica.executions().open_bench(&task_id)?))
}

#[tauri::command]
#[specta::specta]
pub fn prepare_task(app: AppHandle, task_id: String) -> Result<PrepareTaskResult, ApiError> {
    let result = {
        let mut monica = event_sink::open(&app)?;
        monica.executions().prepare_task(&task_id)?
    };

    crate::services::task_runner::spawn_execute_run(
        app,
        result.task_id.clone(),
        result.task_run_id.clone(),
    )
    .map_err(ApiError::external)?;

    Ok(result.into())
}

/// Promote the run living in the given Workbench tab to its task's Main Run. Returns whether the
/// primary actually changed; `false` covers "no run in this tab", "already main" and "primary is
/// mid-prepare" so the shortcut can stay a silent no-op.
#[tauri::command]
#[specta::specta]
pub fn make_main_task_run(app: AppHandle, tab_id: String) -> Result<bool, ApiError> {
    let mut monica = event_sink::open(&app)?;
    // The service emits `TaskRunStatusChanged` on a real change; the command only reports whether
    // the primary moved so the shortcut stays a silent no-op otherwise.
    let outcome = monica.tasks().make_main_by_terminal_tab(&tab_id)?;
    Ok(matches!(outcome, MakeMainOutcome::Changed { .. }))
}

#[tauri::command]
#[specta::specta]
pub fn primary_tab_id(app: AppHandle, task_id: String) -> Result<Option<String>, ApiError> {
    let mut monica = event_sink::open(&app)?;
    Ok(monica.tasks().primary_terminal_tab(&task_id)?)
}

// Worktree removal and branch deletion shell out to git and can take seconds;
// spawn_blocking keeps that sync work off the async runtime's workers.
#[tauri::command]
#[specta::specta]
pub async fn close_task(app: AppHandle, task_id: String) -> Result<(), ApiError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), ApiError> {
        let mut monica = event_sink::open(&app)?;
        monica.tasks().close_issue(&task_id).map(|_| ()).map_err(ApiError::from)
    })
    .await
    .map_err(|e| ApiError::external(e.to_string()))?
}

#[tauri::command]
#[specta::specta]
pub fn run_task(
    app: AppHandle,
    task_id: String,
    agent: Option<Agent>,
) -> Result<RunTaskResult, ApiError> {
    let mut monica = event_sink::open(&app)?;
    let result = monica
        .executions()
        .prepare_claude_for_run(&task_id, agent.map(monica_application::Agent::from))?;
    Ok(RunTaskResult::from(result))
}
