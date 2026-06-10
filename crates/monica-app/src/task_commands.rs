use monica_core::{
    BoardColumn, PrepareTaskResult, RunTaskResult, TaskBench, TaskRunStatus, TaskSummaryRow,
    TrackGithubIssueInput,
};
use monica_infra::Runtime;
use serde::Serialize;
use tauri::AppHandle;
use tauri_specta::Event;

#[derive(Serialize, specta::Type)]
pub struct ProjectEntry {
    pub repo: String,
    pub name: String,
}

#[derive(Serialize, specta::Type)]
pub struct TrackIssueResult {
    pub task_id: String,
    pub title: String,
}

#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "task-run:status-changed")]
pub struct TaskRunStatusChanged {
    task_id: String,
    task_run_id: String,
    status: TaskRunStatus,
}

#[tauri::command]
#[specta::specta]
pub fn list_task_summaries() -> Result<Vec<TaskSummaryRow>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::list_task_summaries(&runtime.repositories, None, None).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_board_columns() -> Vec<BoardColumn> {
    monica_core::board_columns()
}

#[tauri::command]
#[specta::specta]
pub fn list_projects() -> Result<Vec<ProjectEntry>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let projects =
        monica_core::list_projects(&runtime.repositories).map_err(|e| e.to_string())?;
    Ok(projects
        .into_iter()
        .map(|p| ProjectEntry {
            name: p.name,
            repo: p.repo,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn track_github_issue(repo: String, number: i32) -> Result<TrackIssueResult, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let input = TrackGithubIssueInput {
        repo,
        number: i64::from(number),
    };
    let report =
        monica_core::track_github_issue(&mut runtime.repositories, &runtime.github, input)
            .await
            .map_err(|e| e.to_string())?;
    Ok(TrackIssueResult {
        task_id: report.task.id,
        title: report.task.title,
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
    monica_core::task_shell_env(&runtime.repositories, &runtime.run_artifacts, &task_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn open_bench(task_id: String) -> Result<TaskBench, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::open_bench(&mut runtime.repositories, &runtime.run_artifacts, &task_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn prepare_task(app: AppHandle, task_id: String) -> Result<PrepareTaskResult, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let result =
        monica_core::start_run(&mut runtime.repositories, &task_id).map_err(|e| e.to_string())?;

    let run_id = result.task_run_id.clone();
    let tid = result.task_id.clone();

    std::thread::Builder::new()
        .name(format!("run-{run_id}"))
        .spawn(move || {
            let mut rt = match Runtime::open_default() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!(target: "monica_app::prepare_task", "background runtime open failed: {e:#}");
                    return;
                }
            };
            let final_status = match monica_core::execute_run(
                &mut rt.repositories,
                &rt.git,
                &rt.setup_runner,
                &rt.run_artifacts,
                &tid,
                &run_id,
            ) {
                Ok(s) => s,
                Err(e) => {
                    log::error!(target: "monica_app::prepare_task", "execute_run failed: {e:#}");
                    TaskRunStatus::Failed
                }
            };
            let _ = TaskRunStatusChanged {
                task_id: tid,
                task_run_id: run_id,
                status: final_status,
            }
            .emit(&app);
        })
        .map_err(|e| e.to_string())?;

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

#[tauri::command]
#[specta::specta]
pub fn run_task(task_id: String) -> Result<RunTaskResult, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::prepare_claude_for_run(
        &mut runtime.repositories,
        &runtime.run_artifacts,
        &task_id,
    )
    .map_err(|e| e.to_string())
}
