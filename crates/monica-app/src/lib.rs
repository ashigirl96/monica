use monica_core::{Event, GithubAuthStatus, PullRequestSyncResult, Task, TaskSummaryRow};
use monica_infra::Runtime;

#[tauri::command]
fn list_tasks() -> Result<Vec<Task>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::list_tasks(&runtime.repositories).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_task_summaries() -> Result<Vec<TaskSummaryRow>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::list_task_summaries(&runtime.repositories, None, None).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_events(task_id: String) -> Result<Vec<Event>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::list_events(&runtime.repositories, Some(&task_id)).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_task(id: String) -> Result<(), String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::delete_issue(&mut runtime.repositories, &runtime.git, &id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_next_linked_pull_request() -> Result<PullRequestSyncResult, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::sync_next_linked_pull_request(&mut runtime.repositories, &runtime.github)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn github_auth_status() -> Result<GithubAuthStatus, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    Ok(monica_core::github_auth_status(&runtime.auth))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_tasks,
            list_task_summaries,
            list_events,
            delete_task,
            github_auth_status,
            sync_next_linked_pull_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
