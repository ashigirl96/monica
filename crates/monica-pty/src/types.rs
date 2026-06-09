use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySize {
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnRequest {
    pub id: String,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub command: Option<SpawnCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyOutput {
    pub id: String,
    pub data: String,
}
