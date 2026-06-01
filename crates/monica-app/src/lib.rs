use monica_core::{
    delete_issue, Db, Event, GithubAuthStatus, PullRequestSyncResult, Task, TaskSummaryRow,
};

#[tauri::command]
fn list_tasks() -> Result<Vec<Task>, String> {
    let db = Db::open().map_err(|e| e.to_string())?;
    db.list_tasks().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_task_summaries() -> Result<Vec<TaskSummaryRow>, String> {
    let db = Db::open().map_err(|e| e.to_string())?;
    db.list_task_summaries(None, None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_events(task_id: String) -> Result<Vec<Event>, String> {
    let db = Db::open().map_err(|e| e.to_string())?;
    db.list_events(Some(&task_id)).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_task(id: String) -> Result<(), String> {
    let mut db = Db::open().map_err(|e| e.to_string())?;
    delete_issue(&mut db, &id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_next_linked_pull_request() -> Result<PullRequestSyncResult, String> {
    let mut db = Db::open().map_err(|e| e.to_string())?;
    monica_core::sync_next_linked_pull_request(&mut db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_github_token(token: String) -> Result<GithubAuthStatus, String> {
    monica_core::save_github_token(token)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn github_auth_status() -> Result<GithubAuthStatus, String> {
    monica_core::github_auth_status().map_err(|e| e.to_string())
}

#[tauri::command]
fn github_sign_out() -> Result<(), String> {
    monica_core::github_sign_out().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("opening URLs is only supported on macOS".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_tasks,
            list_task_summaries,
            list_events,
            delete_task,
            sync_next_linked_pull_request,
            save_github_token,
            github_auth_status,
            github_sign_out,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
