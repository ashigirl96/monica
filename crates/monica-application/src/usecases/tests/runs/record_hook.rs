use super::*;

#[test]
fn record_claude_hook_records_waiting_transition_and_run_output() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let run = repos
        .start_task_run(NewTaskRun {
            task_id: TaskId::from_store(task_id.clone()),
            agent: Some(Agent::Claude),
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some(&run.id)),
        &input_required(None, TaskRunWaitReason::AskUserQuestion),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert_eq!(
        repos.get_task_run(&run.id).unwrap().unwrap().wait_reason,
        Some(TaskRunWaitReason::AskUserQuestion)
    );
}

#[test]
fn record_claude_hook_forwards_plan_file_path_from_the_signal() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);

    let plan = AgentSignal {
        session_id: Some("sess-1".to_string()),
        event_label: Some("PreToolUse".to_string()),
        kind: SignalKind::UserInputRequired {
            reason: TaskRunWaitReason::ExitPlanMode,
            plan_file_path: Some("/Users/me/.claude/plans/x.md".to_string()),
        },
    };
    record_claude_hook(&mut repos, hook_ctx(&task_id, Some(&run_id)), &plan).unwrap();

    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::ExitPlanMode));
    assert_eq!(run.plan_file_path.as_deref(), Some("/Users/me/.claude/plans/x.md"));
}

#[test]
fn record_claude_hook_claims_prepared_primary_run_without_run_id() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_prepared_primary(&mut repos);

    // The session opens but nothing runs yet: the claim lands as "your turn".
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    let claimed = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(claimed.status, TaskRunStatus::WaitingForUser);
    assert_eq!(claimed.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));

    // The first prompt is what actually puts the agent to work...
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &prompt("sess-1"),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Running));
    assert_eq!(
        repos.get_task_run(&run_id).unwrap().unwrap().wait_reason,
        None
    );

    // ...and the finished turn hands the ball back to the user, not to the morgue.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert_eq!(
        repos.get_task_run(&run_id).unwrap().unwrap().wait_reason,
        Some(TaskRunWaitReason::AwaitingPrompt)
    );
}

#[test]
fn entered_waiting_for_user_marks_only_the_entering_edge() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);

    // Running -> WaitingForUser: the entering edge.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some(&run_id)),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert!(report.entered_waiting_for_user);

    // A trailing Stop re-affirms the generic wait, but the run was already waiting: not an edge,
    // so it must not notify again.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some(&run_id)),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert!(!report.entered_waiting_for_user);

    // Back to Running, then a terminal transition: a non-waiting landing is never an edge.
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some(&run_id)),
        &prompt("sess-1"),
    )
    .unwrap();
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some(&run_id)),
        &session_ended("sess-1"),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Stopped));
    assert!(!report.entered_waiting_for_user);
}

#[test]
fn record_claude_hook_does_not_claim_prepared_primary_on_stray_stop() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_prepared_primary(&mut repos);

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &turn_completed("sess-stray", false),
    )
    .unwrap();
    assert!(!report.task_run_linked);
    assert!(!report.task_run_created);
    assert!(report.event_recorded);
    let primary = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(primary.status, TaskRunStatus::Prepared);
    assert_eq!(primary.provider_session_id, None);
}

#[test]
fn record_claude_hook_does_not_create_runs_for_rejected_run_id() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some("../evil")),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.unsafe_task_run_id);
    assert!(!report.task_run_linked);
    assert!(!report.task_run_created);
    assert!(repos.list_task_runs_for_task(&task_id).unwrap().is_empty());
}

#[test]
fn record_claude_hook_creates_side_run_instead_of_stealing_active_primary() {
    let mut repos = FakeRepos::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos);

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert!(report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));

    // The primary is neither stolen nor re-pointed.
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(task.primary_task_run_id.as_deref(), Some(primary_id.as_str()));
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.status, TaskRunStatus::Running);
    assert_eq!(primary.provider_session_id.as_deref(), Some("sess-1"));

    let side = repos
        .find_task_run_by_session(&task_id, "sess-2")
        .unwrap()
        .unwrap();
    assert_ne!(side.id.as_str(), primary_id.as_str());
    assert_eq!(side.status, TaskRunStatus::WaitingForUser);
    assert_eq!(side.agent, Some(Agent::Claude));
    // the session's cwd must never become a worktree_path (delete-time cleanup rips those)
    assert_eq!(side.worktree_path, None);
}

#[test]
fn record_claude_hook_fork_session_start_does_not_steal_primary_tab() {
    let mut repos = FakeRepos::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos);
    record_claude_hook(
        &mut repos,
        hook_ctx_in_tab(&task_id, Some(&primary_id), "tab-main"),
        &prompt("sess-1"),
    )
    .unwrap();

    // A fork's SessionStart fires from the new tab while still carrying the source session's id.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx_in_tab(&task_id, None, "tab-fork"),
        &started("sess-1", Continuation::Resume),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, None);
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.terminal_tab_id.as_deref(), Some("tab-main"));
    // The source run is mid-flight; the fork's start must not demote it to "your turn".
    assert_eq!(primary.status, TaskRunStatus::Running);

    // The fork's first prompt arrives under its own id and becomes a side run in the fork tab.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx_in_tab(&task_id, None, "tab-fork"),
        &prompt("sess-2"),
    )
    .unwrap();
    assert!(report.task_run_created);
    let side = repos
        .find_task_run_by_session(&task_id, "sess-2")
        .unwrap()
        .unwrap();
    assert_eq!(side.terminal_tab_id.as_deref(), Some("tab-fork"));
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.terminal_tab_id.as_deref(), Some("tab-main"));
    assert_eq!(
        repos
            .find_task_run_by_terminal_tab("tab-main")
            .unwrap()
            .unwrap()
            .id
            .as_str(),
        primary_id.as_str()
    );
}

#[test]
fn record_claude_hook_resumed_session_rebinds_tab_on_first_prompt() {
    let mut repos = FakeRepos::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos);
    record_claude_hook(
        &mut repos,
        hook_ctx_in_tab(&task_id, Some(&primary_id), "tab-main"),
        &prompt("sess-1"),
    )
    .unwrap();

    // Resuming in another tab proves nothing yet (it could be a fork)...
    record_claude_hook(
        &mut repos,
        hook_ctx_in_tab(&task_id, None, "tab-new"),
        &started("sess-1", Continuation::Resume),
    )
    .unwrap();
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.terminal_tab_id.as_deref(), Some("tab-main"));

    // ...the first prompt under the same session id is what moves the binding.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx_in_tab(&task_id, None, "tab-new"),
        &prompt("sess-1"),
    )
    .unwrap();
    assert!(!report.task_run_created);
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.terminal_tab_id.as_deref(), Some("tab-new"));
}

#[test]
fn record_claude_hook_follows_side_run_through_its_lifecycle() {
    let mut repos = FakeRepos::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos);
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &input_required(Some("sess-2"), TaskRunWaitReason::AskUserQuestion),
    )
    .unwrap();
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));

    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &input_resolved("sess-2"),
    )
    .unwrap();
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &session_ended("sess-2"),
    )
    .unwrap();
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Stopped));
    assert_eq!(
        repos.get_task_run(&primary_id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );
}

#[test]
fn record_claude_hook_compact_session_start_does_not_demote_running_primary() {
    let mut repos = FakeRepos::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos);

    // Auto-compact fires SessionStart mid-turn under the same session id.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &started("sess-1", Continuation::Compact),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert_eq!(report.task_run_status, None);
    assert_eq!(
        repos.get_task_run(&primary_id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );
}

#[test]
fn record_claude_hook_stop_preserves_tool_specific_wait() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &input_required(Some("sess-1"), TaskRunWaitReason::AskUserQuestion),
    )
    .unwrap();

    // The Stop that trails the question must not blur "needs you" into "your turn".
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, None);
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AskUserQuestion));
}

#[test]
fn record_claude_hook_stop_during_subagent_keeps_run_running() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);

    // A Stop whose background_tasks still reports a running subagent must not flicker the run to
    // "your turn".
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", true),
    )
    .unwrap();
    assert_eq!(report.task_run_status, None);
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Running);
    assert!(run.pending_stop);

    // Once background_tasks is empty, the Stop settles the turn.
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

/// A `Stop` held by a running subagent is released by the `SubagentStop` that leaves nothing in
/// flight — the deferred transition fires and the entering edge is reported so a notification can
/// be pushed. The SubagentStop snapshot still lists the stopping agent, so it is excluded by id.
#[test]
fn record_claude_hook_deferred_stop_fires_on_last_subagent_stop() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);

    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", true),
    )
    .unwrap();
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Running);
    assert!(run.pending_stop);

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &subagent_finished("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert!(report.entered_waiting_for_user);
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    assert!(!run.pending_stop);
}

/// The subagent guard reads `background_tasks` per event, so it self-heals through Claude's
/// re-injection cycle (a `<task-notification>` UserPromptSubmit then a fresh Stop) and is not
/// fooled by a start-less `SubagentStop` whose agent is absent from the snapshot — the two
/// real-world hook glitches behind MON-73 and MON-131.
#[test]
fn record_claude_hook_subagent_guard_tracks_background_tasks() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);

    let status = |repos: &FakeRepos| repos.get_task_run(&run_id).unwrap().unwrap().status;
    let fire = |repos: &mut FakeRepos, sig: &AgentSignal| {
        record_claude_hook(repos, hook_ctx(&task_id, None), sig).unwrap()
    };

    // Two subagents running: the Stop is held.
    fire(&mut repos, &turn_completed("sess-1", true));
    assert_eq!(status(&repos), TaskRunStatus::Running);

    // A start-less SubagentStop whose agent is not in the snapshot must not release the hold.
    fire(&mut repos, &subagent_finished("sess-1", true));
    assert_eq!(status(&repos), TaskRunStatus::Running);

    // Claude re-injects a finished subagent's result as a UserPromptSubmit; the parent is working
    // again, so the run follows to Running.
    fire(&mut repos, &prompt("sess-1"));
    assert_eq!(status(&repos), TaskRunStatus::Running);

    // The parent comes to rest with an empty background_tasks: now it settles to "your turn".
    fire(&mut repos, &turn_completed("sess-1", false));
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

#[test]
fn record_claude_hook_late_stop_does_not_resurrect_stopped_run() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();
    assert_eq!(
        repos.get_task_run(&run_id).unwrap().unwrap().status,
        TaskRunStatus::Stopped
    );

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();
    assert_eq!(report.task_run_status, None);
    assert_eq!(
        repos.get_task_run(&run_id).unwrap().unwrap().status,
        TaskRunStatus::Stopped
    );
}

#[test]
fn record_claude_hook_fresh_session_start_revives_stopped_run() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();

    // Relaunching claude in the wrapper tab starts a brand-new session under the same
    // MONICA_TASK_RUN_ID; its SessionStart must bring the run back to "your turn".
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some(&run_id)),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    assert_eq!(run.provider_session_id.as_deref(), Some("sess-2"));
}

#[test]
fn record_claude_hook_session_end_settles_waiting_run() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &turn_completed("sess-1", false),
    )
    .unwrap();

    // A waiting run is still a live session; its death is a fact that must land.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Stopped));
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Stopped);
    assert_eq!(run.wait_reason, None);
}

#[test]
fn record_claude_hook_stale_terminal_verdict_does_not_kill_revived_run() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some(&run_id)),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();

    // Stragglers arrive through the pinned MONICA_TASK_RUN_ID after the relaunch, but neither
    // may touch the run sess-2 now owns: the dead session's SessionEnd is a stale terminal
    // verdict (session-scoped), and StopFailure is inert by design — never the run's verdict.
    for payload in [
        &session_ended("sess-1"),
        &inert_event("sess-1", "StopFailure"),
    ] {
        let report =
            record_claude_hook(&mut repos, hook_ctx(&task_id, Some(&run_id)), payload)
                .unwrap();
        assert_eq!(report.task_run_status, None, "{payload:?}");
        let run = repos.get_task_run(&run_id).unwrap().unwrap();
        assert_eq!(run.status, TaskRunStatus::WaitingForUser, "{payload:?}");
        assert_eq!(
            run.wait_reason,
            Some(TaskRunWaitReason::AwaitingPrompt),
            "{payload:?}"
        );
    }
}

#[test]
fn record_claude_hook_resume_session_start_lands_created_run_as_awaiting_prompt() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);

    // Resuming an old conversation in a bench tab of a task with no primary lazily creates a
    // run; the continuation suppression is scoped to Running, so the new run must land at
    // "your turn" instead of being parked at setting_up with no way to settle it.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx_in_tab(&task_id, None, "tab-resume"),
        &started("sess-9", Continuation::Resume),
    )
    .unwrap();
    assert!(report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));

    let task = repos.get_task(&task_id).unwrap().unwrap();
    let primary_id = task.primary_task_run_id.expect("created run becomes primary");
    let run = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    // A resume start still carries the source session's id, so the tab claim keeps waiting
    // for the first activity event.
    assert_eq!(run.terminal_tab_id, None);
}

#[test]
fn record_claude_hook_resume_session_start_revives_stopped_run_it_resolves() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);
    record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &session_ended("sess-1"),
    )
    .unwrap();

    // `claude --resume` of a brand-new conversation lands through the pinned run id with a
    // session the run has never seen: that is new life, same as a startup start.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some(&run_id)),
        &started("sess-3", Continuation::Resume),
    )
    .unwrap();
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    let run = repos.get_task_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

#[test]
fn record_claude_hook_promotes_created_run_when_no_primary_is_set() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_created);

    let task = repos.get_task(&task_id).unwrap().unwrap();
    let primary_id = task.primary_task_run_id.expect("created run becomes primary");
    let primary = repos.get_task_run(&primary_id).unwrap().unwrap();
    assert_eq!(primary.provider_session_id.as_deref(), Some("sess-1"));
    assert_eq!(primary.status, TaskRunStatus::WaitingForUser);
    assert_eq!(primary.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

#[test]
fn record_claude_hook_repairs_dangling_primary_pointer() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    repos.set_primary_task_run(&task_id, "run-999").unwrap();

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_created);

    let task = repos.get_task(&task_id).unwrap().unwrap();
    let primary_id = task.primary_task_run_id.unwrap();
    assert_ne!(primary_id, "run-999");
    assert!(repos.get_task_run(&primary_id).unwrap().is_some());
}

#[test]
fn record_claude_hook_does_not_create_runs_for_non_session_starting_events() {
    let mut repos = FakeRepos::default();
    let (task_id, _) = task_with_running_primary(&mut repos);

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &turn_completed("sess-unknown", false),
    )
    .unwrap();
    assert!(!report.task_run_linked);
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, None);
    assert!(report.event_recorded);
    assert_eq!(repos.list_task_runs_for_task(&task_id).unwrap().len(), 1);
}

#[test]
fn record_claude_hook_does_not_create_runs_without_a_session_id() {
    let mut repos = FakeRepos::default();
    let (task_id, _) = task_with_running_primary(&mut repos);

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &started_no_session(Continuation::Fresh),
    )
    .unwrap();
    assert!(!report.task_run_linked);
    assert!(!report.task_run_created);
}

#[test]
fn record_claude_hook_creates_side_run_on_user_prompt_submit() {
    let mut repos = FakeRepos::default();
    let (task_id, _) = task_with_running_primary(&mut repos);

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &prompt("sess-2"),
    )
    .unwrap();
    assert!(report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::Running));
}

#[test]
fn record_claude_hook_does_not_create_runs_for_done_tasks() {
    let mut repos = FakeRepos::default();
    let (task_id, _) = task_with_running_primary(&mut repos);
    repos.update_task_status(&task_id, TaskStatus::Closed).unwrap();

    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, None),
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();
    assert!(!report.task_run_created);
    assert!(!report.task_run_linked);
    assert_eq!(
        repos.get_task(&task_id).unwrap().unwrap().status,
        TaskStatus::Closed
    );
}

#[test]
fn record_claude_hook_records_terminal_tab_id_from_context() {
    let mut repos = FakeRepos::default();
    let (task_id, _) = task_with_running_primary(&mut repos);

    record_claude_hook(
        &mut repos,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-7"),
            terminal_session_id: None,
        },
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();

    let side = repos
        .find_task_run_by_session(&task_id, "sess-2")
        .unwrap()
        .unwrap();
    assert_eq!(side.terminal_tab_id.as_deref(), Some("tab-7"));
    assert_eq!(
        repos
            .find_task_run_by_terminal_tab("tab-7")
            .unwrap()
            .unwrap()
            .id,
        side.id
    );
}

#[test]
fn record_claude_hook_tracks_agent_status_on_session_without_task() {
    use crate::ports::TerminalSessionRepository;
    use crate::prelude::AgentSessionStatus;

    let mut repos = FakeRepos::default();
    let session = repos
        .create_terminal_session(NewTerminalSession {
            runspace_id: Some("rs-1".to_string()),
            tab_id: Some("tab-1".to_string()),
            kind: TerminalSessionKind::Shell,
            cwd: "/".to_string(),
            shell: "/bin/zsh".to_string(),
            rows: 24,
            cols: 80,
        })
        .unwrap();
    let ctx = HookContext {
        terminal_session_id: Some(&session.id),
        ..HookContext::default()
    };

    record_claude_hook(&mut repos, ctx, &started("sess-1", Continuation::Fresh)).unwrap();
    let s = repos.get_terminal_session(&session.id).unwrap().unwrap();
    assert_eq!(s.agent_status, Some(AgentSessionStatus::Running));
    assert_eq!(s.agent_wait_reason, None);

    record_claude_hook(
        &mut repos,
        ctx,
        &input_required(Some("sess-1"), TaskRunWaitReason::ExitPlanMode),
    )
    .unwrap();
    let s = repos.get_terminal_session(&session.id).unwrap().unwrap();
    assert_eq!(s.agent_status, Some(AgentSessionStatus::WaitingForUser));
    assert_eq!(s.agent_wait_reason, Some(TaskRunWaitReason::ExitPlanMode));

    record_claude_hook(&mut repos, ctx, &turn_completed("sess-1", false)).unwrap();
    let s = repos.get_terminal_session(&session.id).unwrap().unwrap();
    assert_eq!(s.agent_status, Some(AgentSessionStatus::WaitingForUser));
    assert_eq!(s.agent_wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));

    record_claude_hook(&mut repos, ctx, &session_ended("sess-1")).unwrap();
    let s = repos.get_terminal_session(&session.id).unwrap().unwrap();
    assert_eq!(s.agent_status, None);
    assert_eq!(s.agent_wait_reason, None);
}

#[test]
fn record_claude_hook_ignores_unknown_terminal_session() {
    let mut repos = FakeRepos::default();
    let ctx = HookContext {
        terminal_session_id: Some("ts-ghost"),
        ..HookContext::default()
    };
    let report =
        record_claude_hook(&mut repos, ctx, &started("sess-1", Continuation::Fresh)).unwrap();
    assert!(!report.task_found);
}
