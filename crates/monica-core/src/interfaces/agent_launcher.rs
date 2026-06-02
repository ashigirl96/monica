use anyhow::Result;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLaunch {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentLaunchMode {
    New,
    Continue,
    Fork { session_id: String },
}

impl AgentLaunchMode {
    pub fn is_reconnect(&self) -> bool {
        !matches!(self, AgentLaunchMode::New)
    }
}

pub trait AgentLauncher {
    fn launch(&self, launch: &AgentLaunch) -> Result<()>;
}
