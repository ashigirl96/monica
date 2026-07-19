//! Desktop wiring for the orphan-asset GC worker. The interval/sweep mechanics live in
//! `monica-runtime`; the desktop only supplies a façade factory carrying its Tauri event sink.

use tauri::AppHandle;

use monica_runtime::MonicaFacade;

use crate::event_sink::TauriEventSink;

pub use monica_runtime::AssetGcHandle;

pub(crate) fn start(app_handle: AppHandle) -> AssetGcHandle {
    monica_runtime::start_asset_gc(move || open_facade(&app_handle))
}

fn open_facade(app: &AppHandle) -> anyhow::Result<MonicaFacade> {
    monica_runtime::open_monica(Box::new(TauriEventSink::new(app.clone())))
}
