mod announcement;
mod backend;
mod cli_link;
mod orphan;
mod respawn;

use std::path::PathBuf;

use announcement::Endpoint;
use backend::Supervisor;
use tauri::{AppHandle, Manager, RunEvent, State};

#[tauri::command]
fn backend_endpoint(supervisor: State<'_, Supervisor>) -> Option<Endpoint> {
    supervisor.endpoint()
}

#[tauri::command]
fn backend_restart(app: AppHandle) {
    backend::restart(&app);
}

pub fn run() {
    let home = tania_home();
    // 2 つ目の起動は build の中（setup より前）で抜けるので、孤児の掃除が 1 つ目の Backend を止めることはない。
    let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );
    builder
        .manage(Supervisor::new(home.clone()))
        .invoke_handler(tauri::generate_handler![backend_endpoint, backend_restart])
        .setup(move |app| {
            #[cfg(debug_assertions)]
            app.add_capability(include_str!("../capabilities-debug/mcp-bridge.json"))?;
            cli_link::link(&home);
            backend::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // ptyd は setsid で切り離されているので、止まるのは Backend だけ。
            if let RunEvent::Exit = event {
                app.state::<Supervisor>().stop();
            }
        });
}

fn tania_home() -> PathBuf {
    std::env::var_os("TANIA_HOME").map(PathBuf::from).unwrap_or_else(|| {
        let user_home = PathBuf::from(std::env::var_os("HOME").expect("HOME is set"));
        user_home.join(if cfg!(debug_assertions) { ".tania-dev" } else { ".tania" })
    })
}

/// release の `.app` で Shell の隣（`Contents/MacOS`）に置かれた externalBin。
fn sibling(name: &str) -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe is readable");
    exe.parent().expect("exe has a directory").join(name)
}
