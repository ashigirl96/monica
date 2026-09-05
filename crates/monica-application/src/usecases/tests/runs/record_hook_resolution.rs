use super::*;
use monica_domain::{AgentSessionId, TaskRunId};



#[test]
fn resolve_by_session_returns_none_without_session_id() {
    let mut repos = FakeRepos::default();
    let task = make_task("t1", TaskStatus::Ready, None);
    let ctx = RunResolveCtx {
        task_id: &TaskId::from_store("t1".to_string()),
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: None,
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_session(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_session_returns_run_when_found() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();

    record_claude_hook(
        &mut repos,
        HookContext { task_id: Some(&task_id), ..HookContext::default() },
        &started("sess-1", Continuation::Fresh),
    ).unwrap();

    let agent_session = AgentSessionId::from_agent("sess-1");
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: Some(&agent_session),
        starts_session: false,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_session(&ctx, &mut repos).unwrap();
    assert!(result.is_some());
    assert!(!result.unwrap().created);
}

#[test]
fn resolve_by_prepared_primary_skips_non_prepared() {
    let task = make_task("t1", TaskStatus::InProgress, Some("run-1"));
    let run = make_run("run-1", "t1", TaskRunStatus::Running);
    let mut repos = FakeRepos::default();
    let agent_session = AgentSessionId::from_agent("sess-1");
    let ctx = RunResolveCtx {
        task_id: &TaskId::from_store("t1".to_string()),
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: Some(&agent_session),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    let result = resolve_by_prepared_primary(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_prepared_primary_skips_non_starting_event() {
    let task = make_task("t1", TaskStatus::Ready, Some("run-1"));
    let run = make_run("run-1", "t1", TaskRunStatus::Prepared);
    let mut repos = FakeRepos::default();
    let agent_session = AgentSessionId::from_agent("sess-1");
    let ctx = RunResolveCtx {
        task_id: &TaskId::from_store("t1".to_string()),
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: Some(&agent_session),
        starts_session: false,
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    let result = resolve_by_prepared_primary(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_prepared_primary_claims_on_session_start() {
    let task = make_task("t1", TaskStatus::Ready, Some("run-1"));
    let run = make_run("run-1", "t1", TaskRunStatus::Prepared);
    let mut repos = FakeRepos::default();
    repos.seed_run(run.clone());
    let agent_session = AgentSessionId::from_agent("sess-1");
    let ctx = RunResolveCtx {
        task_id: &TaskId::from_store("t1".to_string()),
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: Some(&agent_session),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    let result = resolve_by_prepared_primary(&ctx, &mut repos).unwrap();
    let resolved = result.unwrap();
    assert!(!resolved.created);
    let resolved_run = resolved.run.unwrap();
    assert_eq!(resolved_run.id, "run-1");
    // The atomic claim stamped the session, and the returned snapshot reflects the post-claim row.
    assert_eq!(resolved_run.agent_session_id.as_deref(), Some("sess-1"));
}

#[test]
fn resolve_by_prepared_primary_loses_race_when_already_claimed() {
    let task = make_task("t1", TaskStatus::Ready, Some("run-1"));
    let mut run = make_run("run-1", "t1", TaskRunStatus::Prepared);
    // Another SessionStart won the claim first: the run is prepared but already carries a session.
    run.agent_session_id = Some(AgentSessionId::from_agent("sess-winner"));
    let mut repos = FakeRepos::default();
    repos.seed_run(run.clone());
    let agent_session = AgentSessionId::from_agent("sess-loser");
    let ctx = RunResolveCtx {
        task_id: &TaskId::from_store("t1".to_string()),
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: Some(&agent_session),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    // The loser changes 0 rows and falls through (Ok(None)) so lazy-create makes it a side run.
    assert!(resolve_by_prepared_primary(&ctx, &mut repos).unwrap().is_none());
    assert_eq!(
        repos.get_task_run(&TaskRunId::from_store("run-1".to_string())).unwrap().unwrap().agent_session_id.as_deref(),
        Some("sess-winner")
    );
}

#[test]
fn resolve_by_lazy_create_rejects_without_session_id() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: None,
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_lazy_create_rejects_non_starting_event() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let agent_session = AgentSessionId::from_agent("sess-1");
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: Some(&agent_session),
        starts_session: false,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_lazy_create_rejects_when_explicit_run_id_rejected() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let agent_session = AgentSessionId::from_agent("sess-1");
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: true,
        agent_session_id: Some(&agent_session),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_lazy_create_rejects_closed_task() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    repos.mark_task_closed(&task_id).unwrap();
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let agent_session = AgentSessionId::from_agent("sess-1");
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: Some(&agent_session),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    assert!(result.is_none());
}

#[test]
fn resolve_by_lazy_create_creates_primary_when_none_exists() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let agent_session = AgentSessionId::from_agent("sess-1");
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: Some(&agent_session),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: None,
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    let resolved = result.unwrap();
    assert!(resolved.created);
    let run = resolved.run.unwrap();
    let updated_task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(updated_task.primary_task_run_id.as_deref(), Some(run.id.as_str()));
}

#[test]
fn resolve_by_lazy_create_creates_side_run_when_primary_exists() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    let existing_primary = make_run("run-existing", &task_id, TaskRunStatus::Running);
    let agent_session = AgentSessionId::from_agent("sess-1");
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        agent_session_id: Some(&agent_session),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: Some(&existing_primary),
    };
    let result = resolve_by_lazy_create(&ctx, &mut repos).unwrap();
    let resolved = result.unwrap();
    assert!(resolved.created);
    let updated_task = repos.get_task(&task_id).unwrap().unwrap();
    assert!(updated_task.primary_task_run_id.is_none());
}


/// A tab launched without `MONICA_TASK_ID` reaches a run only through the binding
/// `monica task attach` wrote, and only after it was written.
#[test]
fn hook_from_an_unattached_raw_tab_touches_no_run() {
    let mut repos = FakeRepos::default();
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let report = record_claude_hook(
        &mut repos,
        hook_ctx_raw_tab("tab-1", &session_id),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();

    assert!(!report.task_run_linked);
    assert!(!report.task_run_created);
    assert_eq!(report.linked_task_run_id, None);
    // The per-tab agent indicator still updates — that path never needed a task.
    assert_eq!(
        repos.get_terminal_session(&session_id).unwrap().unwrap().agent_status,
        Some(AgentSessionStatus::Running)
    );
}

#[test]
fn hook_from_an_attached_raw_tab_drives_the_attached_run() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));
    let attached =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    let report = record_claude_hook(
        &mut repos,
        hook_ctx_raw_tab("tab-1", &session_id),
        &turn_completed("sess-1", false),
    )
    .unwrap();

    assert_eq!(report.linked_task_run_id.as_ref(), Some(&attached.task_run_id));
    assert_eq!(report.linked_task_id.as_ref(), Some(&task_id));
    assert!(report.task_found);
    assert!(!report.task_run_created);
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert_eq!(report.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));

    let run = repos.get_task_run(&attached.task_run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

/// The binding belongs to the tab, not to the session inside it: a fresh agent in an attached tab
/// keeps driving the same run instead of lazily creating a new one the way a task tab would.
#[test]
fn a_new_session_in_an_attached_tab_revives_the_same_run() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));
    let attached =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    record_claude_hook(
        &mut repos,
        hook_ctx_raw_tab("tab-1", &session_id),
        &session_ended("sess-1"),
    )
    .unwrap();
    assert_eq!(
        repos.get_task_run(&attached.task_run_id).unwrap().unwrap().status,
        TaskRunStatus::Stopped
    );

    let report = record_claude_hook(
        &mut repos,
        hook_ctx_raw_tab("tab-1", &session_id),
        &prompt("sess-2"),
    )
    .unwrap();

    assert_eq!(report.linked_task_run_id.as_ref(), Some(&attached.task_run_id));
    assert!(!report.task_run_created);
    let run = repos.get_task_run(&attached.task_run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Running);
    assert_eq!(run.agent_session_id, Some(AgentSessionId::from_agent("sess-2")));
}

/// A task tab carries `MONICA_TASK_ID`, so it never reaches the tab fallback even when a run is
/// bound to its tab: the task-scoped rules still decide.
#[test]
fn a_task_tab_still_resolves_through_the_task_scoped_rules() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_prepared_primary(&mut repos);

    let report = record_claude_hook(
        &mut repos,
        hook_ctx_in_tab(&task_id, None, "tab-1"),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();

    assert_eq!(report.linked_task_run_id, Some(run_id));
    assert!(!report.task_run_created);
}
