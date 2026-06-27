use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Ready,
    InProgress,
    Closed,
}

impl From<monica_domain::TaskStatus> for TaskStatus {
    fn from(value: monica_domain::TaskStatus) -> Self {
        match value {
            monica_domain::TaskStatus::Ready => Self::Ready,
            monica_domain::TaskStatus::InProgress => Self::InProgress,
            monica_domain::TaskStatus::Closed => Self::Closed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    SettingUp,
    Prepared,
    Running,
    WaitingForUser,
    Stopped,
    Failed,
}

impl From<monica_domain::TaskRunStatus> for TaskRunStatus {
    fn from(value: monica_domain::TaskRunStatus) -> Self {
        match value {
            monica_domain::TaskRunStatus::SettingUp => Self::SettingUp,
            monica_domain::TaskRunStatus::Prepared => Self::Prepared,
            monica_domain::TaskRunStatus::Running => Self::Running,
            monica_domain::TaskRunStatus::WaitingForUser => Self::WaitingForUser,
            monica_domain::TaskRunStatus::Stopped => Self::Stopped,
            monica_domain::TaskRunStatus::Failed => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunWaitReason {
    AskUserQuestion,
    ExitPlanMode,
    PermissionRequest,
    AwaitingPrompt,
}

impl From<monica_domain::TaskRunWaitReason> for TaskRunWaitReason {
    fn from(value: monica_domain::TaskRunWaitReason) -> Self {
        match value {
            monica_domain::TaskRunWaitReason::AskUserQuestion => Self::AskUserQuestion,
            monica_domain::TaskRunWaitReason::ExitPlanMode => Self::ExitPlanMode,
            monica_domain::TaskRunWaitReason::PermissionRequest => Self::PermissionRequest,
            monica_domain::TaskRunWaitReason::AwaitingPrompt => Self::AwaitingPrompt,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
    Closed,
}

impl From<monica_domain::DisplayStatus> for DisplayStatus {
    fn from(value: monica_domain::DisplayStatus) -> Self {
        match value {
            monica_domain::DisplayStatus::Ready => Self::Ready,
            monica_domain::DisplayStatus::InProgress => Self::InProgress,
            monica_domain::DisplayStatus::SettingUp => Self::SettingUp,
            monica_domain::DisplayStatus::Prepared => Self::Prepared,
            monica_domain::DisplayStatus::Running => Self::Running,
            monica_domain::DisplayStatus::WaitingForUser => Self::WaitingForUser,
            monica_domain::DisplayStatus::Stopped => Self::Stopped,
            monica_domain::DisplayStatus::Failed => Self::Failed,
            monica_domain::DisplayStatus::Closed => Self::Closed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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

    #[test]
    fn display_status_mirror_matches_domain_serde() {
        for (domain, api) in [
            (monica_domain::DisplayStatus::Ready, DisplayStatus::Ready),
            (monica_domain::DisplayStatus::InProgress, DisplayStatus::InProgress),
            (monica_domain::DisplayStatus::SettingUp, DisplayStatus::SettingUp),
            (monica_domain::DisplayStatus::Prepared, DisplayStatus::Prepared),
            (monica_domain::DisplayStatus::Running, DisplayStatus::Running),
            (monica_domain::DisplayStatus::WaitingForUser, DisplayStatus::WaitingForUser),
            (monica_domain::DisplayStatus::Stopped, DisplayStatus::Stopped),
            (monica_domain::DisplayStatus::Failed, DisplayStatus::Failed),
            (monica_domain::DisplayStatus::Closed, DisplayStatus::Closed),
        ] {
            assert_eq!(DisplayStatus::from(domain), api);
            assert_eq!(
                serde_json::to_string(&domain).unwrap(),
                serde_json::to_string(&api).unwrap(),
            );
        }
    }
}
