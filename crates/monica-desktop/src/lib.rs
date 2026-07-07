mod agent_runtime_events;
mod commands;
mod event_sink;
mod native_menu;
mod ptyd;
mod schedulers;
mod agent_runtime_server;
mod services;

use tauri::Manager;
#[cfg(all(unix, not(debug_assertions)))]
mod shell_path;

fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            commands::clipboard::clipboard_write_image,
            commands::editor::resolve_editor_paths,
            commands::editor::open_in_editor,
            commands::git::worktree_info,
            commands::terminal::terminal_create_session,
            commands::terminal::terminal_attach,
            commands::terminal::terminal_detach,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_terminate,
            commands::terminal::terminal_list_sessions,
            commands::terminal::terminal_load_state,
            commands::terminal::terminal_save_state,
            commands::task::list_task_summaries,
            commands::task::get_board_columns,
            commands::task::track_github_issue,
            commands::task::list_projects,
            commands::task::create_raw_task,
            commands::task::list_bench_runspace_map,
            commands::task::task_shell_env,
            commands::task::open_bench,
            commands::task::prepare_task,
            commands::task::run_task,
            commands::task::close_task,
            commands::task::make_main_task_run,
            commands::task::primary_tab_id,
            commands::notebook::list_notebooks,
            commands::notebook::get_notebook_pages,
            commands::plan::read_runspace_plan,
            commands::pull_request::force_sync_pull_requests,
            commands::claude_runtime::claude_list_sessions,
            commands::window::open_named_window,
        ])
        .events(tauri_specta::collect_events![
            commands::task::TaskRunStatusChanged,
            commands::pull_request::PrSyncCompleted,
            commands::claude_runtime::ClaudeSessionOpened,
            commands::claude_runtime::ClaudeSessionStateChanged,
            commands::claude_runtime::ClaudeSessionMessage,
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

    let builder = tauri::Builder::default()
        .menu(native_menu::build)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == native_menu::NEW_WINDOW_ID {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    match services::window_manager::open_new_window(app).await {
                        Ok(label) => {
                            log::info!(target: "monica_app::window", "opened new window {label}")
                        }
                        Err(err) => {
                            log::error!(target: "monica_app::window", "failed to open new window: {err:?}")
                        }
                    }
                });
            }
        });
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    #[cfg(debug_assertions)]
    let builder = builder.plugin(debug_log_plugin());
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(release_log_plugin());

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(ptyd::PtydHandle::new())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            // Before any scheduler starts: the sink publishes through this state, so it
            // must exist before the first façade can emit.
            app.manage(std::sync::Arc::new(
                agent_runtime_events::ClaudeSessionBroadcaster::default(),
            ));
            let waker = schedulers::pull_request_sync::start(app.handle().clone());
            app.manage(waker);
            let drain = schedulers::notification_drain::start(app.handle().clone());
            app.manage(drain);
            if let Some(claude_drain) =
                schedulers::claude_session_drain::start(app.handle().clone())
            {
                app.manage(claude_drain);
            }
            ptyd::start_warmup(app.handle().clone());
            agent_runtime_server::start(app.handle().clone());
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

#[cfg(debug_assertions)]
fn debug_log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{Target, TargetKind};

    // Dev builds otherwise initialize no logger, so backend `log::*` output is silently dropped.
    // Route it to stdout (the `just dev` console) and the webview console for parity with the
    // release Folder target.
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::Stdout))
        .target(Target::new(TargetKind::Webview))
        .level(log::LevelFilter::Info)
        .build()
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
    monica_paths::logs_dir()
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
