use std::path::Path;

use monica_api::ApiError;
use serde::Serialize;

#[derive(Serialize, specta::Type)]
pub struct WorktreeInfo {
    pub repo: String,
    pub branch: String,
}

#[tauri::command]
#[specta::specta]
pub fn worktree_info(cwd: String) -> Result<Option<WorktreeInfo>, ApiError> {
    Ok(
        monica_infra::git::worktree_info(Path::new(&cwd)).map(|info| WorktreeInfo {
            repo: info.repo,
            branch: info.branch,
        }),
    )
}
