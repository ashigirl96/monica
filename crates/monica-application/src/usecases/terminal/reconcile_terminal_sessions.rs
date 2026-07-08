//! Reconcile durable session rows against the daemon's live view on startup (and on every
//! list poll). Pure: callers fetch both sides, apply the returned updates in one
//! transaction, then send `Reap` for the listed ids.

use crate::prelude::{TerminalSession, TerminalSessionStatus};

/// What the daemon reports for one session. Deliberately a local DTO so core does not
/// depend on the daemon protocol types.
#[derive(Debug, Clone)]
pub struct DaemonSessionView {
    pub session_id: String,
    pub pid: Option<u32>,
    pub running: bool,
    /// Whether any client connection is attached (receiving output) right now.
    pub attached: bool,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSessionUpdate {
    pub session_id: String,
    pub status: TerminalSessionStatus,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileOutcome {
    pub updates: Vec<TerminalSessionUpdate>,
    /// Exited tombstones the daemon still holds; reap them once the DB reflects the exit.
    pub reap_ids: Vec<String>,
}

pub fn reconcile_terminal_sessions(
    db_rows: &[TerminalSession],
    daemon: &[DaemonSessionView],
) -> ReconcileOutcome {
    let mut outcome = ReconcileOutcome::default();

    for row in db_rows {
        let view = daemon.iter().find(|v| v.session_id == row.id);
        if row.status.is_terminal() {
            // Already settled in the DB; only clean up a leftover tombstone (e.g. a Reap
            // that failed after the exit event was recorded).
            if matches!(view, Some(v) if !v.running) {
                outcome.reap_ids.push(row.id.clone());
            }
            continue;
        }
        match view {
            Some(v) if v.running => {
                // Alive: status follows the daemon's attachment truth — attached means a
                // view is streaming (Running), unattached means Detached (e.g. rows left
                // Running by an app crash). Starting is left to the in-flight create call
                // that owns that transition.
                if row.status == TerminalSessionStatus::Starting {
                    continue;
                }
                let status = if v.attached {
                    TerminalSessionStatus::Running
                } else {
                    TerminalSessionStatus::Detached
                };
                outcome.updates.push(TerminalSessionUpdate {
                    session_id: row.id.clone(),
                    status,
                    pid: v.pid,
                    exit_code: None,
                });
            }
            Some(v) => {
                outcome.updates.push(TerminalSessionUpdate {
                    session_id: row.id.clone(),
                    status: TerminalSessionStatus::Exited,
                    pid: None,
                    exit_code: v.exit_code,
                });
                outcome.reap_ids.push(row.id.clone());
            }
            None => {
                outcome.updates.push(TerminalSessionUpdate {
                    session_id: row.id.clone(),
                    status: TerminalSessionStatus::Lost,
                    pid: None,
                    exit_code: None,
                });
            }
        }
    }

    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prelude::TerminalSessionKind;

    fn session(id: &str, status: TerminalSessionStatus) -> TerminalSession {
        TerminalSession {
            id: id.to_string(),
            runspace_id: None,
            tab_id: None,
            kind: TerminalSessionKind::Shell,
            cwd: "/tmp".into(),
            shell: "/bin/zsh".into(),
            status,
            agent_status: None,
            agent_wait_reason: None,
            pid: None,
            rows: 24,
            cols: 80,
            transcript_path: None,
            exit_code: None,
            started_at: None,
            last_seen_at: None,
            exited_at: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    fn live(id: &str, pid: u32, attached: bool) -> DaemonSessionView {
        DaemonSessionView {
            session_id: id.to_string(),
            pid: Some(pid),
            running: true,
            attached,
            exit_code: None,
        }
    }

    fn tombstone(id: &str, exit_code: i32) -> DaemonSessionView {
        DaemonSessionView {
            session_id: id.to_string(),
            pid: None,
            running: false,
            attached: false,
            exit_code: Some(exit_code),
        }
    }

    #[test]
    fn missing_non_terminal_session_becomes_lost() {
        for status in [
            TerminalSessionStatus::Starting,
            TerminalSessionStatus::Running,
            TerminalSessionStatus::Detached,
        ] {
            let outcome = reconcile_terminal_sessions(&[session("ts-1", status)], &[]);
            assert_eq!(
                outcome.updates,
                vec![TerminalSessionUpdate {
                    session_id: "ts-1".into(),
                    status: TerminalSessionStatus::Lost,
                    pid: None,
                    exit_code: None,
                }]
            );
            assert!(outcome.reap_ids.is_empty());
        }
    }

    #[test]
    fn live_status_follows_daemon_attachment_truth() {
        // Attached: an in-use Running session polled mid-use must stay Running, and a
        // Detached row some other view attached to becomes Running.
        // Unattached: a row left Running by an app crash demotes to Detached.
        for (db_status, attached, expected) in [
            (TerminalSessionStatus::Running, true, TerminalSessionStatus::Running),
            (TerminalSessionStatus::Detached, true, TerminalSessionStatus::Running),
            (TerminalSessionStatus::Running, false, TerminalSessionStatus::Detached),
            (TerminalSessionStatus::Detached, false, TerminalSessionStatus::Detached),
        ] {
            let outcome = reconcile_terminal_sessions(
                &[session("ts-1", db_status)],
                &[live("ts-1", 4242, attached)],
            );
            assert_eq!(
                outcome.updates,
                vec![TerminalSessionUpdate {
                    session_id: "ts-1".into(),
                    status: expected,
                    pid: Some(4242),
                    exit_code: None,
                }],
                "db={db_status:?} attached={attached}"
            );
            assert!(outcome.reap_ids.is_empty());
        }
    }

    #[test]
    fn starting_session_is_left_to_the_create_call_while_live() {
        let outcome = reconcile_terminal_sessions(
            &[session("ts-1", TerminalSessionStatus::Starting)],
            &[live("ts-1", 1, false)],
        );
        assert!(outcome.updates.is_empty());
        assert!(outcome.reap_ids.is_empty());
    }

    #[test]
    fn starting_session_with_tombstone_settles_as_exited() {
        // The process spawned but died before mark_started ran (or the app crashed in
        // between): the daemon saw a real run + exit, so Exited (not Lost) is the truth.
        let outcome = reconcile_terminal_sessions(
            &[session("ts-1", TerminalSessionStatus::Starting)],
            &[tombstone("ts-1", 1)],
        );
        assert_eq!(
            outcome.updates,
            vec![TerminalSessionUpdate {
                session_id: "ts-1".into(),
                status: TerminalSessionStatus::Exited,
                pid: None,
                exit_code: Some(1),
            }]
        );
        assert_eq!(outcome.reap_ids, vec!["ts-1".to_string()]);
    }

    #[test]
    fn tombstone_becomes_exited_and_reaped() {
        let outcome = reconcile_terminal_sessions(
            &[session("ts-1", TerminalSessionStatus::Detached)],
            &[tombstone("ts-1", 130)],
        );
        assert_eq!(
            outcome.updates,
            vec![TerminalSessionUpdate {
                session_id: "ts-1".into(),
                status: TerminalSessionStatus::Exited,
                pid: None,
                exit_code: Some(130),
            }]
        );
        assert_eq!(outcome.reap_ids, vec!["ts-1".to_string()]);
    }

    #[test]
    fn terminal_rows_stay_unchanged() {
        for status in [
            TerminalSessionStatus::Exited,
            TerminalSessionStatus::Lost,
            TerminalSessionStatus::Failed,
        ] {
            let outcome =
                reconcile_terminal_sessions(&[session("ts-1", status)], &[live("ts-1", 1, false)]);
            assert!(outcome.updates.is_empty(), "{status:?} must not change");
            assert!(outcome.reap_ids.is_empty());
        }
    }

    #[test]
    fn settled_row_with_leftover_tombstone_is_reaped_without_update() {
        let outcome = reconcile_terminal_sessions(
            &[session("ts-1", TerminalSessionStatus::Exited)],
            &[tombstone("ts-1", 0)],
        );
        assert!(outcome.updates.is_empty());
        assert_eq!(outcome.reap_ids, vec!["ts-1".to_string()]);
    }

    #[test]
    fn unknown_daemon_sessions_are_ignored() {
        let outcome = reconcile_terminal_sessions(&[], &[live("ts-9", 7, false)]);
        assert_eq!(outcome, ReconcileOutcome::default());
    }
}
