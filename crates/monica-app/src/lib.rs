use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use monica_core::PullRequestSyncStatus;
use monica_infra::Runtime;

mod clipboard_commands;
mod git_commands;
mod ptyd;
#[cfg(all(unix, not(debug_assertions)))]
mod shell_path;
mod task_commands;
mod terminal_commands;

const PR_SYNC_INTERVAL: Duration = Duration::from_secs(10);
const PR_SYNC_BATCH_LIMIT: usize = 3;

fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            clipboard_commands::clipboard_write_image,
            git_commands::worktree_info,
            terminal_commands::terminal_create_session,
            terminal_commands::terminal_attach,
            terminal_commands::terminal_detach,
            terminal_commands::terminal_write,
            terminal_commands::terminal_resize,
            terminal_commands::terminal_terminate,
            terminal_commands::terminal_list_sessions,
            terminal_commands::terminal_load_state,
            terminal_commands::terminal_save_state,
            task_commands::list_task_summaries,
            task_commands::get_board_columns,
            task_commands::list_projects,
            task_commands::track_github_issue,
            task_commands::list_bench_runspace_map,
            task_commands::task_shell_env,
            task_commands::open_bench,
            task_commands::prepare_task,
            task_commands::run_task,
            task_commands::delete_task,
            task_commands::make_main_task_run,
            task_commands::primary_tab_id,
        ])
        .events(tauri_specta::collect_events![
            task_commands::TaskRunStatusChanged
        ])
}

fn bindings_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/commands/bindings.ts")
}

pub fn export_bindings() {
    specta_builder()
        .export(specta_typescript::Typescript::default(), bindings_path())
        .expect("failed to export typescript bindings");
    // Best-effort: specta's raw output fails `just check`'s fmt-check, so format at the source
    // (every writer: `just generate-bindings` and the dev-startup export). Environments
    // without bun still get valid bindings; `just fmt` remains the fallback. The path is
    // canonicalized because oxfmt rejects paths containing "..".
    if let Ok(path) = bindings_path().canonicalize() {
        let _ = std::process::Command::new("bunx")
            .arg("oxfmt")
            .arg(path)
            .status();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(unix, not(debug_assertions)))]
    let path_fix = shell_path::fix_path_from_login_shell();

    let specta_builder = specta_builder();

    #[cfg(debug_assertions)]
    export_bindings();

    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(release_log_plugin());

    builder
        .plugin(tauri_plugin_opener::init())
        .manage(ptyd::PtydHandle::new())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            start_pull_request_sync_scheduler();
            start_ptyd_warmup(app.handle().clone());
            #[cfg(not(debug_assertions))]
            log::info!(
                target: "monica_app::startup",
                "release file logging enabled path={}",
                release_log_path().display()
            );
            #[cfg(all(unix, not(debug_assertions)))]
            match &path_fix {
                Ok(()) => log::info!(
                    target: "monica_app::startup",
                    "PATH resolved from login shell"
                ),
                Err(e) => log::warn!(
                    target: "monica_app::startup",
                    "failed to resolve PATH from login shell: {e}"
                ),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Warm up the daemon connection (and its event pump) off-thread so window startup never
// blocks on a daemon spawn. Reconciliation is NOT done here: the frontend's first
// terminal_list_sessions call owns it, after this connection (or its own) is up.
fn start_ptyd_warmup(app: tauri::AppHandle) {
    use tauri::Manager;
    let spawned = std::thread::Builder::new()
        .name("monica-ptyd-warmup".to_string())
        .spawn(move || {
            if let Err(e) = app.state::<ptyd::PtydHandle>().ensure_connected(&app) {
                log::warn!(target: "monica_app::ptyd", "daemon warmup failed: {e:#}");
            }
        });
    if let Err(e) = spawned {
        log::error!(target: "monica_app::ptyd", "failed to start ptyd warmup thread: {e}");
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_typescript_bindings() {
        export_bindings();
    }
}
