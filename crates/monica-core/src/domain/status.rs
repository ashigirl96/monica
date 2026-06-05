use std::str::FromStr;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Inbox,
    Ready,
    InProgress,
    Done,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Inbox => "inbox",
            TaskStatus::Ready => "ready",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Done => "done",
        }
    }

    /// Parse a status the way a CLI user types it: dashes are accepted in place of the stored
    /// snake_case underscores, so `in-progress` resolves to [`TaskStatus::InProgress`]. Kept in
    /// core so the CLI and any future GUI share one acceptance rule.
    pub fn parse_token(s: &str) -> Result<Self> {
        s.replace('-', "_").parse()
    }
}

impl FromStr for TaskStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "inbox" => TaskStatus::Inbox,
            "ready" => TaskStatus::Ready,
            "in_progress" => TaskStatus::InProgress,
            "done" => TaskStatus::Done,
            other => return Err(anyhow!("unknown task status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    SettingUp,
    Running,
    WaitingForUser,
    Stopped,
    Failed,
}

impl TaskRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskRunStatus::SettingUp => "setting_up",
            TaskRunStatus::Running => "running",
            TaskRunStatus::WaitingForUser => "waiting_for_user",
            TaskRunStatus::Stopped => "stopped",
            TaskRunStatus::Failed => "failed",
        }
    }
}

impl FromStr for TaskRunStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "setting_up" => TaskRunStatus::SettingUp,
            "running" => TaskRunStatus::Running,
            "waiting_for_user" => TaskRunStatus::WaitingForUser,
            "stopped" => TaskRunStatus::Stopped,
            "failed" => TaskRunStatus::Failed,
            other => return Err(anyhow!("unknown task run status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunWaitReason {
    AskUserQuestion,
    ExitPlanMode,
}

impl TaskRunWaitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskRunWaitReason::AskUserQuestion => "ask_user_question",
            TaskRunWaitReason::ExitPlanMode => "exit_plan_mode",
        }
    }
}

impl FromStr for TaskRunWaitReason {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "ask_user_question" => TaskRunWaitReason::AskUserQuestion,
            "exit_plan_mode" => TaskRunWaitReason::ExitPlanMode,
            other => return Err(anyhow!("unknown task run wait reason: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayStatus {
    Inbox,
    Ready,
    InProgress,
    SettingUp,
    Running,
    WaitingForUser,
    Stopped,
    Failed,
    Done,
}

impl DisplayStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DisplayStatus::Inbox => "inbox",
            DisplayStatus::Ready => "ready",
            DisplayStatus::InProgress => "in_progress",
            DisplayStatus::SettingUp => "setting_up",
            DisplayStatus::Running => "running",
            DisplayStatus::WaitingForUser => "waiting_for_user",
            DisplayStatus::Stopped => "stopped",
            DisplayStatus::Failed => "failed",
            DisplayStatus::Done => "done",
        }
    }

    pub fn parse_token(s: &str) -> Result<Self> {
        s.replace('-', "_").parse()
    }

    pub fn from_task_and_run(task: TaskStatus, run: Option<TaskRunStatus>) -> Self {
        match task {
            TaskStatus::Inbox => DisplayStatus::Inbox,
            TaskStatus::Ready => DisplayStatus::Ready,
            TaskStatus::InProgress => match run {
                Some(TaskRunStatus::SettingUp) => DisplayStatus::SettingUp,
                Some(TaskRunStatus::Running) => DisplayStatus::Running,
                Some(TaskRunStatus::WaitingForUser) => DisplayStatus::WaitingForUser,
                Some(TaskRunStatus::Stopped) => DisplayStatus::Stopped,
                Some(TaskRunStatus::Failed) => DisplayStatus::Failed,
                None => DisplayStatus::InProgress,
            },
            TaskStatus::Done => DisplayStatus::Done,
        }
    }
}

impl FromStr for DisplayStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "inbox" => DisplayStatus::Inbox,
            "ready" => DisplayStatus::Ready,
            "in_progress" => DisplayStatus::InProgress,
            "setting_up" => DisplayStatus::SettingUp,
            "running" => DisplayStatus::Running,
            "waiting_for_user" => DisplayStatus::WaitingForUser,
            "stopped" => DisplayStatus::Stopped,
            "failed" => DisplayStatus::Failed,
            "done" => DisplayStatus::Done,
            other => return Err(anyhow!("unknown display status: {other}")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_display_status_keeps_done_at_product_level() {
        assert_eq!(
            DisplayStatus::from_task_and_run(TaskStatus::Done, Some(TaskRunStatus::Running)),
            DisplayStatus::Done
        );
    }
}
