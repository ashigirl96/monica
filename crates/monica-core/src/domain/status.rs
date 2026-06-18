use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum TaskStatus {
    Ready,
    InProgress,
    Closed,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        self.into()
    }

    /// Parse a status the way a CLI user types it: dashes are accepted in place of the stored
    /// snake_case underscores, so `in-progress` resolves to [`TaskStatus::InProgress`]. Kept in
    /// core so the CLI and any future GUI share one acceptance rule.
    pub fn parse_token(s: &str) -> Result<Self> {
        Ok(s.replace('-', "_").parse()?)
    }
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
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
        self.into()
    }

    /// The run is settled: only an explicit revival (a fresh session, a new prompt) may move
    /// it again. Lifecycle protection treats a transition INTO these as a session's verdict.
    pub fn is_terminal(self) -> bool {
        matches!(self, TaskRunStatus::Stopped | TaskRunStatus::Failed)
    }
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum TaskRunWaitReason {
    AskUserQuestion,
    ExitPlanMode,
    AwaitingPrompt,
}

impl TaskRunWaitReason {
    pub fn as_str(self) -> &'static str {
        self.into()
    }

    /// Tool-specific waits (a pending question or plan approval) outrank the generic
    /// "type a prompt" wait: protection rules and the side-run attention count both key off
    /// this set — the stores build their SQL IN-lists from it, so a new variant lands there too.
    pub const TOOL_WAITS: [TaskRunWaitReason; 2] = [
        TaskRunWaitReason::AskUserQuestion,
        TaskRunWaitReason::ExitPlanMode,
    ];

    pub fn is_tool_wait(self) -> bool {
        Self::TOOL_WAITS.contains(&self)
    }
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum DisplayStatus {
    Ready,
    InProgress,
    SettingUp,
    Prepared,
    Running,
    WaitingForUser,
    Stopped,
    Failed,
    Closed,
}

impl DisplayStatus {
    pub fn as_str(self) -> &'static str {
        self.into()
    }

    pub fn parse_token(s: &str) -> Result<Self> {
        Ok(s.replace('-', "_").parse()?)
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
            TaskStatus::Closed => DisplayStatus::Closed,
        }
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
/// Running, and a turn's end brings it back. Closed tasks are archived off the board entirely —
/// `monica issue status --status closed` still reaches them.
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
    fn task_display_status_keeps_closed_at_product_level() {
        assert_eq!(
            DisplayStatus::from_task_and_run(TaskStatus::Closed, Some(TaskRunStatus::Running)),
            DisplayStatus::Closed
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
            (DisplayStatus::Closed, false, false, false),
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
            // Closed is the archive: deliberately absent from the board.
            (DisplayStatus::Closed, None),
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
