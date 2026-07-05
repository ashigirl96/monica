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
        claude_session_id: None,
    }
}

fn sdk_params_with_id(cwd: &str, claude_session_id: &str) -> crate::OpenSdkSessionParams {
    crate::OpenSdkSessionParams {
        claude_session_id: Some(claude_session_id.to_string()),
        ..sdk_params(cwd)
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

    // The mapping row persists the full correspondence, active. The daemon view is seeded
    // first: the listing reconciles against the daemon, and an unlisted PTY would be
    // demoted to Lost, ending the mapping before the assert.
    daemon.seed_running_view(&spec.session_id);
    let sessions = monica.executions().list_claude_sessions(&daemon).unwrap();
    let mapping = sessions
        .iter()
        .find(|cs| cs.claude_session_id == spec.claude_session_id)
        .expect("claude session mapping should exist");
    assert_eq!(mapping.status, monica_domain::ClaudeSessionStatus::Active);
    assert_eq!(mapping.runspace_id, "sdk");
    assert_eq!(mapping.tab_id, spec.tab_id);
    assert_eq!(mapping.terminal_session_id, spec.session_id);
    assert_eq!(mapping.cwd, spec.cwd);
    assert_eq!(mapping.name.as_deref(), Some("hello"));
    assert_eq!(mapping.ended_at, None);

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
    assert!(monica.executions().list_claude_sessions(&daemon).unwrap().is_empty());
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
    assert!(monica.executions().list_claude_sessions(&daemon).unwrap().is_empty());
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
    assert!(monica.executions().list_claude_sessions(&daemon).unwrap().is_empty());
}

#[test]
fn facade_open_sdk_session_reservation_failure_rolls_back_before_any_launch() {
    let repos = FakeRepos::default();
    repos.fail_create_claude_session();
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let err = monica.executions().open_sdk_session(&daemon, sdk_params(&cwd)).unwrap_err();

    // The reservation is the idempotency lock, so it precedes the launch: a failed (or
    // concurrently lost) reservation tears down a shell that never ran Claude.
    assert!(matches!(err, ApplicationError::External(_)), "got: {err:?}");
    let session_id = daemon.created.lock().unwrap()[0].session_id.clone();
    assert_eq!(*daemon.terminated.lock().unwrap(), vec![session_id]);
    assert!(daemon.written.lock().unwrap().is_empty(), "the launch must never be submitted");
    assert!(!sink
        .events()
        .iter()
        .any(|e| matches!(e, ApplicationEvent::SdkSessionOpened { .. })));
    assert!(monica.executions().list_claude_sessions(&daemon).unwrap().is_empty());
}

#[test]
fn facade_open_sdk_session_launch_confirmation_failure_rolls_back_and_frees_the_id() {
    for (repos, expect_written) in [
        {
            let repos = FakeRepos::default();
            repos.fail_mark_claude_launched();
            (repos, true)
        },
        {
            let repos = FakeRepos::default();
            repos.stall_mark_claude_launched();
            (repos, true)
        },
    ] {
        let sink = RecordingSink::default();
        let mut monica = facade(repos, sink.clone());
        let daemon = FakeDaemon::default();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        let err = monica.executions().open_sdk_session(&daemon, sdk_params(&cwd)).unwrap_err();

        assert!(matches!(err, ApplicationError::External(_)), "got: {err:?}");
        let session_id = daemon.created.lock().unwrap()[0].session_id.clone();
        assert_eq!(*daemon.terminated.lock().unwrap(), vec![session_id]);
        assert_eq!(daemon.written.lock().unwrap().is_empty(), !expect_written);
        assert!(!sink
            .events()
            .iter()
            .any(|e| matches!(e, ApplicationEvent::SdkSessionOpened { .. })));
        // The reservation is deleted, so the same id is a clean fresh open on retry.
        assert!(monica.executions().list_claude_sessions(&daemon).unwrap().is_empty());
    }
}

#[test]
fn facade_open_sdk_session_unconfirmed_launch_write_is_indeterminate_and_keeps_the_reservation() {
    // The launch write is an acknowledged round trip and the daemon writes into the PTY
    // before answering: here the bytes landed but the ack was lost, and the follow-up
    // kill could not be confirmed either (the connection died mid-open). Claude may be
    // starting, so a determinate error — which licenses a fresh-id retry — would risk a
    // duplicate session; the outcome must stay unknown with the id recoverable.
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::losing_write_ack();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let id = "5e0f5b0e-9f5c-4a4e-9d6e-000000000309";

    let err = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params_with_id(&cwd, id))
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Indeterminate(_)), "got: {err:?}");
    assert!(err.to_string().contains(id), "the retry key must be named: {err}");
    assert_eq!(daemon.written.lock().unwrap().len(), 1, "the launch bytes were delivered");
    assert!(!sink
        .events()
        .iter()
        .any(|e| matches!(e, ApplicationEvent::SdkSessionOpened { .. })));

    // Nothing was force-failed (that would end the mapping via the coupled transition):
    // the reservation survives as pending, so a same-id retry stays idempotent —
    // still indeterminate, and never a second spawn.
    let session_id = daemon.created.lock().unwrap()[0].session_id.clone();
    daemon.seed_running_view(&session_id);
    let sessions = monica.executions().list_claude_sessions(&daemon).unwrap();
    let mapping = sessions.iter().find(|cs| cs.claude_session_id == id).unwrap();
    assert_eq!(mapping.status, monica_domain::ClaudeSessionStatus::Pending);
    let retry = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params_with_id(&cwd, id))
        .unwrap_err();
    assert!(matches!(retry, ApplicationError::Indeterminate(_)), "got: {retry:?}");
    assert_eq!(daemon.created.lock().unwrap().len(), 1, "must not respawn");
}

#[test]
fn facade_open_sdk_session_unconfirmed_kill_after_confirm_failure_is_indeterminate() {
    // The launch was submitted and acknowledged; only the pending→active confirmation
    // write failed, and the kill could not be confirmed either. Claude is likely
    // running: the reservation must survive and the outcome stays unknown.
    let repos = FakeRepos::default();
    repos.fail_mark_claude_launched();
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());
    let daemon = FakeDaemon::failing_terminate();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let id = "5e0f5b0e-9f5c-4a4e-9d6e-000000000309";

    let err = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params_with_id(&cwd, id))
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Indeterminate(_)), "got: {err:?}");
    assert!(err.to_string().contains(id), "the retry key must be named: {err}");
    let session_id = daemon.created.lock().unwrap()[0].session_id.clone();
    daemon.seed_running_view(&session_id);
    let sessions = monica.executions().list_claude_sessions(&daemon).unwrap();
    let mapping = sessions.iter().find(|cs| cs.claude_session_id == id).unwrap();
    assert_eq!(mapping.status, monica_domain::ClaudeSessionStatus::Pending);
}

#[test]
fn facade_open_sdk_session_with_id_pending_reservation_is_indeterminate() {
    let repos = FakeRepos::default();
    let id = "5e0f5b0e-9f5c-4a4e-9d6e-000000000309";
    // A reservation between commit and launch confirmation: either a concurrent open is
    // mid-flight right now (a timeout retry can race it) or one was interrupted. The id
    // must be refused — but as an indeterminate outcome, because a determinate error
    // tells the SDK "nothing was created" and licenses a fresh-id retry that would
    // duplicate the session the in-flight open is about to confirm.
    repos.seed_claude_session(monica_domain::ClaudeSession {
        claude_session_id: id.to_string(),
        runspace_id: "sdk".to_string(),
        tab_id: "tab-sdk-1".to_string(),
        terminal_session_id: "ts-1".to_string(),
        cwd: "/tmp".to_string(),
        name: None,
        status: monica_domain::ClaudeSessionStatus::Pending,
        created_at: "2026-06-02T00:00:00.000Z".to_string(),
        ended_at: None,
    });
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    // The terminal row exists and its PTY is alive, so reconcile keeps the row pending.
    let new = NewTerminalSession {
        runspace_id: Some("sdk".to_string()),
        tab_id: Some("tab-sdk-1".to_string()),
        kind: TerminalSessionKind::Agent,
        cwd: "/tmp".to_string(),
        shell: "/bin/zsh".to_string(),
        rows: 24,
        cols: 80,
    };
    let ts = monica.executions().create_terminal_session(&daemon, new, Vec::new()).unwrap();
    assert_eq!(ts.id, "ts-1");
    daemon.seed_running_view("ts-1");
    let created_before = daemon.created.lock().unwrap().len();

    let err = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params_with_id(&cwd, id))
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Indeterminate(_)), "got: {err:?}");
    assert_eq!(daemon.created.lock().unwrap().len(), created_before, "must not respawn");
    // The reservation stays untouched: once the in-flight open confirms the launch, a
    // same-id retry resolves to that session.
    let sessions = monica.executions().list_claude_sessions(&daemon).unwrap();
    let mapping = sessions.iter().find(|cs| cs.claude_session_id == id).unwrap();
    assert_eq!(mapping.status, monica_domain::ClaudeSessionStatus::Pending);
}

#[test]
fn facade_open_sdk_session_with_id_recovers_running_session_without_respawn() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let id = "5e0f5b0e-9f5c-4a4e-9d6e-000000000309";

    let first = monica.executions().open_sdk_session(&daemon, sdk_params_with_id(&cwd, id)).unwrap();
    assert_eq!(first.claude_session_id, id);

    // The retry finds the mapping, verifies the PTY is alive, and answers with the same
    // session instead of spawning a second one.
    daemon.seed_running_view(&first.session_id);
    let second =
        monica.executions().open_sdk_session(&daemon, sdk_params_with_id(&cwd, id)).unwrap();

    assert_eq!(second.session_id, first.session_id);
    assert_eq!(second.tab_id, first.tab_id);
    assert_eq!(second.claude_session_id, id);
    assert_eq!(second.cwd, first.cwd);
    assert_eq!(daemon.created.lock().unwrap().len(), 1);
    assert_eq!(daemon.written.lock().unwrap().len(), 1);
    // Re-announced so a Workbench that missed the first event can adopt now.
    let announcements = sink
        .events()
        .iter()
        .filter(|e| matches!(e, ApplicationEvent::SdkSessionOpened { .. }))
        .count();
    assert_eq!(announcements, 2);
}

#[test]
fn facade_open_sdk_session_with_id_rejects_ended_session() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let id = "5e0f5b0e-9f5c-4a4e-9d6e-000000000309";

    let first = monica.executions().open_sdk_session(&daemon, sdk_params_with_id(&cwd, id)).unwrap();
    monica.executions().record_terminal_exit(&first.session_id, Some(0)).unwrap();

    let err = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params_with_id(&cwd, id))
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "got: {err:?}");
    assert_eq!(daemon.created.lock().unwrap().len(), 1, "an ended id must never respawn");
}

#[test]
fn facade_open_sdk_session_with_id_dead_pty_ends_mapping_and_errors() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let id = "5e0f5b0e-9f5c-4a4e-9d6e-000000000309";

    let first = monica.executions().open_sdk_session(&daemon, sdk_params_with_id(&cwd, id)).unwrap();

    // No seeded view: the daemon does not know the session, so the recovery's liveness
    // check demotes it to Lost, which ends the mapping — and the open refuses.
    let err = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params_with_id(&cwd, id))
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "got: {err:?}");
    assert_eq!(daemon.created.lock().unwrap().len(), 1);
    let sessions = monica.executions().list_claude_sessions(&daemon).unwrap();
    let mapping = sessions.iter().find(|cs| cs.claude_session_id == id).unwrap();
    assert_eq!(mapping.status, monica_domain::ClaudeSessionStatus::Ended);
    assert_eq!(mapping.terminal_session_id, first.session_id);
}

#[test]
fn facade_open_sdk_session_with_id_missing_terminal_row_ends_mapping_and_errors() {
    let repos = FakeRepos::default();
    let id = "5e0f5b0e-9f5c-4a4e-9d6e-000000000309";
    // The mapping row survived but its terminal row is gone — the inconsistency the
    // schema's no-FK design leaves to the recovery path to settle.
    repos.seed_claude_session(monica_domain::ClaudeSession {
        claude_session_id: id.to_string(),
        runspace_id: "sdk".to_string(),
        tab_id: "tab-sdk-1".to_string(),
        terminal_session_id: "ts-404".to_string(),
        cwd: "/tmp".to_string(),
        name: None,
        status: monica_domain::ClaudeSessionStatus::Active,
        created_at: "2026-06-02T00:00:00.000Z".to_string(),
        ended_at: None,
    });
    let sink = RecordingSink::default();
    let mut monica = facade(repos, sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let err = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params_with_id(&cwd, id))
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "got: {err:?}");
    assert!(daemon.created.lock().unwrap().is_empty(), "must not respawn under this id");
    let sessions = monica.executions().list_claude_sessions(&daemon).unwrap();
    let mapping = sessions.iter().find(|cs| cs.claude_session_id == id).unwrap();
    assert_eq!(mapping.status, monica_domain::ClaudeSessionStatus::Ended);
}

#[test]
fn facade_open_sdk_session_with_unknown_id_opens_fresh_under_that_id() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let id = "5e0f5b0e-9f5c-4a4e-9d6e-000000000309";

    let spec = monica.executions().open_sdk_session(&daemon, sdk_params_with_id(&cwd, id)).unwrap();

    assert_eq!(spec.claude_session_id, id);
    assert_eq!(spec.initial_command, format!("claude --session-id {id} --model 'opus'"));
    assert_eq!(daemon.created.lock().unwrap().len(), 1);
}

#[test]
fn facade_open_sdk_session_rejects_non_uuid_id() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let err = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params_with_id(&cwd, "$(rm -rf /)"))
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "got: {err:?}");
    assert!(daemon.created.lock().unwrap().is_empty());
    assert!(sink.events().is_empty());
}

#[test]
fn facade_open_sdk_session_with_id_unreachable_daemon_errors_without_respawn() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::failing_list();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let id = "5e0f5b0e-9f5c-4a4e-9d6e-000000000309";

    let first = monica.executions().open_sdk_session(&daemon, sdk_params_with_id(&cwd, id)).unwrap();

    // Liveness cannot be verified, so the retry must not guess: no error-driven respawn,
    // no silent success — and the failure is indeterminate, because the session may well
    // be running and a determinate error would license a duplicating fresh-id retry.
    let err = monica
        .executions()
        .open_sdk_session(&daemon, sdk_params_with_id(&cwd, id))
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Indeterminate(_)), "got: {err:?}");
    assert_eq!(daemon.created.lock().unwrap().len(), 1);
    assert!(!daemon.terminated.lock().unwrap().contains(&first.session_id));
}

#[test]
fn facade_list_claude_sessions_fails_closed_when_daemon_unreachable() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let spec = monica.executions().open_sdk_session(&daemon, sdk_params(&cwd)).unwrap();

    // Startup recovery adopts rows still `active` as live Workbench tabs, so an
    // unverifiable daemon must error instead of serving DB-only state as verified —
    // a stale `active` mapping would otherwise materialize as a tab.
    let unreachable = FakeDaemon::failing_list();
    let err = monica.executions().list_claude_sessions(&unreachable).unwrap_err();
    assert!(matches!(err, ApplicationError::External(_)), "got: {err:?}");

    // Nothing was reconciled blindly either way: with the daemon back, the row still
    // resolves by a real liveness check.
    daemon.seed_running_view(&spec.session_id);
    let sessions = monica.executions().list_claude_sessions(&daemon).unwrap();
    let mapping =
        sessions.iter().find(|cs| cs.claude_session_id == spec.claude_session_id).unwrap();
    assert_eq!(mapping.status, monica_domain::ClaudeSessionStatus::Active);
}

#[test]
fn facade_list_claude_sessions_reconciles_liveness_before_answering() {
    let sink = RecordingSink::default();
    let mut monica = facade(FakeRepos::default(), sink.clone());
    let daemon = FakeDaemon::default();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let dead = monica.executions().open_sdk_session(&daemon, sdk_params(&cwd)).unwrap();
    let alive = monica.executions().open_sdk_session(&daemon, sdk_params(&cwd)).unwrap();
    daemon.seed_running_view(&alive.session_id);

    let sessions = monica.executions().list_claude_sessions(&daemon).unwrap();

    let by_id = |id: &str| sessions.iter().find(|cs| cs.claude_session_id == id).unwrap();
    // The unlisted PTY reconciles to Lost, which ends its mapping in the same pass.
    assert_eq!(by_id(&dead.claude_session_id).status, monica_domain::ClaudeSessionStatus::Ended);
    assert_eq!(by_id(&alive.claude_session_id).status, monica_domain::ClaudeSessionStatus::Active);
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
