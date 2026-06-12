use monica_core::{
    task_run_settlement_for_terminal_exit, TaskRunRepository, TaskRunStatus,
};
use monica_infra::Runtime;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::commands::task::TaskRunStatusChanged;

/// Settle the task runs orphaned by dead terminal sessions. Hooks cannot report a session that
/// was killed under them (closing a tab skips SessionEnd), so the terminal's death is the only
/// signal left; without this, the run shows running/waiting forever and the task can never be
/// re-run from the board.
pub(crate) fn settle_runs_for_terminated_sessions(
    app: &AppHandle,
    runtime: &mut Runtime,
    session_ids: &[String],
) {
    for session_id in session_ids {
        if let Err(e) = settle_one(app, runtime, session_id) {
            log::error!(
                target: "monica_app::run_settlement",
                "failed to settle run for session {session_id}: {e:#}"
            );
        }
    }
}

fn settle_one(app: &AppHandle, runtime: &mut Runtime, session_id: &str) -> anyhow::Result<()> {
    let Some(exited) = runtime.repositories.get_terminal_session(session_id)? else {
        return Ok(());
    };
    let Some(tab_id) = exited.tab_id.clone() else {
        return Ok(());
    };
    let latest = runtime
        .repositories
        .latest_terminal_session_for_tab(&tab_id)?;
    let run = runtime.repositories.find_task_run_by_terminal_tab(&tab_id)?;
    let Some(settlement) =
        task_run_settlement_for_terminal_exit(&exited, latest.as_ref(), run.as_ref())
    else {
        return Ok(());
    };
    // A false return means a hook settled the run first (SessionEnd, StopFailure); nothing to
    // announce then — the hook's own path already moved the board.
    if runtime
        .repositories
        .settle_task_run_if_live(&settlement.task_run_id, &settlement.task_id)?
    {
        let _ = TaskRunStatusChanged {
            task_id: settlement.task_id,
            task_run_id: settlement.task_run_id,
            status: TaskRunStatus::Stopped,
        }
        .emit(app);
    }
    Ok(())
}
