use monica_api::{
    Agent, ApiError, AttachTabResult, BoardColumn, PrepareTaskResult, ProjectOption, RunMode,
    RunTaskResult, TabTaskBinding, TaskBench, TaskCreated, TaskRunStatus, TaskSummaryRow,
};
use monica_application::parse_issue_input;
use monica_domain::{TaskId, TaskRunId};
use serde::Serialize;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::event_sink;

#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "task-run:status-changed")]
pub struct TaskRunStatusChanged {
    pub(crate) task_id: String,
    pub(crate) task_run_id: String,
    pub(crate) status: TaskRunStatus,
}

#[tauri::command]
#[specta::specta]
pub async fn list_task_summaries(
    app: AppHandle,
    project: Option<String>,
) -> Result<Vec<TaskSummaryRow>, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .tasks()
            .list_all_task_summaries(project.as_deref())?
            .into_iter()
            .map(TaskSummaryRow::from)
            .collect())
    })
    .await
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
        parse_issue_input(&input).map_err(|e| ApiError::validation(e.to_string()))?;
    let mut monica = event_sink::open(&app)?;
    let report = monica
        .synchronization()
        .track_github_issue(repo, number)
        .await?;
    Ok(TaskCreated {
        task_id: report.task.id.into(),
        title: report.task.title,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn list_projects(app: AppHandle) -> Result<Vec<ProjectOption>, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .projects()
            .list_projects()?
            .into_iter()
            .map(Into::into)
            .collect())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_raw_task(
    app: AppHandle,
    title: String,
    project_id: String,
) -> Result<TaskCreated, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        let task = monica.tasks().create_raw_task(&title, &project_id)?;
        Ok(TaskCreated {
            task_id: task.id.into(),
            title: task.title,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bench_runspace_map(
    app: AppHandle,
) -> Result<Vec<(String, String)>, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .executions()
            .list_bench_runspace_map()?
            .into_iter()
            .map(|(runspace_id, task_id)| (runspace_id.into_string(), task_id.into_string()))
            .collect())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn task_shell_env(
    app: AppHandle,
    task_id: String,
) -> Result<Vec<(String, String)>, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica.executions().task_shell_env(&TaskId::from_store(task_id))?)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn open_bench(app: AppHandle, task_id: String) -> Result<TaskBench, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(TaskBench::from(
            monica.executions().open_bench(&TaskId::from_store(task_id))?,
        ))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn prepare_task(app: AppHandle, task_id: String) -> Result<PrepareTaskResult, ApiError> {
    let app_spawn = app.clone();
    let result: PrepareTaskResult = event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        let result = monica.executions().prepare_task(&TaskId::from_store(task_id))?;
        Ok(result.into())
    })
    .await?;

    crate::services::task_runner::spawn_execute_run(
        app_spawn,
        TaskId::from_store(result.task_id.clone()),
        TaskRunId::from_store(result.task_run_id.clone()),
    )
    .map_err(ApiError::external)?;

    Ok(result)
}

/// Promote the run living in the given Workbench tab to its task's Main Run. Returns whether the
/// primary actually changed; `false` covers "no run in this tab", "already main" and "primary is
/// mid-prepare" so the shortcut can stay a silent no-op.
#[tauri::command]
#[specta::specta]
pub async fn make_main_task_run(app: AppHandle, tab_id: String) -> Result<bool, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica.tasks().make_main_by_terminal_tab(&tab_id)?)
    })
    .await
}

/// Bind the Claude session in a Workbench tab to a task as its Main Run (`monica task attach`
/// from the GUI). `cwd` is the tab's current directory, which seeds the bench when the task has
/// none. The tab itself is moved by the caller: the layout is frontend state.
#[tauri::command]
#[specta::specta]
pub async fn attach_terminal_tab(
    app: AppHandle,
    task_id: String,
    tab_id: String,
    session_id: String,
    cwd: String,
) -> Result<AttachTabResult, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        let task_id = TaskId::from_store(task_id);
        let report = monica.tasks().attach_terminal_session(
            &task_id,
            monica_domain::Agent::Claude,
            &tab_id,
            &session_id,
            &cwd,
        )?;
        let env = monica.executions().task_shell_env(&task_id)?;
        Ok(AttachTabResult {
            task_id: report.task_id.into(),
            task_run_id: report.task_run_id.into(),
            runspace_id: report.runspace_id.into(),
            env,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_tab_task_bindings(app: AppHandle) -> Result<Vec<TabTaskBinding>, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .tasks()
            .list_tab_task_bindings()?
            .into_iter()
            .map(TabTaskBinding::from)
            .collect())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn primary_tab_id(
    app: AppHandle,
    task_id: String,
) -> Result<Option<String>, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica.tasks().primary_terminal_tab(&TaskId::from_store(task_id))?)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn close_task(app: AppHandle, task_id: String) -> Result<(), ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        monica
            .tasks()
            .close_task(&TaskId::from_store(task_id))
            .map(|_| ())
            .map_err(ApiError::from)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn run_task(
    app: AppHandle,
    task_id: String,
    agent: Option<Agent>,
    mode: RunMode,
) -> Result<RunTaskResult, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        let result = monica.executions().run_task(
            &TaskId::from_store(task_id),
            agent.map(monica_domain::Agent::from),
            monica_domain::RunMode::from(mode),
        )?;
        Ok(RunTaskResult::from(result))
    })
    .await
}
