use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Session lifecycle. See `docs/workflow-contract.md` §4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Ready,
    Running,
    NeedReview,
    NeedIntervention,
    PrOpen,
    Done,
}

/// Maps an issue to its worktree, branch, agent session and PR. See `docs/workflow-contract.md` §6.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionManifest {
    pub id: String,
    pub repo: String,
    pub issue_number: u64,
    pub issue_url: String,
    pub status: Status,
    pub branch: String,
    pub worktree_path: String,
    pub agent: String,
    pub agent_session_id: Option<String>,
    pub pr_number: Option<u64>,
    pub created_at: String,
    pub updated_at: String,
}

impl SessionManifest {
    pub fn id_for(owner: &str, repo: &str, issue: u64) -> String {
        format!("{owner}-{repo}-{issue}")
    }
}

pub fn sessions_dir() -> crate::Result<PathBuf> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set")?;
    Ok(PathBuf::from(home).join(".monica").join("sessions"))
}

pub fn manifest_path(id: &str) -> crate::Result<PathBuf> {
    Ok(sessions_dir()?.join(format!("{id}.json")))
}

pub fn exists(id: &str) -> crate::Result<bool> {
    Ok(manifest_path(id)?.exists())
}

pub fn save(manifest: &SessionManifest) -> crate::Result<PathBuf> {
    let dir = sessions_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", manifest.id));
    std::fs::write(&path, serde_json::to_string_pretty(manifest)?)?;
    Ok(path)
}
