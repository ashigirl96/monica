//! The orphan-asset GC worker. Same shape as [`crate::pr_sync`]: a `std::thread` whose
//! `recv_timeout` doubles as the interval, building a fresh `!Send` façade each cycle. The
//! reachability + sweep logic lives in `monica-adapters`; this only orchestrates.

use std::sync::mpsc;
use std::time::Duration;

use monica_adapters::assets::gc::{referenced_asset_ids, sweep_orphan_assets};

use crate::MonicaFacade;

// 起動直後は走らせず、アプリが落ち着いてから最初の掃除をする。
const INITIAL_DELAY: Duration = Duration::from_secs(10 * 60);
const GC_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
// 作成から 48h 未満の未参照 asset は消さない（paste→autosave の隙間と当日 undo を保護）。
const GC_GRACE: Duration = Duration::from_secs(48 * 60 * 60);

/// Dropping this ends the worker thread (its `recv_timeout` sees `Disconnected`). The desktop keeps
/// it in Tauri state so it lives for the app's lifetime.
pub struct AssetGcHandle(#[allow(dead_code)] mpsc::SyncSender<()>);

/// Spawn the asset-GC worker. `make_facade` builds a fresh façade on the worker thread each cycle.
pub fn start_asset_gc<F>(make_facade: F) -> AssetGcHandle
where
    F: Fn() -> anyhow::Result<MonicaFacade> + Send + 'static,
{
    let (tx, rx) = mpsc::sync_channel::<()>(0);
    let spawn_result = std::thread::Builder::new()
        .name("monica-asset-gc".to_string())
        .spawn(move || {
            // Disconnected（handle drop）はパターンに一致せずループ終了。timeout=定期実行。
            let mut wait = INITIAL_DELAY;
            while let Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(wait) {
                run_gc(&make_facade);
                wait = GC_INTERVAL;
            }
        });
    if let Err(e) = spawn_result {
        log::error!(target: "monica_runtime::asset_gc", "failed to start asset GC scheduler: {e}");
    }
    AssetGcHandle(tx)
}

fn run_gc<F>(make_facade: &F)
where
    F: Fn() -> anyhow::Result<MonicaFacade>,
{
    let mut monica = match make_facade() {
        Ok(monica) => monica,
        Err(e) => {
            log::error!(target: "monica_runtime::asset_gc", "failed to open façade for asset GC: {e:#}");
            return;
        }
    };
    let contents = match monica.notes().list_all_note_contents() {
        Ok(contents) => contents,
        Err(e) => {
            log::error!(target: "monica_runtime::asset_gc", "failed to list note contents: {e:#}");
            return;
        }
    };
    let referenced = referenced_asset_ids(&contents);
    match sweep_orphan_assets(&referenced, GC_GRACE) {
        Ok(deleted) if !deleted.is_empty() => {
            log::info!(target: "monica_runtime::asset_gc", "removed {} orphan asset(s)", deleted.len());
        }
        Ok(_) => {}
        Err(e) => log::error!(target: "monica_runtime::asset_gc", "asset GC sweep failed: {e:#}"),
    }
}
