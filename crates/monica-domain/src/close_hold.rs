use crate::ids::TaskId;
use crate::terminal_session::TerminalSession;

/// What has to end before a held tab may go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, strum::IntoStaticStr, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
pub enum CloseHoldRelease {
    AgentExit,
    ShellExit,
}

impl CloseHoldRelease {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// The tab a task was closed from. Its runspace is torn down with the task, but this tab outlives
/// the close: killing it would SIGHUP the very agent that asked for the close.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseHold {
    pub task_id: TaskId,
    pub terminal_tab_id: String,
    pub terminal_session_id: String,
    pub release: CloseHoldRelease,
}

impl CloseHold {
    /// Holds for whatever runs in `session` at close time: the agent when one has reported, the
    /// shell otherwise.
    pub fn for_session(task_id: TaskId, terminal_tab_id: String, session: &TerminalSession) -> Self {
        let release = if session.agent_status.is_some() {
            CloseHoldRelease::AgentExit
        } else {
            CloseHoldRelease::ShellExit
        };
        Self {
            task_id,
            terminal_tab_id,
            terminal_session_id: session.id.clone(),
            release,
        }
    }

    /// `session` is the held session's current row; `None` means it is gone.
    pub fn is_released(&self, session: Option<&TerminalSession>) -> bool {
        let Some(session) = session else { return true };
        if session.status.is_terminal() {
            return true;
        }
        match self.release {
            CloseHoldRelease::AgentExit => session.agent_status.is_none(),
            CloseHoldRelease::ShellExit => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_session::{AgentSessionStatus, TerminalSessionKind, TerminalSessionStatus};

    fn session(status: TerminalSessionStatus, agent: Option<AgentSessionStatus>) -> TerminalSession {
        TerminalSession {
            id: "ts-1".to_string(),
            runspace_id: None,
            tab_id: Some("tab-1".to_string()),
            kind: TerminalSessionKind::Shell,
            cwd: "/".to_string(),
            shell: "zsh".to_string(),
            status,
            agent_status: agent,
            agent_wait_reason: None,
            agent_session_id: None,
            pid: None,
            rows: 24,
            cols: 80,
            transcript_path: None,
            exit_code: None,
            started_at: None,
            last_seen_at: None,
            exited_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn hold(release: CloseHoldRelease) -> CloseHold {
        CloseHold {
            task_id: TaskId::from_store("MON-1".to_string()),
            terminal_tab_id: "tab-1".to_string(),
            terminal_session_id: "ts-1".to_string(),
            release,
        }
    }

    #[test]
    fn a_session_with_a_reporting_agent_is_held_until_the_agent_exits() {
        let running = session(TerminalSessionStatus::Running, Some(AgentSessionStatus::Running));
        let held = CloseHold::for_session(
            TaskId::from_store("MON-1".to_string()),
            "tab-1".to_string(),
            &running,
        );
        assert_eq!(held.release, CloseHoldRelease::AgentExit);
    }

    #[test]
    fn a_session_without_an_agent_is_held_until_the_shell_exits() {
        let shell = session(TerminalSessionStatus::Running, None);
        let held =
            CloseHold::for_session(TaskId::from_store("MON-1".to_string()), "tab-1".to_string(), &shell);
        assert_eq!(held.release, CloseHoldRelease::ShellExit);
        assert_eq!(held.terminal_session_id, "ts-1");
    }

    #[test]
    fn an_agent_hold_releases_once_the_agent_reports_its_end() {
        let hold = hold(CloseHoldRelease::AgentExit);
        let waiting = session(TerminalSessionStatus::Running, Some(AgentSessionStatus::WaitingForUser));
        assert!(!hold.is_released(Some(&waiting)));
        assert!(hold.is_released(Some(&session(TerminalSessionStatus::Running, None))));
    }

    #[test]
    fn a_shell_hold_outlasts_a_cleared_agent_and_releases_on_exit() {
        let hold = hold(CloseHoldRelease::ShellExit);
        assert!(!hold.is_released(Some(&session(TerminalSessionStatus::Detached, None))));
        assert!(hold.is_released(Some(&session(TerminalSessionStatus::Exited, None))));
    }

    #[test]
    fn a_hold_whose_session_is_gone_or_dead_is_released() {
        let hold = hold(CloseHoldRelease::AgentExit);
        assert!(hold.is_released(None));
        let lost = session(TerminalSessionStatus::Lost, Some(AgentSessionStatus::Running));
        assert!(hold.is_released(Some(&lost)));
    }
}
