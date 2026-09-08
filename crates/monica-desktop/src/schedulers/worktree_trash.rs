//! One-shot startup reap of worktrees whose deferred deletion never finished (a reaper cut off by
//! a reboot). Off the setup thread: opening the store and spawning `rm` must not delay the window.

use tauri::AppHandle;

use crate::event_sink::TauriEventSink;

pub(crate) fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("monica-worktree-trash".to_string())
        .spawn(move || match monica_runtime::open_monica(Box::new(TauriEventSink::new(app))) {
            Ok(mut monica) => monica.executions().reap_worktree_trash(),
            Err(e) => log::warn!(
                target: "monica_app::worktree_trash",
                "failed to open façade for worktree trash reap: {e:#}"
            ),
        });
    if let Err(e) = spawned {
        log::error!(target: "monica_app::worktree_trash", "failed to start worktree trash reap thread: {e}");
    }
}
