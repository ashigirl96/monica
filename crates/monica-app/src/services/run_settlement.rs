use monica_application::{
    task_run_settlement_for_orphaned_run, task_run_settlement_for_terminal_exit,
    TaskRunRepository, TaskRunStatus, TerminalExitSettlement, TerminalSessionUpdate,
};
use monica_infra::Runtime;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::commands::task::TaskRunStatusChanged;

/// Session ids from an update batch that reached a terminal state. Keeping the filter here
/// means every caller of the settle loop applies the same precondition instead of each
/// hand-rolling (or forgetting) it.
pub(crate) fn terminated_session_ids(updates: &[TerminalSessionUpdate]) -> Vec<String> {
    updates
        .iter()
        .filter(|u| u.status.is_terminal())
        .map(|u| u.session_id.clone())
        .collect()
}

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

/// Run-first sweep over every run still pinned to a tab whose latest session is dead. The
/// session-first path above fires once per death event and reaches one run per tab; this
/// catches what it can miss — a crash between recording the exit and settling, sessions
/// already terminal before this build, an older run shadowed by a newer one in the same tab —
/// and is cheap enough (driven runs are few) to run on every reconcile.
pub(crate) fn settle_orphaned_runs(app: &AppHandle, runtime: &mut Runtime) {
    let runs = match runtime.repositories.list_driven_task_runs_with_tab() {
        Ok(runs) => runs,
        Err(e) => {
            log::error!(
                target: "monica_app::run_settlement",
                "failed to list driven runs for the orphan sweep: {e:#}"
            );
            return;
        }
    };
    for run in runs {
        let Some(tab_id) = run.terminal_tab_id.clone() else {
            continue;
        };
        let settled = runtime
            .repositories
            .latest_terminal_session_for_tab(&tab_id)
            .and_then(|latest| {
                match task_run_settlement_for_orphaned_run(&run, latest.as_ref()) {
                    Some(settlement) => apply_settlement(app, runtime, settlement),
                    None => Ok(()),
                }
            });
        if let Err(e) = settled {
            log::error!(
                target: "monica_app::run_settlement",
                "failed to settle orphaned run {}: {e:#}",
                run.id
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
    apply_settlement(app, runtime, settlement)
}

fn apply_settlement(
    app: &AppHandle,
    runtime: &mut Runtime,
    settlement: TerminalExitSettlement,
) -> anyhow::Result<()> {
    // A false return means a hook settled the run first (SessionEnd, StopFailure); nothing to
    // announce then — the hook's own path already moved the board.
    if runtime
        .repositories
        .settle_task_run_if_live(&settlement.task_run_id, &settlement.task_id)?
    {
        let _ = TaskRunStatusChanged {
            task_id: settlement.task_id,
            task_run_id: settlement.task_run_id,
            status: TaskRunStatus::Stopped.into(),
        }
        .emit(app);
    }
    Ok(())
}
