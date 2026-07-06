use crate::status::{TaskRunStatus, TaskRunWaitReason};
use crate::task_run::TaskRun;

/// Whether a session-start signal opens a fresh conversation or continues an existing one.
/// `Resume`/`Compact` both carry a prior session forward, so neither may demote a primary that is
/// mid-turn; only `Resume` keeps the *source* session id (the new id appears on the first prompt),
/// so it alone must not rebind the tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Continuation {
    Fresh,
    Resume,
    Compact,
}

/// A provider-agnostic lifecycle signal decoded from a raw agent hook event. Every provider-specific
/// concern — event-name strings, JSON field layout, which events a given agent emits — is resolved by
/// the adapter decoder; the domain state machine and the stores below it only ever see this type.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSignal {
    /// The provider session id the event carried, when present. Needed on *every* signal (not just
    /// session start) so the late/out-of-order protection rules can tell a straggler from the dead
    /// session apart from fresh evidence of life.
    pub session_id: Option<String>,
    /// The opaque provider event name (e.g. `"Stop"`). Persisted as `last_event_name` and surfaced
    /// in debug logs only — the state machine never matches on it.
    pub event_label: Option<String>,
    pub kind: SignalKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SignalKind {
    SessionStarted {
        continuation: Continuation,
    },
    PromptSubmitted,
    UserInputRequired {
        reason: TaskRunWaitReason,
        /// The plan file an `ExitPlanMode` surfaced, if any. Sticky: later signals never clear it.
        plan_file_path: Option<String>,
    },
    UserInputResolved,
    TurnCompleted {
        subagents_running: bool,
    },
    SubagentFinished {
        /// Whether any *other* subagent is still in flight once this one is accounted for (the
        /// finishing subagent excludes itself).
        subagents_running: bool,
    },
    SessionEnded {
        /// Why the session ended, verbatim from the provider (Claude: "clear", "logout",
        /// "prompt_input_exit", ...). Task runs ignore it (a cleared session revives itself
        /// through the SessionStart that follows); Claude session mappings must not
        /// tombstone on "clear" because their `ended` state is irreversible.
        reason: Option<String>,
    },
    /// A provider notification. Only a permission prompt blocks on the user; everything
    /// else (idle reminders) is recorded and ignored. Task runs never act on this — their
    /// shells run with permissions skipped.
    NotificationReceived {
        permission_request: bool,
    },
    /// Recorded for the event log but drives no state transition (recoverable
    /// failures, subagent starts, events an agent emits that we don't act on).
    Inert,
}

impl AgentSignal {
    /// Events that prove a user is actively driving a session in this shell: only these may claim a
    /// prepared run or lazily create one.
    pub fn starts_session(&self) -> bool {
        matches!(
            self.kind,
            SignalKind::SessionStarted { .. } | SignalKind::PromptSubmitted
        )
    }

    pub fn plan_file_path(&self) -> Option<&str> {
        match &self.kind {
            SignalKind::UserInputRequired { plan_file_path, .. } => plan_file_path.as_deref(),
            _ => None,
        }
    }
}

/// A status (+ optional wait reason) a signal asks a run to move to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HookTransition {
    pub status: TaskRunStatus,
    pub wait_reason: Option<TaskRunWaitReason>,
}

/// The generic "session is alive, type a prompt" wait that session-start and turn-complete both
/// produce. Kept distinct from a tool-specific wait so a trailing turn-complete can't blur it.
const AWAITING_PROMPT: HookTransition = HookTransition {
    status: TaskRunStatus::WaitingForUser,
    wait_reason: Some(TaskRunWaitReason::AwaitingPrompt),
};

pub fn transition_is_generic_wait(next: HookTransition) -> bool {
    next == AWAITING_PROMPT
}

fn requested_transition(kind: &SignalKind) -> Option<HookTransition> {
    match kind {
        SignalKind::SessionStarted { .. } | SignalKind::TurnCompleted { .. } => Some(AWAITING_PROMPT),
        SignalKind::PromptSubmitted | SignalKind::UserInputResolved => Some(HookTransition {
            status: TaskRunStatus::Running,
            wait_reason: None,
        }),
        SignalKind::UserInputRequired { reason, .. } => Some(HookTransition {
            status: TaskRunStatus::WaitingForUser,
            wait_reason: Some(*reason),
        }),
        SignalKind::SessionEnded { .. } => Some(HookTransition {
            status: TaskRunStatus::Stopped,
            wait_reason: None,
        }),
        SignalKind::SubagentFinished { .. }
        | SignalKind::NotificationReceived { .. }
        | SignalKind::Inert => None,
    }
}

/// What a hook observation should record once [`TaskRun::decide`] has reconciled a signal against the
/// run's current state. The store still re-enforces the protection rules atomically (hooks race in
/// separate processes); this is the advisory snapshot that decides which observation to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunObservationPlan {
    pub transition: Option<HookTransition>,
    pub stamp_session: bool,
    pub stamp_tab: bool,
    pub hold_stop: bool,
    pub release_stop: bool,
}

impl TaskRun {
    /// Reconcile a provider-agnostic [`AgentSignal`] against this run's current state, yielding the
    /// observation to record. Pure: the caller persists the result and the store re-checks the same
    /// protection rules atomically.
    pub fn decide(&self, signal: &AgentSignal) -> RunObservationPlan {
        let requested = requested_transition(&signal.kind);
        // A fork/resume/compact start carries a prior session forward; it must not demote a primary
        // that is mid-turn back to "your turn".
        let suppressed_continuation = self.status == TaskRunStatus::Running
            && matches!(
                signal.kind,
                SignalKind::SessionStarted {
                    continuation: Continuation::Resume | Continuation::Compact
                }
            );
        let protected = match requested {
            Some(next) if !suppressed_continuation => self.transition_is_protected(signal, next),
            _ => false,
        };
        let transition = match requested {
            Some(next) if !suppressed_continuation && !protected => Some(next),
            _ => None,
        };
        RunObservationPlan {
            transition,
            // A protected straggler must not re-stamp its dead session over the successor's id.
            stamp_session: !protected,
            // A resumed start still carries the source session id, so it can't prove where the
            // session lives; the tab claim waits for the first real activity.
            stamp_tab: !matches!(
                signal.kind,
                SignalKind::SessionStarted {
                    continuation: Continuation::Resume
                }
            ),
            hold_stop: matches!(
                signal.kind,
                SignalKind::TurnCompleted {
                    subagents_running: true
                }
            ),
            release_stop: matches!(
                signal.kind,
                SignalKind::SubagentFinished {
                    subagents_running: false
                }
            ),
        }
    }

    /// Whether `next` must be refused because it is a late or out-of-order signal. Mirrors the
    /// atomic SQL guard in the store (the snapshot here is advisory; hooks run in separate
    /// processes).
    ///
    /// - A terminal verdict (SessionEnd → Stopped) belongs to the session that died: arriving from a
    ///   session that is not the run's current one, it is stale news and must not kill the live
    ///   successor that has since claimed the run.
    /// - A tool-specific wait (pending question / plan approval) must not be downgraded to the
    ///   generic awaiting-prompt wait by the turn-complete that trails every tool call.
    /// - A dead run stays dead: a turn-complete that lands after SessionEnd must not resurrect a
    ///   stopped run into "needs you".
    ///
    /// The generic-wait rules are scoped to the session the run already saw: a generic wait carried
    /// by a session the run has never met is new evidence of life, so it may revive a stopped run
    /// and clears a tool wait whose question died with its session.
    fn transition_is_protected(&self, signal: &AgentSignal, next: HookTransition) -> bool {
        let known = self.provider_session_id.as_deref();
        let event = signal.session_id.as_deref();
        if next.status.is_terminal() {
            return matches!((known, event), (Some(known), Some(event)) if known != event);
        }
        if !transition_is_generic_wait(next) {
            return false;
        }
        // A turn-complete fired while a subagent is still working must not demote the run; a session
        // start carrying the same generic wait is new life and is exempt.
        let subagent_in_flight = matches!(
            signal.kind,
            SignalKind::TurnCompleted {
                subagents_running: true
            }
        );
        if subagent_in_flight && !signal.starts_session() {
            return true;
        }
        let from_new_session = match (known, event) {
            (_, None) => false,
            (None, Some(_)) => true,
            (Some(known), Some(event)) => known != event,
        };
        if from_new_session {
            return false;
        }
        match self.status {
            TaskRunStatus::Stopped => true,
            TaskRunStatus::WaitingForUser => {
                self.wait_reason.is_some_and(TaskRunWaitReason::is_tool_wait)
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{TaskId, TaskRunId};
    use crate::json::RawJson;
    use crate::task_run::Agent;

    fn run(status: TaskRunStatus, wait_reason: Option<TaskRunWaitReason>, session: Option<&str>) -> TaskRun {
        TaskRun {
            id: TaskRunId::from_store("run-1".to_string()),
            task_id: TaskId::from_store("mon-1".to_string()),
            agent: Some(Agent::Claude),
            branch: None,
            worktree_path: None,
            status,
            wait_reason,
            settings_path: None,
            provider_session_id: session.map(str::to_string),
            terminal_tab_id: None,
            last_event_name: None,
            last_event_at: None,
            plan_file_path: None,
            pending_stop: false,
            metadata: RawJson::empty_object(),
            created_at: "t0".into(),
            updated_at: "t0".into(),
        }
    }

    fn signal(session: Option<&str>, kind: SignalKind) -> AgentSignal {
        AgentSignal {
            session_id: session.map(str::to_string),
            event_label: None,
            kind,
        }
    }

    #[test]
    fn signal_kinds_map_to_run_transitions() {
        let r = run(TaskRunStatus::WaitingForUser, None, Some("s1"));
        let cases = [
            (
                SignalKind::SessionStarted {
                    continuation: Continuation::Fresh,
                },
                Some((TaskRunStatus::WaitingForUser, Some(TaskRunWaitReason::AwaitingPrompt))),
            ),
            (SignalKind::PromptSubmitted, Some((TaskRunStatus::Running, None))),
            (
                SignalKind::TurnCompleted {
                    subagents_running: false,
                },
                Some((TaskRunStatus::WaitingForUser, Some(TaskRunWaitReason::AwaitingPrompt))),
            ),
            (SignalKind::UserInputResolved, Some((TaskRunStatus::Running, None))),
            (
                SignalKind::SessionEnded { reason: None },
                Some((TaskRunStatus::Stopped, None)),
            ),
            (SignalKind::Inert, None),
            (
                SignalKind::NotificationReceived {
                    permission_request: true,
                },
                None,
            ),
            (
                SignalKind::SubagentFinished {
                    subagents_running: false,
                },
                None,
            ),
        ];
        for (kind, expected) in cases {
            let plan = r.decide(&signal(Some("s1"), kind.clone()));
            assert_eq!(
                plan.transition.map(|t| (t.status, t.wait_reason)),
                expected,
                "{kind:?}"
            );
        }
    }

    #[test]
    fn user_input_required_carries_its_wait_reason() {
        let r = run(TaskRunStatus::Running, None, Some("s1"));
        for reason in [
            TaskRunWaitReason::AskUserQuestion,
            TaskRunWaitReason::ExitPlanMode,
            TaskRunWaitReason::PermissionRequest,
        ] {
            let plan = r.decide(&signal(
                Some("s1"),
                SignalKind::UserInputRequired {
                    reason,
                    plan_file_path: None,
                },
            ));
            assert_eq!(
                plan.transition,
                Some(HookTransition {
                    status: TaskRunStatus::WaitingForUser,
                    wait_reason: Some(reason),
                })
            );
        }
    }

    #[test]
    fn late_turn_complete_does_not_resurrect_a_stopped_run() {
        let r = run(TaskRunStatus::Stopped, None, Some("s1"));
        for event in [Some("s1"), None] {
            let plan = r.decide(&signal(
                event,
                SignalKind::TurnCompleted {
                    subagents_running: false,
                },
            ));
            assert_eq!(plan.transition, None);
        }
    }

    #[test]
    fn fresh_session_start_revives_a_stopped_run() {
        let r = run(TaskRunStatus::Stopped, None, Some("s1"));
        let plan = r.decide(&signal(
            Some("s2"),
            SignalKind::SessionStarted {
                continuation: Continuation::Fresh,
            },
        ));
        assert_eq!(
            plan.transition.map(|t| t.status),
            Some(TaskRunStatus::WaitingForUser)
        );
        assert!(plan.stamp_session);
    }

    #[test]
    fn turn_complete_preserves_a_tool_specific_wait() {
        let r = run(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::AskUserQuestion),
            Some("s1"),
        );
        let plan = r.decide(&signal(
            Some("s1"),
            SignalKind::TurnCompleted {
                subagents_running: false,
            },
        ));
        assert_eq!(plan.transition, None);
    }

    #[test]
    fn turn_complete_during_subagent_holds_the_run() {
        let r = run(TaskRunStatus::Running, None, Some("s1"));
        let plan = r.decide(&signal(
            Some("s1"),
            SignalKind::TurnCompleted {
                subagents_running: true,
            },
        ));
        assert_eq!(plan.transition, None, "held, not demoted to your-turn");
        assert!(plan.hold_stop);
        // A session start carries the same generic wait but is new life: never held.
        let started = r.decide(&signal(
            Some("s1"),
            SignalKind::SessionStarted {
                continuation: Continuation::Fresh,
            },
        ));
        assert_eq!(started.transition.map(|t| t.status), Some(TaskRunStatus::WaitingForUser));
        assert!(!started.hold_stop);
    }

    #[test]
    fn subagent_finished_releases_only_when_none_remain() {
        let r = run(TaskRunStatus::Running, None, Some("s1"));
        assert!(
            r.decide(&signal(
                Some("s1"),
                SignalKind::SubagentFinished {
                    subagents_running: false
                }
            ))
            .release_stop
        );
        assert!(
            !r.decide(&signal(
                Some("s1"),
                SignalKind::SubagentFinished {
                    subagents_running: true
                }
            ))
            .release_stop
        );
    }

    #[test]
    fn stale_terminal_verdict_is_refused_but_own_session_lands() {
        for current in [TaskRunStatus::Running, TaskRunStatus::WaitingForUser] {
            let r = run(current, None, Some("s2"));
            // A SessionEnd from the dead session s1 must not kill the run s2 now drives.
            assert_eq!(
                r.decide(&signal(Some("s1"), SignalKind::SessionEnded { reason: None }))
                    .transition,
                None
            );
        }
        // The same verdict from the run's own session (or anonymous, or before any session) lands.
        for (known, event) in [(Some("s1"), Some("s1")), (Some("s1"), None), (None, Some("s1"))] {
            let r = run(TaskRunStatus::Running, None, known);
            assert_eq!(
                r.decide(&signal(event, SignalKind::SessionEnded { reason: None }))
                    .transition
                    .map(|t| t.status),
                Some(TaskRunStatus::Stopped)
            );
        }
    }

    #[test]
    fn continuation_start_does_not_demote_a_running_primary() {
        for continuation in [Continuation::Resume, Continuation::Compact] {
            let r = run(TaskRunStatus::Running, None, Some("s1"));
            let plan = r.decide(&signal(Some("s1"), SignalKind::SessionStarted { continuation }));
            assert_eq!(plan.transition, None, "{continuation:?}");
        }
    }

    #[test]
    fn resume_start_does_not_stamp_the_tab_others_do() {
        let r = run(TaskRunStatus::Stopped, None, Some("s1"));
        assert!(
            !r.decide(&signal(
                Some("s1"),
                SignalKind::SessionStarted {
                    continuation: Continuation::Resume
                }
            ))
            .stamp_tab
        );
        for continuation in [Continuation::Fresh, Continuation::Compact] {
            assert!(
                r.decide(&signal(Some("s1"), SignalKind::SessionStarted { continuation }))
                    .stamp_tab,
                "{continuation:?}"
            );
        }
        assert!(r.decide(&signal(Some("s1"), SignalKind::PromptSubmitted)).stamp_tab);
    }

    #[test]
    fn protected_transition_does_not_stamp_session() {
        // A late turn-complete on a stopped run is protected: it must not re-stamp its dead session.
        let r = run(TaskRunStatus::Stopped, None, Some("s1"));
        let plan = r.decide(&signal(
            Some("s1"),
            SignalKind::TurnCompleted {
                subagents_running: false,
            },
        ));
        assert!(!plan.stamp_session);
    }

    #[test]
    fn helpers_classify_session_starting_and_plan_file() {
        assert!(signal(None, SignalKind::PromptSubmitted).starts_session());
        assert!(signal(
            None,
            SignalKind::SessionStarted {
                continuation: Continuation::Fresh
            }
        )
        .starts_session());
        assert!(!signal(
            None,
            SignalKind::TurnCompleted {
                subagents_running: false
            }
        )
        .starts_session());

        let with_plan = signal(
            None,
            SignalKind::UserInputRequired {
                reason: TaskRunWaitReason::ExitPlanMode,
                plan_file_path: Some("/p.md".into()),
            },
        );
        assert_eq!(with_plan.plan_file_path(), Some("/p.md"));
        assert_eq!(signal(None, SignalKind::Inert).plan_file_path(), None);
    }
}
