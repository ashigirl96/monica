use monica_core::{
    BoardColumn, PrepareTaskResult, RunTaskResult, TaskBench, TaskRunStatus, TaskSummaryFilter,
    TaskSummaryRow, TrackGithubIssueInput,
};
use monica_infra::Runtime;
use serde::Serialize;
use tauri::AppHandle;
use tauri_specta::Event;

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
pub fn list_task_summaries(project: Option<String>) -> Result<Vec<TaskSummaryRow>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::list_task_summaries(&runtime.repositories, TaskSummaryFilter::All, project.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_board_columns() -> Vec<BoardColumn> {
    monica_core::board_columns()
}

#[tauri::command]
#[specta::specta]
pub async fn track_github_issue(input: String) -> Result<TaskCreated, String> {
    let (repo, number) = monica_core::parse_issue_input(&input).map_err(|e| e.to_string())?;
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let input = TrackGithubIssueInput { repo, number };
    let report =
        monica_core::track_github_issue(&mut runtime.repositories, &runtime.github, input)
            .await
            .map_err(|e| e.to_string())?;
    Ok(TaskCreated {
        task_id: report.task.id,
        title: report.task.title,
    })
}

#[tauri::command]
#[specta::specta]
pub fn list_projects() -> Result<Vec<ProjectOption>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    Ok(monica_core::list_projects(&runtime.repositories)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|p| ProjectOption { id: p.id })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn create_raw_task(title: String, project_id: String) -> Result<TaskCreated, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let task = monica_core::create_raw_task(&mut runtime.repositories, &title, &project_id)
        .map_err(|e| e.to_string())?;
    Ok(TaskCreated {
        task_id: task.id,
        title: task.title,
    })
}

#[tauri::command]
#[specta::specta]
pub fn list_bench_runspace_map() -> Result<Vec<(String, String)>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::BenchRepository::list_bench_runspace_map(&runtime.repositories)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn task_shell_env(task_id: String) -> Result<Vec<(String, String)>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::task_shell_env(&runtime.repositories, &runtime.task_run_outputs, &task_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn open_bench(task_id: String) -> Result<TaskBench, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::open_bench(&mut runtime.repositories, &runtime.task_run_outputs, &task_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn prepare_task(app: AppHandle, task_id: String) -> Result<PrepareTaskResult, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let result =
        monica_core::start_run(&mut runtime.repositories, &task_id).map_err(|e| e.to_string())?;

    crate::services::task_runner::spawn_execute_run(
        app,
        result.task_id.clone(),
        result.task_run_id.clone(),
    )?;

    Ok(result)
}

/// Promote the run living in the given Workbench tab to its task's Main Run. Returns whether the
/// primary actually changed; `false` covers "no run in this tab", "already main" and "primary is
/// mid-prepare" so the shortcut can stay a silent no-op.
#[tauri::command]
#[specta::specta]
pub fn make_main_task_run(app: AppHandle, tab_id: String) -> Result<bool, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let outcome = monica_core::make_main_by_terminal_tab(&runtime.repositories, &tab_id)
        .map_err(|e| e.to_string())?;
    match outcome {
        monica_core::MakeMainOutcome::Changed {
            task_id,
            task_run_id,
            status,
        } => {
            let _ = TaskRunStatusChanged {
                task_id,
                task_run_id,
                status,
            }
            .emit(&app);
            Ok(true)
        }
        monica_core::MakeMainOutcome::AlreadyMain
        | monica_core::MakeMainOutcome::PrimaryBusy
        | monica_core::MakeMainOutcome::NotFound => Ok(false),
    }
}

#[tauri::command]
#[specta::specta]
pub fn primary_tab_id(task_id: String) -> Result<Option<String>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::primary_terminal_tab(&runtime.repositories, &task_id).map_err(|e| e.to_string())
}

// Worktree removal and branch deletion shell out to git and can take seconds;
// spawn_blocking keeps that sync work off the async runtime's workers.
#[tauri::command]
#[specta::specta]
pub async fn close_task(task_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
        monica_core::close_issue(&mut runtime.repositories, &runtime.git, &task_id)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub fn run_task(task_id: String, agent: Option<monica_core::Agent>) -> Result<RunTaskResult, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::prepare_claude_for_run(
        &mut runtime.repositories,
        &runtime.task_run_outputs,
        &task_id,
        agent,
    )
    .map_err(|e| e.to_string())
}
