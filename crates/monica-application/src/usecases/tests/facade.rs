use super::*;
use super::support::*;


// ---------------------------------------------------------------------------
// Façade orchestration tests
//
// The pure decision functions (task_run_settlement_for_*, reconcile_terminal_sessions) and the
// store CAS guard (settle_task_run_if_live) are tested elsewhere. These exercise the composition
// the façade adds on top: fetch rows → call the pure verdict → apply → emit, end to end against a
// fake backend, asserting the emitted ApplicationEvents.
// ---------------------------------------------------------------------------


#[test]
fn facade_ingest_agent_hook_decodes_records_and_emits() {
    // The façade owns the decode: raw bytes in, the configured signal lands a transition, and the
    // entering edge into WaitingForUser emits AwaitingUserInput — all behind Monica.
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos);
    let sink = RecordingSink::default();
    let decoder =
        TestAgentDecoders::with_signal(input_required(Some("sess"), TaskRunWaitReason::AskUserQuestion));
    let mut monica = facade_with_decoder(repos, sink.clone(), decoder);

    let report = monica
        .executions()
        .ingest_agent_hook(
            Agent::Claude,
            hook_ctx(&task_id, Some(&run_id)),
            r#"{"hook_event_name":"PreToolUse"}"#,
        )
        .unwrap();

    assert!(!report.ignored);
    // The decoded signal's label is propagated into the report (and on to the CLI's debug log).
    assert_eq!(report.event_name.as_deref(), Some("PreToolUse"));
    assert_eq!(report.task_run_status, Some(TaskRunStatus::WaitingForUser));
    assert!(report.entered_waiting_for_user);
    assert!(sink
        .events()
        .iter()
        .any(|e| matches!(e, ApplicationEvent::AwaitingUserInput { .. })));
}

#[test]
fn facade_ingest_agent_hook_recovers_event_label_for_dropped_event() {
    // A non-actionable payload decodes to None; the façade still recovers the provider event name
    // via the decoder's event_label so the driver's debug log keeps it without touching decoders.
    let sink = RecordingSink::default();
    let decoder = TestAgentDecoders::with_label("PreToolUse");
    let mut monica = facade_with_decoder(FakeRepos::default(), sink, decoder);

    let report = monica
        .executions()
        .ingest_agent_hook(Agent::Claude, HookContext::default(), r#"{"hook_event_name":"PreToolUse","tool_name":"Read"}"#)
        .unwrap();

    assert!(report.ignored);
    assert_eq!(report.event_name.as_deref(), Some("PreToolUse"));
}

#[test]
fn facade_settles_run_on_terminal_exit() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-1", "MON-1", "tab-1"));
    repos.seed_session(fake_session("ts-1", Some("tab-1"), TerminalSessionStatus::Exited));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica
        .executions()
        .settle_runs_for_terminated_sessions(&["ts-1".to_string()]);

    assert_eq!(stopped_runs(&sink.events()), vec!["run-1".to_string()]);
}

#[test]
fn facade_skips_stale_exit_after_tab_respawn() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-1", "MON-1", "tab-1"));
    repos.seed_session(fake_session("ts-1", Some("tab-1"), TerminalSessionStatus::Exited));
    // A newer session in the same tab makes ts-1 no longer the latest.
    repos.seed_session(fake_session("ts-2", Some("tab-1"), TerminalSessionStatus::Running));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica
        .executions()
        .settle_runs_for_terminated_sessions(&["ts-1".to_string()]);

    assert!(sink.events().is_empty());
}

#[test]
fn facade_skips_exit_for_session_without_tab() {
    let repos = FakeRepos::default();
    repos.seed_session(fake_session("ts-1", None, TerminalSessionStatus::Exited));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica
        .executions()
        .settle_runs_for_terminated_sessions(&["ts-1".to_string()]);

    assert!(sink.events().is_empty());
}

#[test]
fn facade_does_not_settle_prepared_run_on_exit() {
    let repos = FakeRepos::default();
    let mut prepared = driven_run("run-1", "MON-1", "tab-1");
    prepared.status = TaskRunStatus::Prepared;
    repos.seed_run(prepared);
    repos.seed_session(fake_session("ts-1", Some("tab-1"), TerminalSessionStatus::Exited));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica
        .executions()
        .settle_runs_for_terminated_sessions(&["ts-1".to_string()]);

    assert!(sink.events().is_empty());
}

#[test]
fn facade_orphan_sweep_settles_only_dead_tabs() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-dead", "MON-1", "tab-dead"));
    repos.seed_run(driven_run("run-live", "MON-2", "tab-live"));
    repos.seed_session(fake_session("ts-dead", Some("tab-dead"), TerminalSessionStatus::Exited));
    repos.seed_session(fake_session("ts-live", Some("tab-live"), TerminalSessionStatus::Running));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica.executions().settle_orphaned_runs();

    assert_eq!(stopped_runs(&sink.events()), vec!["run-dead".to_string()]);
}

#[test]
fn facade_mark_all_sessions_lost_settles_live_sessions_only() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-1", "MON-1", "tab-1"));
    repos.seed_session(fake_session("ts-live", Some("tab-1"), TerminalSessionStatus::Running));
    // Already terminal: excluded from the lost set and not re-settled.
    repos.seed_session(fake_session("ts-done", Some("tab-2"), TerminalSessionStatus::Exited));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    monica.executions().mark_all_sessions_lost().unwrap();

    assert_eq!(stopped_runs(&sink.events()), vec!["run-1".to_string()]);
}

#[test]
fn facade_create_terminal_session_failure_marks_failed_and_settles() {
    let repos = FakeRepos::default();
    repos.seed_run(driven_run("run-1", "MON-1", "tab-1"));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());
    let daemon = FakeDaemon::failing_create();
    let new = NewTerminalSession {
        runspace_id: Some("rs-1".to_string()),
        tab_id: Some("tab-1".to_string()),
        kind: TerminalSessionKind::Shell,
        cwd: "/".to_string(),
        shell: "/bin/zsh".to_string(),
        rows: 24,
        cols: 80,
    };

    let session = monica.executions().create_terminal_session(&daemon, new, Vec::new()).unwrap();

    assert_eq!(session.status, TerminalSessionStatus::Failed);
    assert_eq!(stopped_runs(&sink.events()), vec!["run-1".to_string()]);
}

#[tokio::test]
async fn facade_sync_pull_requests_counts_and_announces() {
    let repos = FakeRepos::default();
    repos.seed_pr_branch_candidate(PullRequestBranchSyncCandidate {
        task_id: "MON-1".to_string(),
        repo: "owner/repo".to_string(),
        branch: "issue-1".to_string(),
    });
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    let count = monica.synchronization().sync_pull_requests(5, true).await.unwrap();

    assert_eq!(count, 1);
    assert!(sink
        .events()
        .iter()
        .any(|e| matches!(e, ApplicationEvent::PullRequestSyncCompleted { synced_count: 1 })));
}

#[tokio::test]
async fn facade_sync_pull_requests_stays_silent_without_announce() {
    let repos = FakeRepos::default();
    repos.seed_pr_branch_candidate(PullRequestBranchSyncCandidate {
        task_id: "MON-1".to_string(),
        repo: "owner/repo".to_string(),
        branch: "issue-1".to_string(),
    });
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    let count = monica.synchronization().sync_pull_requests(5, false).await.unwrap();

    assert_eq!(count, 1);
    assert!(sink.events().is_empty());
}

#[tokio::test]
async fn facade_force_sync_pull_requests_announces_completion() {
    let repos = FakeRepos::default();
    repos.set_branch_sync_candidates(vec![PullRequestBranchSyncCandidate {
        task_id: "MON-1".to_string(),
        repo: "owner/repo".to_string(),
        branch: "issue-1".to_string(),
    }]);
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());

    // FakeGithub lists no recent PRs, so nothing matches; the forced path still announces (unlike
    // the periodic sweep, which stays silent).
    let count = monica.synchronization().force_sync_pull_requests().await.unwrap();

    assert_eq!(count, 0);
    assert!(sink
        .events()
        .iter()
        .any(|e| matches!(e, ApplicationEvent::PullRequestSyncCompleted { synced_count: 0 })));
}

#[tokio::test]
async fn facade_init_project_prefers_git_branch_over_github() {
    let repos = FakeRepos::default();
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    // FakeGit::detect_repo -> "owner/repo", detect_default_branch -> Some("main"): GitHub fallback
    // is never consulted.
    let report = monica.projects().init_project(None, Path::new("/repo")).await.unwrap();

    assert_eq!(report.project.repo, "owner/repo");
    assert_eq!(report.project.default_branch, "main");
    assert!(!report.scaffold.is_empty());
}

// ---------------------------------------------------------------------------
// ExplanationService
// ---------------------------------------------------------------------------

fn fake_terminal_session(id: &str, provider_session_id: Option<&str>) -> TerminalSession {
    TerminalSession {
        id: id.to_string(),
        runspace_id: None,
        tab_id: None,
        kind: TerminalSessionKind::Agent,
        cwd: "/tmp".to_string(),
        shell: "/bin/zsh".to_string(),
        status: TerminalSessionStatus::Running,
        agent_status: None,
        agent_wait_reason: None,
        provider_session_id: provider_session_id.map(str::to_string),
        pid: None,
        rows: 24,
        cols: 80,
        transcript_path: None,
        exit_code: None,
        started_at: None,
        last_seen_at: None,
        exited_at: None,
        created_at: "2026-07-11T00:00:00.000Z".to_string(),
        updated_at: "2026-07-11T00:00:00.000Z".to_string(),
    }
}

#[test]
fn explanation_create_happy_path() {
    let repos = FakeRepos::default();
    repos.seed_session(fake_terminal_session("ts-1", Some("provider-abc")));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    let (explanation, path) = monica
        .explanations()
        .create_explanation("ts-1", "My Title", ExplanationMode::Diff, Some("summary text"))
        .unwrap();

    assert_eq!(explanation.id, "expl-1");
    assert_eq!(explanation.title, "My Title");
    assert_eq!(explanation.summary.as_deref(), Some("summary text"));
    assert_eq!(explanation.mode, ExplanationMode::Diff);
    assert_eq!(explanation.provider_session_id, "provider-abc");
    assert_eq!(explanation.terminal_session_id, "ts-1");
    assert!(path.to_string_lossy().contains("index.html"));
}

#[test]
fn explanation_create_fails_when_session_not_found() {
    let repos = FakeRepos::default();
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    let err = monica
        .explanations()
        .create_explanation("ts-missing", "title", ExplanationMode::Topic, None)
        .unwrap_err();

    assert!(matches!(err, ApplicationError::NotFound(_)));
}

#[test]
fn explanation_create_fails_when_provider_session_id_is_null() {
    let repos = FakeRepos::default();
    repos.seed_session(fake_terminal_session("ts-1", None));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    let err = monica
        .explanations()
        .create_explanation("ts-1", "title", ExplanationMode::Diff, None)
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)));
}

#[test]
fn explanation_list_returns_reverse_insertion_order() {
    let repos = FakeRepos::default();
    repos.seed_session(fake_terminal_session("ts-1", Some("p1")));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    monica
        .explanations()
        .create_explanation("ts-1", "first", ExplanationMode::Diff, None)
        .unwrap();
    monica
        .explanations()
        .create_explanation("ts-1", "second", ExplanationMode::Topic, None)
        .unwrap();

    let list = monica.explanations().list_explanations().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].title, "second");
    assert_eq!(list[1].title, "first");
}

#[test]
fn explanation_get_found_and_missing() {
    let repos = FakeRepos::default();
    repos.seed_session(fake_terminal_session("ts-1", Some("p1")));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    monica
        .explanations()
        .create_explanation("ts-1", "target", ExplanationMode::Diff, None)
        .unwrap();

    let found = monica.explanations().get_explanation("expl-1").unwrap();
    assert_eq!(found.title, "target");

    let err = monica.explanations().get_explanation("expl-999").unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)));
}

#[test]
fn explanation_get_invalid_id_returns_validation() {
    let repos = FakeRepos::default();
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    let err = monica.explanations().get_explanation("../evil").unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)));
}

#[test]
fn explanation_delete_happy_path() {
    let repos = FakeRepos::default();
    repos.seed_session(fake_terminal_session("ts-1", Some("p1")));
    let sink = RecordingSink::default();
    let outputs = FakeTaskRunOutputs::default();
    let removed_dirs = outputs.removed_dirs_handle();
    let mut monica = facade_with_outputs(repos, sink, outputs);

    monica
        .explanations()
        .create_explanation("ts-1", "to-delete", ExplanationMode::Diff, None)
        .unwrap();

    monica.explanations().delete_explanation("expl-1").unwrap();

    let err = monica.explanations().get_explanation("expl-1").unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)));
    assert_eq!(*removed_dirs.lock().unwrap(), vec!["expl-1".to_string()]);
}

#[test]
fn explanation_ids_are_not_reused_after_delete() {
    let repos = FakeRepos::default();
    repos.seed_session(fake_terminal_session("ts-1", Some("p1")));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    monica
        .explanations()
        .create_explanation("ts-1", "first", ExplanationMode::Diff, None)
        .unwrap();
    monica
        .explanations()
        .create_explanation("ts-1", "second", ExplanationMode::Diff, None)
        .unwrap();
    monica.explanations().delete_explanation("expl-1").unwrap();

    let (third, _) = monica
        .explanations()
        .create_explanation("ts-1", "third", ExplanationMode::Diff, None)
        .unwrap();

    assert_eq!(third.id, "expl-3");
}

#[test]
fn explanation_delete_missing_returns_not_found() {
    let repos = FakeRepos::default();
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    let err = monica.explanations().delete_explanation("expl-999").unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)));
}

#[test]
fn explanation_delete_invalid_id_returns_validation() {
    let repos = FakeRepos::default();
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink);

    let err = monica.explanations().delete_explanation("../evil").unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)));
}
