use tauri::AppHandle;

use monica_runtime::{ClaudeSessionDrainHandle, MonicaFacade};

use crate::event_sink::TauriEventSink;

pub(crate) fn start(app_handle: AppHandle) -> Option<ClaudeSessionDrainHandle> {
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        log::error!(
            target: "monica_app::claude_session_drain",
            "HOME is not set; claude session events will not reach the UI"
        );
        return None;
    };
    Some(monica_runtime::start_claude_session_drain(
        move || open_facade(&app_handle),
        home,
    ))
}

fn open_facade(app: &AppHandle) -> anyhow::Result<MonicaFacade> {
    monica_runtime::open_monica(Box::new(TauriEventSink::new(app.clone())))
}
