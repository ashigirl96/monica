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
    let outputs = FakeTaskRunOutputs::default();
    let (task_id, run_id) = task_with_running_primary(&mut repos, &outputs);
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

#[test]
fn facade_create_terminal_session_mark_started_failure_kills_pty_and_errors() {
    let repos = FakeRepos::default();
    repos.fail_mark_started();
    repos.seed_run(driven_run("run-1", "MON-1", "tab-1"));
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());
    let daemon = FakeDaemon::default();
    let new = NewTerminalSession {
        runspace_id: Some("rs-1".to_string()),
        tab_id: Some("tab-1".to_string()),
        kind: TerminalSessionKind::Shell,
        cwd: "/".to_string(),
        shell: "/bin/zsh".to_string(),
        rows: 24,
        cols: 80,
    };

    let err = monica.executions().create_terminal_session(&daemon, new, Vec::new()).unwrap_err();

    assert!(matches!(err, ApplicationError::Storage(_)), "got: {err:?}");
    // The spawned PTY was killed, the row settled as Failed, and the waiting run stopped —
    // an Err from create never leaves a live session behind.
    let session_id = daemon.created.lock().unwrap()[0].session_id.clone();
    assert_eq!(*daemon.terminated.lock().unwrap(), vec![session_id.clone()]);
    let rows = monica.executions().list_terminal_sessions(&daemon, Some("rs-1")).unwrap();
    let row = rows.iter().find(|s| s.id == session_id).expect("session row should exist");
    assert_eq!(row.status, TerminalSessionStatus::Failed);
    assert_eq!(stopped_runs(&sink.events()), vec!["run-1".to_string()]);
}

fn sdk_params(cwd: &str) -> crate::OpenSdkSessionParams {
    crate::OpenSdkSessionParams {
        cwd: cwd.to_string(),
        model: Some("opus".to_string()),
        title: Some("hello".to_string()),
        shell: "/bin/zsh".to_string(),
    }
}

#[test]
fn facade_open_sdk_session_mints_ids_spawns_and_announces() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let spec = monica.executions().open_sdk_session(&daemon, sdk_params(&cwd)).unwrap();

    assert_eq!(spec.runspace_id, "sdk");
    assert_eq!(spec.cwd, cwd);
    uuid::Uuid::parse_str(&spec.claude_session_id).expect("claude session id should be a uuid");
    uuid::Uuid::parse_str(&spec.tab_id).expect("tab id should be a uuid");
    assert_eq!(
        spec.initial_command,
        format!("claude --session-id {} --model 'opus'", spec.claude_session_id)
    );

    // The daemon spawned with the sdk marker plus the standard tab/session id env.
    let created = daemon.created.lock().unwrap();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].session_id, spec.session_id);
    let env: std::collections::HashMap<&str, &str> =
        created[0].env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert_eq!(env.get("MONICA_SDK_SESSION_ID"), Some(&spec.claude_session_id.as_str()));
    assert_eq!(env.get("MONICA_TERMINAL_TAB_ID"), Some(&spec.tab_id.as_str()));
    assert_eq!(env.get("MONICA_TERMINAL_SESSION_ID"), Some(&spec.session_id.as_str()));
    drop(created);

    // The launch command was submitted (and acknowledged) into the session's PTY.
    let written = daemon.written.lock().unwrap();
    assert_eq!(written.len(), 1);
    assert_eq!(written[0].0, spec.session_id);
    assert_eq!(written[0].1, format!("{}\r", spec.initial_command).into_bytes());
    drop(written);

    // The DB row is an agent session parked in the "sdk" runspace under the minted tab id.
    let rows = monica.executions().list_terminal_sessions(&daemon, Some("sdk")).unwrap();
    let row = rows.iter().find(|s| s.id == spec.session_id).expect("session row should exist");
    assert_eq!(row.kind, TerminalSessionKind::Agent);
    assert_eq!(row.tab_id.as_deref(), Some(spec.tab_id.as_str()));

    // The announcement mirrors the spec so the Workbench can adopt the tab as-is.
    let event = sink
        .events()
        .into_iter()
        .find(|e| matches!(e, ApplicationEvent::SdkSessionOpened { .. }))
        .expect("SdkSessionOpened should be announced");
    let ApplicationEvent::SdkSessionOpened {
        runspace_id,
        tab_id,
        session_id,
        claude_session_id,
        cwd: event_cwd,
        title,
    } = event
    else {
        unreachable!()
    };
    assert_eq!(runspace_id, "sdk");
    assert_eq!(tab_id, spec.tab_id);
    assert_eq!(session_id, spec.session_id);
    assert_eq!(claude_session_id, spec.claude_session_id);
    assert_eq!(event_cwd, spec.cwd);
    assert_eq!(title.as_deref(), Some("hello"));
}

#[test]
fn facade_open_sdk_session_rejects_missing_cwd() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();

    let err = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params("/nonexistent/monica-sdk-test"))
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "got: {err:?}");
    assert!(daemon.created.lock().unwrap().is_empty());
    assert!(sink.events().is_empty());
}

#[test]
fn facade_open_sdk_session_rejects_relative_cwd() {
    // "." exists but would resolve against the app process, not the SDK caller.
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();

    let err = monica.executions().open_sdk_session(&daemon, sdk_params(".")).unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "got: {err:?}");
    assert!(daemon.created.lock().unwrap().is_empty());
    assert!(sink.events().is_empty());
}

#[test]
fn facade_open_sdk_session_write_failure_rolls_back_without_announcement() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::failing_write();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let err = monica.executions().open_sdk_session(&daemon, sdk_params(&cwd)).unwrap_err();

    assert!(matches!(err, ApplicationError::External(_)), "got: {err:?}");
    // The half-open session was torn down and settled as Failed, so a retry can't stack a
    // second live session and nothing announces an unlaunched one.
    let session_id = daemon.created.lock().unwrap()[0].session_id.clone();
    assert_eq!(*daemon.terminated.lock().unwrap(), vec![session_id.clone()]);
    let rows = monica.executions().list_terminal_sessions(&daemon, Some("sdk")).unwrap();
    let row = rows.iter().find(|s| s.id == session_id).expect("session row should exist");
    assert_eq!(row.status, TerminalSessionStatus::Failed);
    assert!(!sink
        .events()
        .iter()
        .any(|e| matches!(e, ApplicationEvent::SdkSessionOpened { .. })));
}

#[test]
fn facade_open_sdk_session_mark_started_failure_rolls_back_without_announcement() {
    let repos = FakeRepos::default();
    repos.fail_mark_started();
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let err = monica.executions().open_sdk_session(&daemon, sdk_params(&cwd)).unwrap_err();

    assert!(matches!(err, ApplicationError::Storage(_)), "got: {err:?}");
    // The PTY spawned but its start couldn't be recorded: the shell is killed before the error
    // surfaces, so the documented "an error means retrying is safe" contract holds — a retry
    // can't stack a second live session on an orphan, and nothing launches or announces.
    let session_id = daemon.created.lock().unwrap()[0].session_id.clone();
    assert_eq!(*daemon.terminated.lock().unwrap(), vec![session_id]);
    assert!(daemon.written.lock().unwrap().is_empty());
    assert!(!sink
        .events()
        .iter()
        .any(|e| matches!(e, ApplicationEvent::SdkSessionOpened { .. })));
}

#[test]
fn facade_open_sdk_session_daemon_failure_is_an_error_without_announcement() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::failing_create();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let err = monica.executions().open_sdk_session(&daemon, sdk_params(&cwd)).unwrap_err();

    assert!(matches!(err, ApplicationError::External(_)), "got: {err:?}");
    assert!(!sink
        .events()
        .iter()
        .any(|e| matches!(e, ApplicationEvent::SdkSessionOpened { .. })));
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
