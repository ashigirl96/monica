use tauri::AppHandle;

use monica_runtime::{ClaudeSessionDrainHandle, MonicaFacade, TranscriptWatchHandle};

use crate::event_sink::TauriEventSink;

pub(crate) fn start(app_handle: AppHandle) -> Option<ClaudeSessionDrainHandle> {
    let home = home_dir()?;
    Some(monica_runtime::start_claude_session_drain(
        move || open_facade(&app_handle),
        home,
    ))
}

/// The transcript watcher that streams subscribed sessions: it only pokes the drain
/// worker, which is why it is started here alongside it.
pub(crate) fn start_transcript_watch(
    drain: &ClaudeSessionDrainHandle,
) -> Option<TranscriptWatchHandle> {
    let home = home_dir()?;
    let drain = drain.clone();
    match monica_runtime::start_transcript_watch(home, move |claude_session_id| {
        drain.wake_transcript(claude_session_id)
    }) {
        Ok(handle) => Some(handle),
        Err(e) => {
            log::error!(
                target: "monica_app::claude_session_drain",
                "failed to start the transcript watcher; sessions will stream on turn \
                 completion only: {e:#}"
            );
            None
        }
    }
}

fn home_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    if home.is_none() {
        log::error!(
            target: "monica_app::claude_session_drain",
            "HOME is not set; claude session events will not reach the UI"
        );
    }
    home
}

fn open_facade(app: &AppHandle) -> anyhow::Result<MonicaFacade> {
    monica_runtime::open_monica(Box::new(TauriEventSink::new(app.clone())))
}
