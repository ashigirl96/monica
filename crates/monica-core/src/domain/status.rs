use std::str::FromStr;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Ready,
    InProgress,
    Done,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
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
            "ready" => TaskStatus::Ready,
            "in_progress" => TaskStatus::InProgress,
            "done" => TaskStatus::Done,
            other => return Err(anyhow!("unknown task status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    SettingUp,
    Prepared,
    Running,
    WaitingForUser,
    Stopped,
    Failed,
}

impl TaskRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskRunStatus::SettingUp => "setting_up",
            TaskRunStatus::Prepared => "prepared",
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
            "prepared" => TaskRunStatus::Prepared,
            "running" => TaskRunStatus::Running,
            "waiting_for_user" => TaskRunStatus::WaitingForUser,
            "stopped" => TaskRunStatus::Stopped,
            "failed" => TaskRunStatus::Failed,
            other => return Err(anyhow!("unknown task run status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TaskRunWaitReason {
    AskUserQuestion,
    ExitPlanMode,
    AwaitingPrompt,
}

impl TaskRunWaitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskRunWaitReason::AskUserQuestion => "ask_user_question",
            TaskRunWaitReason::ExitPlanMode => "exit_plan_mode",
            TaskRunWaitReason::AwaitingPrompt => "awaiting_prompt",
        }
    }

    /// Tool-specific waits (a pending question or plan approval) outrank the generic
    /// "type a prompt" wait: protection rules and the side-run attention count both key off this.
    pub fn is_tool_wait(self) -> bool {
        matches!(
            self,
            TaskRunWaitReason::AskUserQuestion | TaskRunWaitReason::ExitPlanMode
        )
    }
}

impl FromStr for TaskRunWaitReason {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "ask_user_question" => TaskRunWaitReason::AskUserQuestion,
            "exit_plan_mode" => TaskRunWaitReason::ExitPlanMode,
            "awaiting_prompt" => TaskRunWaitReason::AwaitingPrompt,
            other => return Err(anyhow!("unknown task run wait reason: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum DisplayStatus {
    Ready,
    InProgress,
    SettingUp,
    Prepared,
    Running,
    WaitingForUser,
    Stopped,
    Failed,
    Done,
}

impl DisplayStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DisplayStatus::Ready => "ready",
            DisplayStatus::InProgress => "in_progress",
            DisplayStatus::SettingUp => "setting_up",
            DisplayStatus::Prepared => "prepared",
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

    /// A new run may be prepared from these states: nothing is live and nothing is already
    /// waiting to launch.
    pub fn prepare_eligible(self) -> bool {
        matches!(
            self,
            DisplayStatus::Ready | DisplayStatus::Stopped | DisplayStatus::Failed
        )
    }

    /// Run accepts everything prepare does, plus an already-prepared run waiting for launch.
    pub fn run_eligible(self) -> bool {
        self.prepare_eligible() || self == DisplayStatus::Prepared
    }

    /// Something is actively engaged with the task right now — machine prep, a launch waiting
    /// to be driven, or the agent itself. The board highlights these cards.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            DisplayStatus::SettingUp | DisplayStatus::Prepared | DisplayStatus::Running
        )
    }

    pub fn from_task_and_run(task: TaskStatus, run: Option<TaskRunStatus>) -> Self {
        match task {
            TaskStatus::Ready => DisplayStatus::Ready,
            TaskStatus::InProgress => match run {
                Some(TaskRunStatus::SettingUp) => DisplayStatus::SettingUp,
                Some(TaskRunStatus::Prepared) => DisplayStatus::Prepared,
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
            "ready" => DisplayStatus::Ready,
            "in_progress" => DisplayStatus::InProgress,
            "setting_up" => DisplayStatus::SettingUp,
            "prepared" => DisplayStatus::Prepared,
            "running" => DisplayStatus::Running,
            "waiting_for_user" => DisplayStatus::WaitingForUser,
            "stopped" => DisplayStatus::Stopped,
            "failed" => DisplayStatus::Failed,
            "done" => DisplayStatus::Done,
            other => return Err(anyhow!("unknown display status: {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct BoardColumn {
    pub key: String,
    pub label: String,
    pub statuses: Vec<DisplayStatus>,
}

/// Columns are ordered so a card only moves when the ball changes hands, and the user's own
/// action pushes it rightward: Prepare keeps it in Ready (setting_up is machine work, nobody's
/// turn), the moment it needs the user it enters Needs You, handing it to the agent moves it to
/// Running, and a turn's end brings it back. Done tasks are archived off the board entirely —
/// `monica issue list --status done` still reaches them.
pub fn board_columns() -> Vec<BoardColumn> {
    vec![
        BoardColumn {
            key: "ready".into(),
            label: "Ready".into(),
            statuses: vec![DisplayStatus::Ready, DisplayStatus::SettingUp],
        },
        BoardColumn {
            key: "needs-you".into(),
            label: "Needs You".into(),
            statuses: vec![DisplayStatus::Prepared, DisplayStatus::WaitingForUser],
        },
        BoardColumn {
            key: "running".into(),
            label: "Running".into(),
            statuses: vec![DisplayStatus::InProgress, DisplayStatus::Running],
        },
        BoardColumn {
            key: "interrupted".into(),
            label: "Interrupted".into(),
            statuses: vec![DisplayStatus::Stopped, DisplayStatus::Failed],
        },
    ]
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

    #[test]
    fn eligibility_follows_display_status() {
        let cases = [
            (DisplayStatus::Ready, true, true, false),
            (DisplayStatus::InProgress, false, false, false),
            (DisplayStatus::SettingUp, false, false, true),
            (DisplayStatus::Prepared, false, true, true),
            (DisplayStatus::Running, false, false, true),
            (DisplayStatus::WaitingForUser, false, false, false),
            (DisplayStatus::Stopped, true, true, false),
            (DisplayStatus::Failed, true, true, false),
            (DisplayStatus::Done, false, false, false),
        ];
        for (status, prepare, run, active) in cases {
            assert_eq!(status.prepare_eligible(), prepare, "{status:?} prepare");
            assert_eq!(status.run_eligible(), run, "{status:?} run");
            assert_eq!(status.is_active(), active, "{status:?} active");
        }
    }

    #[test]
    fn board_columns_cover_every_visible_status_once() {
        let columns = board_columns();
        assert_eq!(
            columns.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(),
            ["ready", "needs-you", "running", "interrupted"]
        );

        let placed: Vec<DisplayStatus> = columns
            .iter()
            .flat_map(|c| c.statuses.iter().copied())
            .collect();
        let expected = [
            (DisplayStatus::Ready, Some("ready")),
            (DisplayStatus::SettingUp, Some("ready")),
            (DisplayStatus::Prepared, Some("needs-you")),
            (DisplayStatus::WaitingForUser, Some("needs-you")),
            (DisplayStatus::InProgress, Some("running")),
            (DisplayStatus::Running, Some("running")),
            (DisplayStatus::Stopped, Some("interrupted")),
            (DisplayStatus::Failed, Some("interrupted")),
            // Done is the archive: deliberately absent from the board.
            (DisplayStatus::Done, None),
        ];
        for (status, column) in expected {
            let found = columns
                .iter()
                .find(|c| c.statuses.contains(&status))
                .map(|c| c.key.as_str());
            assert_eq!(found, column, "{status:?}");
            assert!(
                placed.iter().filter(|s| **s == status).count() <= 1,
                "{status:?} appears in more than one column"
            );
        }
    }
}
