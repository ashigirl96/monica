use crate::prelude::{TaskRun, TaskRunStatus, TerminalSession};

/// A task run that should be settled as Stopped because its terminal died without the hooks
/// (SessionEnd) getting a chance to report it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalExitSettlement {
    pub task_id: String,
    pub task_run_id: String,
}

/// Decide whether a terminated terminal session takes its task run down with it.
///
/// Pure on purpose (like `reconcile_terminal_sessions`): the app fetches the session row, the
/// tab's latest session, and the tab's latest observed run, then applies the verdict through a
/// status-guarded UPDATE.
///
/// The exited session must still be the tab's latest one: a tab respawn always inserts a new
/// session row, so a stale Exit arriving after the tab was reused must not touch the new run.
pub fn task_run_settlement_for_terminal_exit(
    exited: &TerminalSession,
    latest_session_in_tab: Option<&TerminalSession>,
    run_in_tab: Option<&TaskRun>,
) -> Option<TerminalExitSettlement> {
    exited.tab_id.as_ref()?;
    if latest_session_in_tab.is_none_or(|latest| latest.id != exited.id) {
        return None;
    }
    let run = run_in_tab?;
    if !run_is_session_driven(run) {
        return None;
    }
    Some(TerminalExitSettlement {
        task_id: run.task_id.to_string(),
        task_run_id: run.id.to_string(),
    })
}

/// Decide whether a live run was orphaned: the latest session of the tab it is pinned to is
/// dead, so no shell exists to deliver further hooks or a later Exit broadcast for it.
///
/// This is the run-first complement to `task_run_settlement_for_terminal_exit` (which is
/// session-first and fires per death event). The sweep catches everything the event path can
/// miss: a crash between recording the exit and settling, sessions already terminal before an
/// upgrade, and older runs shadowed by a newer run observed in the same tab.
pub fn task_run_settlement_for_orphaned_run(
    run: &TaskRun,
    latest_session_in_tab: Option<&TerminalSession>,
) -> Option<TerminalExitSettlement> {
    run.terminal_tab_id.as_ref()?;
    // A tab with no session rows proves nothing about the run; only a recorded death does.
    let latest = latest_session_in_tab?;
    if !latest.status.is_terminal() {
        return None;
    }
    if !run_is_session_driven(run) {
        return None;
    }
    Some(TerminalExitSettlement {
        task_id: run.task_id.to_string(),
        task_run_id: run.id.to_string(),
    })
}

/// Only a run a session was actually driving is settled: Running, WaitingForUser, or a
/// SettingUp run that already carries a Claude session. A Prepared run survives its terminal —
/// the worktree is intact and Run stays available.
fn run_is_session_driven(run: &TaskRun) -> bool {
    match run.status {
        TaskRunStatus::Running | TaskRunStatus::WaitingForUser => true,
        TaskRunStatus::SettingUp => run.provider_session_id.is_some(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prelude::{TaskId, TaskRunId, TerminalSessionKind, TerminalSessionStatus};

    fn session(id: &str, tab_id: Option<&str>) -> TerminalSession {
        TerminalSession {
            id: id.to_string(),
            runspace_id: None,
            tab_id: tab_id.map(str::to_string),
            kind: TerminalSessionKind::Shell,
            cwd: "/".to_string(),
            shell: "/bin/zsh".to_string(),
            status: TerminalSessionStatus::Exited,
            agent_status: None,
            agent_wait_reason: None,
            pid: None,
            rows: 24,
            cols: 80,
            transcript_path: None,
            exit_code: Some(0),
            started_at: None,
            last_seen_at: None,
            exited_at: None,
            created_at: "2026-06-02T00:00:00.000Z".to_string(),
            updated_at: "2026-06-02T00:00:00.000Z".to_string(),
        }
    }

    fn run(status: TaskRunStatus, provider_session_id: Option<&str>) -> TaskRun {
        TaskRun {
            id: TaskRunId::from_store("run-1".to_string()),
            task_id: TaskId::from_store("MON-1".to_string()),
            agent: None,
            branch: None,
            worktree_path: None,
            status,
            wait_reason: None,
            provider_session_id: provider_session_id.map(str::to_string),
            terminal_tab_id: Some("tab-1".to_string()),
            last_event_name: None,
            last_event_at: None,
            plan_file_path: None,
            pending_stop: false,
            metadata: monica_domain::RawJson::empty_object(),
            created_at: "2026-06-02T00:00:00.000Z".to_string(),
            updated_at: "2026-06-02T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn settlement_requires_tab_latest_session_and_live_run() {
        let exited = session("ts-1", Some("tab-1"));
        let latest = exited.clone();

        let cases = [
            (TaskRunStatus::Running, None, true),
            (TaskRunStatus::WaitingForUser, None, true),
            (TaskRunStatus::SettingUp, Some("sess-1"), true),
            // A prepare-flow SettingUp run was never driven by a session.
            (TaskRunStatus::SettingUp, None, false),
            (TaskRunStatus::Prepared, Some("sess-1"), false),
            (TaskRunStatus::Stopped, Some("sess-1"), false),
            (TaskRunStatus::Failed, Some("sess-1"), false),
        ];
        for (status, session_id, settles) in cases {
            let run = run(status, session_id);
            let settlement =
                task_run_settlement_for_terminal_exit(&exited, Some(&latest), Some(&run));
            assert_eq!(settlement.is_some(), settles, "{status:?}");
            if let Some(settlement) = settlement {
                assert_eq!(settlement.task_run_id, "run-1");
                assert_eq!(settlement.task_id, "MON-1");
            }
        }
    }

    #[test]
    fn settlement_skips_sessions_without_a_tab() {
        let exited = session("ts-1", None);
        let run = run(TaskRunStatus::Running, Some("sess-1"));
        assert_eq!(
            task_run_settlement_for_terminal_exit(&exited, Some(&exited.clone()), Some(&run)),
            None
        );
    }

    #[test]
    fn settlement_skips_stale_exits_after_tab_was_respawned() {
        let exited = session("ts-1", Some("tab-1"));
        let newer = session("ts-2", Some("tab-1"));
        let run = run(TaskRunStatus::Running, Some("sess-1"));
        assert_eq!(
            task_run_settlement_for_terminal_exit(&exited, Some(&newer), Some(&run)),
            None
        );
        assert_eq!(
            task_run_settlement_for_terminal_exit(&exited, None, Some(&run)),
            None
        );
    }

    #[test]
    fn settlement_skips_tabs_without_a_run() {
        let exited = session("ts-1", Some("tab-1"));
        assert_eq!(
            task_run_settlement_for_terminal_exit(&exited, Some(&exited.clone()), None),
            None
        );
    }

    #[test]
    fn orphan_settlement_requires_dead_latest_session_and_driven_run() {
        let driven = run(TaskRunStatus::Running, Some("sess-1"));
        let dead = session("ts-1", Some("tab-1"));
        let mut alive = session("ts-2", Some("tab-1"));
        alive.status = TerminalSessionStatus::Running;

        assert_eq!(
            task_run_settlement_for_orphaned_run(&driven, Some(&dead)),
            Some(TerminalExitSettlement {
                task_id: "MON-1".to_string(),
                task_run_id: "run-1".to_string(),
            })
        );
        // A live (or unrecorded) latest session means the tab can still report; hands off.
        assert_eq!(task_run_settlement_for_orphaned_run(&driven, Some(&alive)), None);
        assert_eq!(task_run_settlement_for_orphaned_run(&driven, None), None);

        for status in [
            TaskRunStatus::Prepared,
            TaskRunStatus::Stopped,
            TaskRunStatus::Failed,
        ] {
            let settled = run(status, Some("sess-1"));
            assert_eq!(
                task_run_settlement_for_orphaned_run(&settled, Some(&dead)),
                None,
                "{status:?}"
            );
        }

        let mut tabless = run(TaskRunStatus::Running, Some("sess-1"));
        tabless.terminal_tab_id = None;
        assert_eq!(task_run_settlement_for_orphaned_run(&tabless, Some(&dead)), None);
    }
}
