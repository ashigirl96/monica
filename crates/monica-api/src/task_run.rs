use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    Claude,
}

impl From<monica_domain::Agent> for Agent {
    fn from(value: monica_domain::Agent) -> Self {
        match value {
            monica_domain::Agent::Claude => Self::Claude,
        }
    }
}

impl From<Agent> for monica_domain::Agent {
    fn from(value: Agent) -> Self {
        match value {
            Agent::Claude => Self::Claude,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    Worktree,
    InPlace,
}

impl From<monica_domain::RunMode> for RunMode {
    fn from(value: monica_domain::RunMode) -> Self {
        match value {
            monica_domain::RunMode::Worktree => Self::Worktree,
            monica_domain::RunMode::InPlace => Self::InPlace,
        }
    }
}

impl From<RunMode> for monica_domain::RunMode {
    fn from(value: RunMode) -> Self {
        match value {
            RunMode::Worktree => Self::Worktree,
            RunMode::InPlace => Self::InPlace,
        }
    }
}
