mod announcement;
mod backend;
mod cli_link;
mod locations;
mod orphan;
mod respawn;

use std::time::Duration;

use announcement::Endpoint;
use backend::Supervisor;
use tauri::{AppHandle, Manager, RunEvent, State};

/// Backend は通常 50ms 以内に抜けるので、これは固まった Backend のための上限（ADR-0007）。
const STOP_GRACE: Duration = Duration::from_secs(2);

#[tauri::command]
fn backend_endpoint(supervisor: State<'_, Supervisor>) -> Option<Endpoint> {
    supervisor.endpoint()
}

#[tauri::command]
fn backend_restart(app: AppHandle, supervisor: State<'_, Supervisor>) {
    supervisor.restart(&app);
}

pub fn run() {
    let home = locations::tania_home();
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
            app.state::<Supervisor>().start(app.handle());
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
