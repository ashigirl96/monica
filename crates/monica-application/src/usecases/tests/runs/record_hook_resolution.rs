use super::*;


// --- resolve rule unit tests ---


#[test]
fn resolve_by_session_returns_none_without_session_id() {
    let mut repos = FakeRepos::default();
    let task = make_task("t1", TaskStatus::Ready, None);
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: None,
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

    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
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
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
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
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
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
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
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
    assert_eq!(resolved_run.provider_session_id.as_deref(), Some("sess-1"));
}

#[test]
fn resolve_by_prepared_primary_loses_race_when_already_claimed() {
    let task = make_task("t1", TaskStatus::Ready, Some("run-1"));
    let mut run = make_run("run-1", "t1", TaskRunStatus::Prepared);
    // Another SessionStart won the claim first: the run is prepared but already carries a session.
    run.provider_session_id = Some("sess-winner".to_string());
    let mut repos = FakeRepos::default();
    repos.seed_run(run.clone());
    let ctx = RunResolveCtx {
        task_id: "t1",
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-loser"),
        starts_session: true,
        agent: Agent::Claude,
        primary_run: Some(&run),
    };
    // The loser changes 0 rows and falls through (Ok(None)) so lazy-create makes it a side run.
    assert!(resolve_by_prepared_primary(&ctx, &mut repos).unwrap().is_none());
    assert_eq!(
        repos.get_task_run("run-1").unwrap().unwrap().provider_session_id.as_deref(),
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
        provider_session_id: None,
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
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
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
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: true,
        provider_session_id: Some("sess-1"),
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
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
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
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
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
    let ctx = RunResolveCtx {
        task_id: &task_id,
        task: &task,
        explicit_run_id_rejected: false,
        provider_session_id: Some("sess-1"),
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
