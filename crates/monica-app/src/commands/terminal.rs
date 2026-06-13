use monica_core::{
    reconcile_terminal_sessions, DaemonSessionView, NewTerminalSession, TerminalSession,
    TerminalSessionKind, TerminalSessionStatus,
};
use monica_infra::filesystem::paths;
use monica_infra::sqlite::TerminalStateSnapshot;
use monica_infra::Runtime;
use monica_pty::protocol::{CreateParams, RequestOp, ResponseBody, SessionInfo};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::ptyd::PtydHandle;
use crate::services::run_settlement;

#[derive(Serialize, specta::Type)]
pub struct AttachResult {
    /// Base64 transcript tail to write into xterm before streaming live output.
    pub replay: String,
    pub rows: u16,
    pub cols: u16,
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn terminal_create_session(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    runspace_id: String,
    tab_id: String,
    kind: TerminalSessionKind,
    cwd: String,
    rows: u16,
    cols: u16,
    env: Option<Vec<(String, String)>>,
) -> Result<TerminalSession, String> {
    let shell = default_shell();
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let session = runtime
        .repositories
        .create_terminal_session(NewTerminalSession {
            runspace_id: Some(runspace_id),
            tab_id: Some(tab_id.clone()),
            kind,
            cwd: cwd.clone(),
            shell: shell.clone(),
            rows,
            cols,
        })
        .map_err(|e| e.to_string())?;

    // The hook chain (shell → claude → monica hook claude) inherits these, letting hooks
    // stamp the tab onto the TaskRun for tab-based Make Main; the session id is burned in
    // alongside for future session-scoped lookups.
    let mut env = env.unwrap_or_default();
    env.push(("MONICA_TERMINAL_TAB_ID".to_string(), tab_id));
    env.push((
        "MONICA_TERMINAL_SESSION_ID".to_string(),
        session.id.clone(),
    ));

    let created = state.ensure_connected(&app).and_then(|client| {
        match client.request(RequestOp::Create(CreateParams {
            session_id: session.id.clone(),
            cwd,
            shell: Some(shell),
            rows,
            cols,
            env: Some(env),
        }))? {
            ResponseBody::Created { pid } => Ok(pid),
            other => anyhow::bail!("unexpected create response: {other:?}"),
        }
    });

    match created {
        Ok(pid) => {
            let transcript_path = paths::terminal_sessions_dir()
                .ok()
                .map(|dir| dir.join(format!("{}.log", session.id)));
            runtime
                .repositories
                .mark_terminal_session_started(
                    &session.id,
                    pid,
                    transcript_path.as_deref().and_then(|p| p.to_str()),
                )
                .map_err(|e| e.to_string())?;
        }
        Err(e) => {
            // Settle as failed but still return the session: the frontend needs the id to
            // bind it to the tab and render the failure overlay keyed on it.
            log::warn!(
                target: "monica_app::ptyd",
                "failed to start terminal session {}: {e:#}",
                session.id
            );
            let _ = runtime.repositories.update_terminal_session_status(
                &session.id,
                TerminalSessionStatus::Failed,
                None,
            );
            // The failed spawn is now the tab's latest session, shadowing whichever dead
            // session a run in this tab was waiting on; settle that run now rather than
            // leaving it to the sweep.
            run_settlement::settle_runs_for_terminated_sessions(
                &app,
                &mut runtime,
                std::slice::from_ref(&session.id),
            );
        }
    }

    runtime
        .repositories
        .get_terminal_session(&session.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("terminal session {} vanished", session.id))
}

#[tauri::command]
#[specta::specta]
pub fn terminal_attach(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
    replay_bytes: Option<u32>,
) -> Result<AttachResult, String> {
    let client = state.ensure_connected(&app).map_err(|e| format!("{e:#}"))?;
    let body = client
        .request(RequestOp::Attach {
            session_id: session_id.clone(),
            replay_bytes,
        })
        .map_err(|e| format!("{e:#}"))?;
    let ResponseBody::Attached { replay, rows, cols } = body else {
        return Err(format!("unexpected attach response: {body:?}"));
    };
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    runtime
        .repositories
        .update_terminal_session_status(&session_id, TerminalSessionStatus::Running, None)
        .map_err(|e| e.to_string())?;
    Ok(AttachResult { replay, rows, cols })
}

#[tauri::command]
#[specta::specta]
pub fn terminal_detach(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    // Daemon-side detach is best-effort (it may be down); the durable fact that the view
    // went away is recorded regardless.
    if let Ok(client) = state.ensure_connected(&app) {
        let _ = client.request(RequestOp::Detach {
            session_id: session_id.clone(),
        });
    }
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let session = runtime
        .repositories
        .get_terminal_session(&session_id)
        .map_err(|e| e.to_string())?;
    if session.is_some_and(|s| !s.status.is_terminal()) {
        runtime
            .repositories
            .update_terminal_session_status(&session_id, TerminalSessionStatus::Detached, None)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn terminal_write(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let client = state.ensure_connected(&app).map_err(|e| format!("{e:#}"))?;
    client
        .notify(RequestOp::Write { session_id, data })
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn terminal_resize(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let client = state.ensure_connected(&app).map_err(|e| format!("{e:#}"))?;
    client
        .notify(RequestOp::Resize {
            session_id,
            rows,
            cols,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn terminal_terminate(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    let client = state.ensure_connected(&app).map_err(|e| format!("{e:#}"))?;
    client
        .request(RequestOp::Terminate { session_id })
        .map(|_| ())
        .map_err(|e| format!("{e:#}"))
    // The DB transition to exited rides on the daemon's Exit broadcast.
}

#[tauri::command]
#[specta::specta]
pub fn terminal_list_sessions(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    runspace_id: Option<String>,
) -> Result<Vec<TerminalSession>, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;

    // Reconcile against the daemon when reachable; degrade to plain DB reads otherwise.
    // Surfacing a daemon failure as an error here would feed the frontend's load
    // catch-all, which falls back to an empty layout and persists it — losing the saved
    // workbench. Stale running rows are absorbed by attach-failure → lost instead.
    match daemon_views(&state, &app) {
        Ok((client, views)) => {
            let db_rows = runtime
                .repositories
                .list_terminal_sessions(None)
                .map_err(|e| e.to_string())?;
            let outcome = reconcile_terminal_sessions(&db_rows, &views);
            runtime
                .repositories
                .apply_terminal_session_updates(&outcome.updates)
                .map_err(|e| e.to_string())?;
            // Sessions that died while the app was down only surface here: their Exit
            // broadcast was never delivered. The run-first sweep also re-checks sessions
            // that were already terminal in the DB, so a settlement lost to a crash (or
            // predating this build) is retried instead of sticking forever.
            run_settlement::settle_orphaned_runs(&app, &mut runtime);
            for session_id in outcome.reap_ids {
                let _ = client.notify(RequestOp::Reap { session_id });
            }
        }
        Err(e) => {
            log::warn!(
                target: "monica_app::ptyd",
                "daemon unreachable; listing sessions from DB only: {e:#}"
            );
        }
    }

    runtime
        .repositories
        .list_terminal_sessions(runspace_id.as_deref())
        .map_err(|e| e.to_string())
}

fn daemon_views(
    state: &State<'_, PtydHandle>,
    app: &AppHandle,
) -> anyhow::Result<(std::sync::Arc<monica_pty::client::PtydClient>, Vec<DaemonSessionView>)> {
    let client = state.ensure_connected(app)?;
    let body = client.request(RequestOp::List)?;
    let ResponseBody::Sessions { sessions } = body else {
        anyhow::bail!("unexpected list response: {body:?}");
    };
    let views = sessions
        .into_iter()
        .map(
            |SessionInfo {
                 session_id,
                 running,
                 attached,
                 pid,
                 exit_code,
                 ..
             }| DaemonSessionView {
                session_id,
                pid,
                running,
                attached,
                exit_code,
            },
        )
        .collect();
    Ok((client, views))
}

#[tauri::command]
#[specta::specta]
pub fn terminal_load_state() -> Result<TerminalStateSnapshot, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    runtime
        .repositories
        .load_terminal_state()
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn terminal_save_state(state: TerminalStateSnapshot) -> Result<(), String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    runtime
        .repositories
        .save_terminal_state(&state)
        .map_err(|e| e.to_string())
}
