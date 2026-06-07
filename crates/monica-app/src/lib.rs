use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use monica_core::{Event, GithubAuthStatus, PullRequestSyncStatus, Task, TaskSummaryRow};
use monica_infra::Runtime;
use monica_pty::PtyManager;

mod pty_commands;

const PR_SYNC_INTERVAL: Duration = Duration::from_secs(10);
const PR_SYNC_BATCH_LIMIT: usize = 3;

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
fn github_auth_status() -> Result<GithubAuthStatus, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let status = monica_core::github_auth_status(&runtime.auth);
    if status.authenticated {
        log::info!(
            target: "monica_app::github_auth",
            "GitHub auth available source={} login={}",
            status.source,
            status.login.as_deref().unwrap_or("-")
        );
    } else {
        log::warn!(
            target: "monica_app::github_auth",
            "GitHub auth unavailable source={} message={}",
            status.source,
            status.message.as_deref().unwrap_or("-")
        );
    }
    Ok(status)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(release_log_plugin());

    builder
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
        .setup(|_| {
            start_pull_request_sync_scheduler();
            #[cfg(not(debug_assertions))]
            log::info!(
                target: "monica_app::startup",
                "release file logging enabled path={}",
                release_log_path().display()
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tasks,
            list_task_summaries,
            list_events,
            delete_task,
            github_auth_status,
            pty_commands::pty_spawn,
            pty_commands::pty_write,
            pty_commands::pty_resize,
            pty_commands::pty_kill,
            pty_commands::terminal_load_state,
            pty_commands::terminal_save_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn start_pull_request_sync_scheduler() {
    let in_flight = Arc::new(AtomicBool::new(false));
    let scheduler_in_flight = Arc::clone(&in_flight);
    let spawn_result = std::thread::Builder::new()
        .name("monica-pr-sync".to_string())
        .spawn(move || loop {
            std::thread::sleep(PR_SYNC_INTERVAL);
            if scheduler_in_flight.swap(true, Ordering::AcqRel) {
                continue;
            }
            let _guard = PullRequestSyncGuard(Arc::clone(&scheduler_in_flight));
            tauri::async_runtime::block_on(sync_pull_request_batch(PR_SYNC_BATCH_LIMIT));
        });
    if let Err(e) = spawn_result {
        log::error!(target: "monica_app::pr_sync", "failed to start PR sync scheduler: {e}");
    }
}

struct PullRequestSyncGuard(Arc<AtomicBool>);

impl Drop for PullRequestSyncGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn sync_pull_request_batch(limit: usize) {
    let mut runtime = match Runtime::open_default() {
        Ok(runtime) => runtime,
        Err(e) => {
            log::error!(target: "monica_app::pr_sync", "failed to open runtime for PR sync: {e:#}");
            return;
        }
    };

    if !monica_core::github_auth_status(&runtime.auth).authenticated {
        return;
    }

    for _ in 0..limit {
        let result =
            match monica_core::sync_next_pull_request(&mut runtime.repositories, &runtime.github)
                .await
            {
                Ok(result) => result,
                Err(e) => {
                    log::error!(target: "monica_app::pr_sync", "PR sync scheduler failed: {e:#}");
                    break;
                }
            };

        match result.status {
            PullRequestSyncStatus::Idle => {
                log::debug!(target: "monica_app::pr_sync", "PR sync scheduler idle");
                break;
            }
            PullRequestSyncStatus::Synced => {
                log::info!(
                    target: "monica_app::pr_sync",
                    "PR sync scheduler synced task_id={} pull_request_count={}",
                    result.task_id.as_deref().unwrap_or("-"),
                    result.pull_request_count
                );
            }
            PullRequestSyncStatus::Failed => {
                log::warn!(
                    target: "monica_app::pr_sync",
                    "PR sync scheduler recorded failure task_id={} error={}",
                    result.task_id.as_deref().unwrap_or("-"),
                    result.error.as_deref().unwrap_or("-")
                );
            }
        }
    }
}

#[cfg(not(debug_assertions))]
fn release_log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

    tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::Folder {
            path: release_log_dir(),
            file_name: Some("monica".to_string()),
        }))
        .level(log::LevelFilter::Info)
        .max_file_size(1_000_000)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .build()
}

#[cfg(not(debug_assertions))]
fn release_log_dir() -> std::path::PathBuf {
    monica_infra::filesystem::paths::logs_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("monica").join("logs"))
}

#[cfg(not(debug_assertions))]
fn release_log_path() -> std::path::PathBuf {
    release_log_dir().join("monica.log")
}
