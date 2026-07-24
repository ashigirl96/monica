mod bridge;
mod commands;
mod event_sink;
mod native_menu;
mod ptyd;
mod schedulers;
mod services;

use tauri::Manager;
#[cfg(all(unix, not(debug_assertions)))]
mod shell_path;

pub struct WebUrl(pub String);

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
            commands::task::read_task_memo,
            commands::task::update_task_memo,
            commands::task::make_main_task_run,
            commands::task::primary_tab_id,
            commands::plan::read_runspace_plan,
            commands::pull_request::force_sync_pull_requests,
            commands::settings::translate_settings_get,
            commands::settings::translate_settings_save,
            commands::window::open_named_window,
        ])
        .events(tauri_specta::collect_events![
            commands::task::TaskRunStatusChanged,
            commands::pull_request::PrSyncCompleted,
            commands::settings::OpenSettingsRequested,
        ])
        .constant(
            "DEFAULT_TRANSLATE_PORT",
            monica_settings::DEFAULT_TRANSLATE_PORT,
        )
}

fn bindings_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop/commands/bindings.ts")
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
            if event.id().as_ref() == native_menu::SETTINGS_ID {
                use tauri_specta::Event;
                if let Err(e) = (commands::settings::OpenSettingsRequested {}).emit(app) {
                    log::warn!(target: "monica_app::settings", "failed to emit settings:open: {e}");
                }
            } else if event.id().as_ref() == native_menu::NEW_WINDOW_ID {
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
        .manage(bridge::BridgeHandle::new())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            let waker = schedulers::pull_request_sync::start(app.handle().clone());
            app.manage(waker);
            let drain = schedulers::notification_drain::start(app.handle().clone());
            app.manage(drain);
            let asset_gc = schedulers::asset_gc::start(app.handle().clone());
            app.manage(asset_gc);
            ptyd::start_warmup(app.handle().clone());
            // 起動をブロックしない + release では login-shell PATH 解決の後に
            // 走らせる（bridge の子 claude は PATH 解決 — setup はその後なので安全）
            let bridge_app = app.handle().clone();
            if let Err(e) = std::thread::Builder::new()
                .name("browser-bridge-spawn".to_string())
                .spawn(move || bridge::start_if_enabled(&bridge_app))
            {
                log::warn!(target: "monica_app::bridge", "failed to spawn bridge starter thread: {e}");
            }
            let web_bind = if cfg!(debug_assertions) {
                match std::env::var("MONICA_WEB_PORT").ok().and_then(|v| v.parse().ok()) {
                    Some(port) => monica_web::WebBind::Fixed(([127, 0, 0, 1], port).into()),
                    None => monica_web::WebBind::DevScan,
                }
            } else {
                monica_web::WebBind::Fixed(([127, 0, 0, 1], monica_web::PORT_PROD).into())
            };
            let (port_tx, port_rx) = std::sync::mpsc::sync_channel(1);
            if let Err(e) = std::thread::Builder::new()
                .name("monica-web".into())
                .spawn(move || {
                    if let Err(e) = monica_web::serve(web_bind, port_tx) {
                        log::error!(target: "monica_desktop::web", "web server failed: {e:?}");
                    }
                })
            {
                log::warn!(target: "monica_desktop::web", "failed to spawn web server thread: {e}");
            }
            let web_url = match port_rx.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(p) => {
                    #[cfg(debug_assertions)]
                    write_web_port_file(p);
                    format!("http://monica.localhost:{p}")
                }
                Err(e) => {
                    log::warn!(
                        target: "monica_desktop::web",
                        "web server port not received ({e}); MONICA_WEB_URL injection disabled"
                    );
                    String::new()
                }
            };
            app.manage(WebUrl(web_url));
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // bridge は app 同寿命: イベントループ終了で確実に殺す
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<bridge::BridgeHandle>().stop();
                #[cfg(debug_assertions)]
                let _ = std::fs::remove_file(web_port_file_path());
            }
        });
}

/// vite dev server が並走中の dev backend の port を発見するための rendezvous ファイル。
/// bindings_path と同じく、dev バイナリはビルドした worktree で動く前提の焼き込みパス。
#[cfg(debug_assertions)]
fn web_port_file_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/monica-web-port")
}

/// 2 行目の PID は読み手側の stale 判定用。SIGINT / SIGTERM 終了では RunEvent::Exit が
/// 踏まれずファイルが残留する（bridge の kill_stale_bridge と同じ事情）ため、削除ではなく
/// 生存確認で回収する。
#[cfg(debug_assertions)]
fn write_web_port_file(port: u16) {
    let path = web_port_file_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, format!("{port}\n{}\n", std::process::id())) {
        log::warn!(target: "monica_desktop::web", "failed to write web port file: {e}");
    }
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
