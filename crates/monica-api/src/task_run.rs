use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    Claude,
    Codex,
}

impl From<monica_application::Agent> for Agent {
    fn from(value: monica_application::Agent) -> Self {
        match value {
            monica_application::Agent::Claude => Self::Claude,
            monica_application::Agent::Codex => Self::Codex,
        }
    }
}

impl From<Agent> for monica_application::Agent {
    fn from(value: Agent) -> Self {
        match value {
            Agent::Claude => Self::Claude,
            Agent::Codex => Self::Codex,
        }
    }
}
