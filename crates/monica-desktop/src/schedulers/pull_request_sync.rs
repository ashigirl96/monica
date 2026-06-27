//! Desktop wiring for the PR-sync worker. The interval/guard/waker mechanics live in
//! `monica-runtime`; the desktop only supplies a façade factory carrying its Tauri event sink.

use tauri::AppHandle;

use monica_runtime::MonicaFacade;

use crate::event_sink::TauriEventSink;

pub use monica_runtime::PrSyncWaker;

pub(crate) fn start(app_handle: AppHandle) -> PrSyncWaker {
    monica_runtime::start_pr_sync(move || open_facade(&app_handle))
}

fn open_facade(app: &AppHandle) -> anyhow::Result<MonicaFacade> {
    monica_runtime::open_monica(Box::new(TauriEventSink::new(app.clone())))
}
