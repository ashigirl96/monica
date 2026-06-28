use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    AwaitingUserInput,
}

impl NotificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingUserInput => "awaiting_user_input",
        }
    }
}

impl fmt::Display for NotificationKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for NotificationKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "awaiting_user_input" => Ok(Self::AwaitingUserInput),
            other => Err(format!("unknown notification kind: {other}")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct NotificationIntent {
    pub id: i64,
    pub dedupe_key: String,
    pub kind: NotificationKind,
    pub title: String,
    pub body: String,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
    pub created_at: String,
    pub delivered_at: Option<String>,
    pub error: Option<String>,
    pub attempts: i64,
}

pub struct NewNotificationIntent {
    pub dedupe_key: String,
    pub kind: NotificationKind,
    pub title: String,
    pub body: String,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
}
