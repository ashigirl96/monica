use std::path::Path;

use serde::Serialize;

#[derive(Serialize, specta::Type)]
pub struct WorktreeInfo {
    pub repo: String,
    pub branch: String,
}

#[tauri::command]
#[specta::specta]
pub fn worktree_info(cwd: String) -> Result<Option<WorktreeInfo>, String> {
    Ok(
        monica_infra::git::worktree_info(Path::new(&cwd)).map(|info| WorktreeInfo {
            repo: info.repo,
            branch: info.branch,
        }),
    )
}
