use std::path::Path;

use monica_api::ApiError;
use serde::Serialize;

use crate::event_sink;

#[derive(Serialize, specta::Type)]
pub struct WorktreeInfo {
    pub repo: String,
    pub branch: String,
}

#[tauri::command]
#[specta::specta]
pub async fn worktree_info(cwd: String) -> Result<Option<WorktreeInfo>, ApiError> {
    event_sink::off_main(move || {
        Ok(monica_runtime::worktree_info(Path::new(&cwd))
            .map(|info| WorktreeInfo { repo: info.repo, branch: info.branch }))
    })
    .await
}
