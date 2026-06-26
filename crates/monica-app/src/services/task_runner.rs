use monica_application::TaskRunStatus;
use monica_infra::Runtime;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::commands::task::TaskRunStatusChanged;

pub(crate) fn spawn_execute_run(
    app: AppHandle,
    task_id: String,
    run_id: String,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name(format!("run-{run_id}"))
        .spawn(move || {
            let mut rt = match Runtime::open_default() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!(target: "monica_app::prepare_task", "background runtime open failed: {e:#}");
                    return;
                }
            };
            let final_status = match monica_application::execute_run(
                &mut rt.repositories,
                &rt.git,
                &rt.setup_runner,
                &rt.task_run_outputs,
                &task_id,
                &run_id,
            ) {
                Ok(s) => s,
                Err(e) => {
                    log::error!(target: "monica_app::prepare_task", "execute_run failed: {e:#}");
                    TaskRunStatus::Failed
                }
            };
            let _ = TaskRunStatusChanged {
                task_id,
                task_run_id: run_id,
                status: final_status.into(),
            }
            .emit(&app);
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
