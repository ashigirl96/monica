//! Terminal Session の作成・一覧・終了は行を持つ Backend が行うので、ここの command は byte を運ぶだけにする。

use anyhow::bail;
use serde::Serialize;
use tania_terminal_protocol::{RequestOp, ResponseBody};
use tauri::{AppHandle, Manager};

use crate::ptyd::PtydHandle;

/// webview は失敗を message の文字列として読む。
type CmdResult<T> = Result<T, String>;

#[derive(Serialize)]
pub struct AttachResult {
    pub replay: String,
    pub rows: u16,
    pub cols: u16,
}

/// ptyd との IPC は socket で block するので、main thread から外す。
async fn off_main<F, T>(f: F) -> CmdResult<T>
where
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(result) => result.map_err(|e| format!("{e:#}")),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn terminal_attach(
    app: AppHandle,
    session_id: String,
    replay_bytes: Option<u32>,
) -> CmdResult<AttachResult> {
    off_main(move || {
        let client = app.state::<PtydHandle>().ensure_connected(&app)?;
        match client.request(RequestOp::Attach {
            session_id,
            replay_bytes,
        })? {
            ResponseBody::Attached { replay, rows, cols } => {
                Ok(AttachResult { replay, rows, cols })
            }
            other => bail!("unexpected attach response: {other:?}"),
        }
    })
    .await
}

#[tauri::command]
pub async fn terminal_write(app: AppHandle, session_id: String, data: String) -> CmdResult<()> {
    off_main(move || {
        let client = app.state::<PtydHandle>().ensure_connected(&app)?;
        client.notify(RequestOp::Write { session_id, data })
    })
    .await
}

#[tauri::command]
pub async fn terminal_resize(
    app: AppHandle,
    session_id: String,
    rows: u16,
    cols: u16,
) -> CmdResult<()> {
    off_main(move || {
        let client = app.state::<PtydHandle>().ensure_connected(&app)?;
        client.notify(RequestOp::Resize {
            session_id,
            rows,
            cols,
        })
    })
    .await
}
