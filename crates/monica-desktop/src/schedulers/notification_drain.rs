use tauri::AppHandle;

use monica_domain::NotificationIntent;
use monica_runtime::{MonicaFacade, NotificationDrainHandle};

use crate::event_sink::TauriEventSink;

pub(crate) fn start(app_handle: AppHandle) -> NotificationDrainHandle {
    let facade_app = app_handle.clone();
    monica_runtime::start_notification_drain(
        move || open_facade(&facade_app),
        move |intent| deliver_notification(&app_handle, intent),
    )
}

fn open_facade(app: &AppHandle) -> anyhow::Result<MonicaFacade> {
    monica_runtime::open_monica(Box::new(TauriEventSink::new(app.clone())))
}

fn deliver_notification(app: &AppHandle, intent: &NotificationIntent) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&intent.title)
        .body(&intent.body)
        .show()
        .map_err(|e| e.to_string())
}
