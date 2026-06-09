use monica_core::{
    BoardColumn, RunArtifacts, TaskBench, TaskRunStatus, TaskSummaryRow, TrackGithubIssueInput,
};
use monica_infra::Runtime;
use serde::Serialize;
use std::fs;

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

#[derive(Serialize, specta::Type)]
pub struct RunTaskAndOpenResult {
    pub task_id: String,
    pub task_run_id: String,
    pub runspace_id: String,
    pub worktree_path: String,
    pub branch: String,
    pub setup_log_path: String,
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
    let projects = monica_core::list_projects(&runtime.repositories).map_err(|e| e.to_string())?;
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
    let report = monica_core::track_github_issue(&mut runtime.repositories, &runtime.github, input)
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
pub fn open_bench(task_id: String) -> Result<TaskBench, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::open_bench(&mut runtime.repositories, &task_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn run_task_and_open(task_id: String) -> Result<RunTaskAndOpenResult, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let report = monica_core::start_issue_run_setup(
        &mut runtime.repositories,
        &runtime.git,
        &runtime.run_artifacts,
        &task_id,
    )
    .map_err(|e| e.to_string())?;
    let bench =
        monica_core::open_bench(&mut runtime.repositories, &task_id).map_err(|e| e.to_string())?;

    spawn_setup_completion(report.task_id.clone(), report.task_run_id.clone())?;

    Ok(RunTaskAndOpenResult {
        task_id: report.task_id,
        task_run_id: report.task_run_id,
        runspace_id: bench.runspace_id,
        worktree_path: report.worktree_path,
        branch: report.branch,
        setup_log_path: report.setup_log_path,
    })
}

#[tauri::command]
#[specta::specta]
pub fn read_setup_log(task_run_id: String) -> Result<String, String> {
    if !monica_core::is_safe_task_run_id(&task_run_id) {
        return Err("unsafe task run id".to_string());
    }
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let path = runtime
        .run_artifacts
        .setup_log_path(&task_run_id)
        .map_err(|e| e.to_string())?;
    match fs::read_to_string(&path) {
        Ok(body) => Ok(body),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn spawn_setup_completion(task_id: String, task_run_id: String) -> Result<(), String> {
    std::thread::Builder::new()
        .name(format!("setup-{task_run_id}"))
        .spawn(move || {
            let result = Runtime::open_default().and_then(|mut runtime| {
                monica_core::finish_issue_run_setup(
                    &mut runtime.repositories,
                    &runtime.setup_runner,
                    &runtime.run_artifacts,
                    &task_run_id,
                )
            });
            if let Err(e) = result {
                log::error!(
                    target: "monica_app::run_task_and_open",
                    "setup failed for {task_id}/{task_run_id}: {e:#}"
                );
                if let Ok(mut runtime) = Runtime::open_default() {
                    let _ = monica_core::TaskRunRepository::finish_task_run(
                        &mut runtime.repositories,
                        &task_run_id,
                        &task_id,
                        TaskRunStatus::Failed,
                    );
                }
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
