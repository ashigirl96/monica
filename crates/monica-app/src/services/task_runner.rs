use tauri::AppHandle;

use crate::event_sink::TauriEventSink;

/// Run phase 2 (`execute_run`) off the UI thread. The façade is opened inside the spawned thread
/// (it owns a `!Send` SQLite connection) and emits the run's resulting status through its sink, so
/// this driver helper only owns the thread, not any orchestration.
pub(crate) fn spawn_execute_run(
    app: AppHandle,
    task_id: String,
    run_id: String,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name(format!("run-{run_id}"))
        .spawn(move || {
            let mut monica = match monica_infra::open_monica(Box::new(TauriEventSink::new(app))) {
                Ok(monica) => monica,
                Err(e) => {
                    log::error!(target: "monica_app::prepare_task", "background façade open failed: {e:#}");
                    return;
                }
            };
            if let Err(e) = monica.executions().execute_run(&task_id, &run_id) {
                log::error!(target: "monica_app::prepare_task", "execute_run failed: {e}");
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
