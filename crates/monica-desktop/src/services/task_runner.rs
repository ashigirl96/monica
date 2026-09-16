use monica_domain::{TaskId, TaskRunId};
use tauri::AppHandle;

use crate::event_sink::TauriEventSink;
use crate::log_target::PREPARE_TASK;

/// Run phase 2 (`execute_run`) off the UI thread. The façade is opened inside the spawned thread
/// (it owns a `!Send` SQLite connection) and emits the run's resulting status through its sink, so
/// this driver helper only owns the thread, not any orchestration.
pub(crate) fn spawn_execute_run(
    app: AppHandle,
    task_id: TaskId,
    run_id: TaskRunId,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name(format!("run-{run_id}"))
        .spawn(move || {
            let mut monica = match monica_runtime::open_monica(Box::new(TauriEventSink::new(app))) {
                Ok(monica) => monica,
                Err(e) => {
                    log::error!(target: PREPARE_TASK, "background façade open failed: {e:#}");
                    return;
                }
            };
            if let Err(e) = monica.executions().execute_run(&task_id, &run_id) {
                log::error!(target: PREPARE_TASK, "execute_run failed: {e}");
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
