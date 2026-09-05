use monica_application::{
    EventRepository, ExecutionProfile, GithubPullRequest, GithubPullRequestStatus,
    ProjectRepository, PullRequestBranchSyncCandidate, TabAttachment, TaskBoardQuery,
    TaskRunObservation,
    TaskRunStore, TaskStore, TaskSummaryFilter, TaskSummaryRow, TerminalRunspaceRow,
    TerminalSessionUpdate, TerminalStateSnapshot, TerminalTabRow, UnitOfWork, WorkbenchStore,
};
use monica_domain::{
    Agent, AgentSessionId, DisplayStatus, ExternalReference, NewTask, NewTaskRun,
    NewTerminalSession, Project, Provider, RawJson, RefType, RunspaceId, TaskId, TaskKind,
    TaskRun, TaskRunId, TaskRunStatus, TaskRunWaitReason, TaskStatus, TerminalSessionKind,
    TerminalSessionStatus,
};
use rusqlite::params;
use serde_json::json;

use super::SqliteStore;

fn tid(id: &str) -> TaskId {
    TaskId::from_store(id.to_string())
}

fn rid(id: &str) -> TaskRunId {
    TaskRunId::from_store(id.to_string())
}

fn rsid(id: &str) -> RunspaceId {
    RunspaceId::from_store(id.to_string())
}

/// The domain carries `details`/`source`/`metadata`/`payload` as opaque [`RawJson`] text; the store
/// must persist and reload that text verbatim (no JSON re-encoding). Guards the read/write path in
/// `row.rs` and `store/*` against a regression to `serde_json::from_str`/`to_string`, which would
/// double-encode or fail on a bare JSON object.
#[test]
fn raw_json_columns_survive_sqlite_round_trip() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let mut task = dev_task("with raw json");
    task.details = RawJson(r#"{"github_url":"https://example.com/x"}"#.to_string());
    task.source = Some(RawJson(r#"{"ref":"owner/repo#1"}"#.to_string()));
    let task = db.insert_task(task).unwrap();

    let loaded = db.get_task(&task.id).unwrap().unwrap();
    assert_eq!(
        loaded.details.as_str(),
        r#"{"github_url":"https://example.com/x"}"#
    );
    assert_eq!(loaded.source.unwrap().as_str(), r#"{"ref":"owner/repo#1"}"#);

    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    let metadata = json!({ "hook_event_name": "PreToolUse", "nested": { "n": 2 } }).to_string();
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: Some(None),
            event_label: Some("PreToolUse"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: None,
            terminal_tab_id: None,
            metadata_raw: Some(&metadata),
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    let loaded_run = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(loaded_run.metadata.as_str(), metadata);

    let payload = json!({ "tool_name": "ExitPlanMode" }).to_string();
    db.insert_event(Some(&task.id), None, "PreToolUse", &payload)
        .unwrap();
    let events = db.list_events(Some(&task.id)).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].payload.as_str(), payload);
}

fn dev_task(title: &str) -> NewTask {
    NewTask::new(TaskKind::Development, title)
}

fn project_task_with_branch(
    db: &mut SqliteStore,
    repo: &str,
    default_branch: &str,
    branch: &str,
) -> (TaskId, PullRequestBranchSyncCandidate) {
    let mut project = Project::from_repo(repo);
    project.default_branch = default_branch.to_string();
    db.upsert_project(&project, &ExecutionProfile::default()).unwrap();
    let mut task = dev_task("branch backed");
    task.project_id = Some(project.id.clone());
    let item = db.insert_task(task).unwrap();
    db.start_task_run(NewTaskRun {
        task_id: item.id.clone(),
        agent: None,
        branch: Some(branch.to_string()),
        worktree_path: None,
    })
    .unwrap();
    (
        item.id.clone(),
        PullRequestBranchSyncCandidate {
            task_id: item.id.to_string(),
            repo: repo.to_string(),
            branch: branch.to_string(),
        },
    )
}

#[test]
fn task_and_external_ref_round_trip_through_sqlite_repository() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let mut task = dev_task("tracked issue");
    task.status = TaskStatus::Ready;
    let item = db
        .insert_task_with_ref(
            task,
            ExternalReference::new(
                "",
                Provider::Github,
                RefType::Issue,
                Some("owner/repo".to_string()),
                Some(42),
                Some("https://github.com/owner/repo/issues/42".to_string()),
            ),
        )
        .unwrap();

    assert_eq!(item.id, "MON-1");
    assert_eq!(item.status, TaskStatus::Ready);
    let refs = db.list_external_refs(&item.id).unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].provider, Provider::Github);
    assert_eq!(refs[0].ref_type, RefType::Issue);
    assert_eq!(refs[0].number, Some(42));
}

fn track_issue(db: &mut SqliteStore, title: &str, repo: &str, number: i64) -> TaskId {
    db.insert_task_with_ref(
        dev_task(title),
        ExternalReference::new(
            "",
            Provider::Github,
            RefType::Issue,
            Some(repo.to_string()),
            Some(number),
            None,
        ),
    )
    .unwrap()
    .id
}

fn find_open_issue_task(db: &SqliteStore, repo: &str, number: i64) -> Option<TaskId> {
    db.find_open_task_by_external_ref(Provider::Github, RefType::Issue, repo, number)
        .unwrap()
        .map(|t| t.id)
}

#[test]
fn find_open_task_by_external_ref_returns_the_newest_open_match() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    // Ten duplicates so the newest id is MON-10, which sorts *before* MON-9 as text: the tie-break
    // must compare the counter numerically.
    let ids: Vec<TaskId> = (1..=10)
        .map(|i| track_issue(&mut db, &format!("dup {i}"), "owner/repo", 42))
        .collect();
    assert_eq!(ids.last().unwrap().as_str(), "MON-10");

    assert_eq!(find_open_issue_task(&db, "owner/repo", 42), Some(ids[9].clone()));

    db.mark_task_closed(&ids[9]).unwrap();
    assert_eq!(
        find_open_issue_task(&db, "owner/repo", 42),
        Some(ids[8].clone()),
        "closing the newest falls back to the next open one"
    );
}

#[test]
fn find_open_task_by_external_ref_skips_closed_tasks() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let id = track_issue(&mut db, "tracked", "owner/repo", 42);
    db.mark_task_closed(&id).unwrap();

    assert_eq!(
        find_open_issue_task(&db, "owner/repo", 42),
        None,
        "a closed task must not shadow a fresh attempt at the same issue"
    );
}

#[test]
fn find_open_task_by_external_ref_matches_provider_ref_type_repo_and_number() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let id = track_issue(&mut db, "tracked", "owner/repo", 42);
    let pr_task = db
        .insert_task_with_ref(
            dev_task("a pull request, not an issue"),
            ExternalReference::new(
                "",
                Provider::Github,
                RefType::PullRequest,
                Some("owner/repo".to_string()),
                Some(7),
                None,
            ),
        )
        .unwrap();

    assert_eq!(find_open_issue_task(&db, "owner/repo", 42), Some(id));
    assert_eq!(find_open_issue_task(&db, "owner/other", 42), None, "repo must match");
    assert_eq!(find_open_issue_task(&db, "owner/repo", 43), None, "number must match");
    assert_eq!(
        find_open_issue_task(&db, "owner/repo", 7),
        None,
        "a pull-request ref must not answer an issue lookup"
    );
    assert!(db.get_task(&pr_task.id).unwrap().is_some());
}

#[test]
fn list_external_refs_errors_on_unrecognized_provider() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("t")).unwrap();
    db.conn()
        .execute(
            "INSERT INTO external_refs (task_id, provider, ref_type, repo, number)
             VALUES (?1, 'gitlab', 'issue', 'o/r', 1)",
            params![task.id.as_str()],
        )
        .unwrap();
    assert!(
        db.list_external_refs(&task.id).is_err(),
        "an unrecognized provider string must surface as an error, not a silent misread"
    );
}

#[test]
fn task_summaries_expose_the_stored_issue_url() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let item = db
        .insert_task_with_ref(
            dev_task("tracked issue"),
            ExternalReference::new(
                "",
                Provider::Github,
                RefType::Issue,
                Some("owner/repo".to_string()),
                Some(42),
                Some("https://github.com/owner/repo/issues/42".to_string()),
            ),
        )
        .unwrap();

    // A legacy issue ref whose URL column was never populated: the backend synthesizes it from
    // repo+number so the Work Board badge stays clickable.
    let legacy = db
        .insert_task_with_ref(
            dev_task("legacy issue"),
            ExternalReference::new(
                "",
                Provider::Github,
                RefType::Issue,
                Some("owner/repo".to_string()),
                Some(7),
                None,
            ),
        )
        .unwrap();

    let summaries = db.list_task_summaries(TaskSummaryFilter::All, None).unwrap();
    let summary = summaries.iter().find(|s| s.id == item.id.as_str()).unwrap();
    assert_eq!(summary.github_issue_number, Some(42));
    assert_eq!(
        summary.github_issue_url.as_deref(),
        Some("https://github.com/owner/repo/issues/42")
    );
    let legacy_summary = summaries.iter().find(|s| s.id == legacy.id.as_str()).unwrap();
    assert_eq!(
        legacy_summary.github_issue_url.as_deref(),
        Some("https://github.com/owner/repo/issues/7"),
        "a stored-URL-less issue ref must fall back to the synthesized canonical URL"
    );
}

#[test]
fn task_run_agent_is_typed_and_closed_task_is_not_regressed_by_finish() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("run me")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: Some(Agent::Claude),
            branch: Some("issue-42".to_string()),
            worktree_path: Some("/tmp/worktree".to_string()),
        })
        .unwrap();
    assert_eq!(run.agent, Some(Agent::Claude));

    db.mark_task(&task.id, TaskStatus::Closed, None).unwrap();
    db.finish_task_run(&run.id, &task.id, TaskRunStatus::Running)
        .unwrap();
    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().status,
        TaskStatus::Closed
    );
}

#[test]
fn task_run_observation_records_wait_reason_and_event_metadata() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("observe me")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    let metadata = json!({ "hook_event_name": "PreToolUse" }).to_string();
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::WaitingForUser),
            wait_reason: Some(Some(TaskRunWaitReason::AskUserQuestion)),
            event_label: Some("PreToolUse"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("provider-session")),
            terminal_tab_id: Some("tab-1"),
            metadata_raw: Some(&metadata),
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();

    let run = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AskUserQuestion));
    assert_eq!(run.agent_session_id.as_deref(), Some("provider-session"));
    assert_eq!(run.terminal_tab_id.as_deref(), Some("tab-1"));
}

#[test]
fn task_run_observation_retains_plan_file_path_across_later_hooks() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("plan me")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    assert_eq!(db.get_task_run(&run.id).unwrap().unwrap().plan_file_path, None);

    // The decoder extracts the plan file from an ExitPlanMode payload; the store records it.
    let plan_observation = |path: Option<&'static str>, at: &'static str| TaskRunObservation {
        status: Some(TaskRunStatus::WaitingForUser),
        wait_reason: Some(Some(TaskRunWaitReason::ExitPlanMode)),
        event_label: Some("PreToolUse"),
        at,
        agent_session_id: None,
        terminal_tab_id: None,
        metadata_raw: None,
        plan_file_path: path,
        hold_stop: false,
        release_stop: false,
    };

    db.record_task_run_observation(
        &run.id,
        plan_observation(Some("/Users/me/.claude/plans/hazy-wiggling-salamander.md"), "2026-06-02T00:00:00.000Z"),
    )
    .unwrap();
    assert_eq!(
        db.get_task_run(&run.id).unwrap().unwrap().plan_file_path.as_deref(),
        Some("/Users/me/.claude/plans/hazy-wiggling-salamander.md")
    );

    // Approving the plan fires a payload without a planFilePath (decoded `plan_file_path: None`);
    // the COALESCE must keep the recorded path.
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: Some(None),
            event_label: Some("UserPromptSubmit"),
            at: "2026-06-02T00:01:00.000Z",
            agent_session_id: None,
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    let run = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Running);
    assert_eq!(
        run.plan_file_path.as_deref(),
        Some("/Users/me/.claude/plans/hazy-wiggling-salamander.md")
    );

    // An empty planFilePath decodes to `None`, so it must not clobber the stored path.
    db.record_task_run_observation(&run.id, plan_observation(None, "2026-06-02T00:01:30.000Z"))
        .unwrap();
    assert_eq!(
        db.get_task_run(&run.id).unwrap().unwrap().plan_file_path.as_deref(),
        Some("/Users/me/.claude/plans/hazy-wiggling-salamander.md")
    );

    // A fresh plan replaces it with the newer path.
    db.record_task_run_observation(
        &run.id,
        plan_observation(Some("/Users/me/.claude/plans/brave-soaring-otter.md"), "2026-06-02T00:02:00.000Z"),
    )
    .unwrap();
    assert_eq!(
        db.get_task_run(&run.id).unwrap().unwrap().plan_file_path.as_deref(),
        Some("/Users/me/.claude/plans/brave-soaring-otter.md")
    );
}

/// Hooks run in separate processes, so the snapshot check in `record_claude_hook` cannot be
/// trusted alone: these cases bypass it and hit the store directly, proving the UPDATE itself
/// refuses the protected transitions.
#[test]
fn task_run_observation_sql_guards_protected_transitions() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("guarded")).unwrap();
    let start_run = |db: &mut SqliteStore| {
        db.start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap()
    };
    let generic_wait = TaskRunObservation {
        status: Some(TaskRunStatus::WaitingForUser),
        wait_reason: Some(Some(TaskRunWaitReason::AwaitingPrompt)),
        event_label: Some("Stop"),
        at: "2026-06-02T00:00:00.000Z",
        agent_session_id: None,
        terminal_tab_id: None,
        metadata_raw: None,
        plan_file_path: None,
        hold_stop: false,
        release_stop: false,
    };

    // A late Stop must not resurrect a stopped run.
    let stopped = start_run(&mut db);
    db.finish_task_run(&stopped.id, &task.id, TaskRunStatus::Stopped)
        .unwrap();
    db.record_task_run_observation(&stopped.id, generic_wait)
        .unwrap();
    let run = db.get_task_run(&stopped.id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Stopped);
    assert_eq!(run.wait_reason, None);
    // The event itself is still recorded.
    assert_eq!(run.last_event_name.as_deref(), Some("Stop"));

    // A trailing Stop must not blur a tool-specific wait into a generic one.
    for reason in [
        TaskRunWaitReason::AskUserQuestion,
        TaskRunWaitReason::ExitPlanMode,
    ] {
        let asking = start_run(&mut db);
        db.record_task_run_observation(
            &asking.id,
            TaskRunObservation {
                status: Some(TaskRunStatus::WaitingForUser),
                wait_reason: Some(Some(reason)),
                event_label: Some("PreToolUse"),
                at: "2026-06-02T00:00:00.000Z",
                agent_session_id: None,
                terminal_tab_id: None,
                metadata_raw: None,
                plan_file_path: None,
                hold_stop: false,
                release_stop: false,
            },
        )
        .unwrap();
        db.record_task_run_observation(&asking.id, generic_wait)
            .unwrap();
        let run = db.get_task_run(&asking.id).unwrap().unwrap();
        assert_eq!(run.status, TaskRunStatus::WaitingForUser, "{reason:?}");
        assert_eq!(run.wait_reason, Some(reason), "{reason:?}");
    }

    // The generic-wait guard is session-scoped: the dead session's own late Stop is refused,
    // while a relaunched (never-seen) session's start revives the run.
    let relaunched = start_run(&mut db);
    db.record_task_run_observation(
        &relaunched.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: None,
            event_label: Some("UserPromptSubmit"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-old")),
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    db.finish_task_run(&relaunched.id, &task.id, TaskRunStatus::Stopped)
        .unwrap();
    fn generic_wait_from<'a>(
        session: &'a AgentSessionId,
        event: &'static str,
    ) -> TaskRunObservation<'a> {
        TaskRunObservation {
            status: Some(TaskRunStatus::WaitingForUser),
            wait_reason: Some(Some(TaskRunWaitReason::AwaitingPrompt)),
            event_label: Some(event),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(session),
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        }
    }
    db.record_task_run_observation(&relaunched.id, generic_wait_from(&AgentSessionId::from_agent("sess-old"), "Stop"))
        .unwrap();
    assert_eq!(
        db.get_task_run(&relaunched.id).unwrap().unwrap().status,
        TaskRunStatus::Stopped
    );
    db.record_task_run_observation(
        &relaunched.id,
        generic_wait_from(&AgentSessionId::from_agent("sess-new"), "SessionStart"),
    )
    .unwrap();
    let run = db.get_task_run(&relaunched.id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    assert_eq!(run.agent_session_id.as_deref(), Some("sess-new"));

    // A real prompt does revive a stopped run: only the generic wait is refused.
    let revived = start_run(&mut db);
    db.finish_task_run(&revived.id, &task.id, TaskRunStatus::Stopped)
        .unwrap();
    db.record_task_run_observation(
        &revived.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: Some(None),
            event_label: Some("UserPromptSubmit"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: None,
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    assert_eq!(
        db.get_task_run(&revived.id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );

    // A terminal verdict is scoped to the session that died: a stale SessionEnd from the
    // previous session must not kill the run its successor now drives, while the successor's
    // own verdict (or an anonymous one) still lands.
    fn terminal_verdict_from<'a>(
        session: Option<&'a AgentSessionId>,
        status: TaskRunStatus,
        event: &'static str,
    ) -> TaskRunObservation<'a> {
        TaskRunObservation {
            status: Some(status),
            wait_reason: Some(None),
            event_label: Some(event),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: session,
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        }
    }
    for (status, event) in [(TaskRunStatus::Stopped, "SessionEnd")] {
        let survivor = start_run(&mut db);
        db.record_task_run_observation(
            &survivor.id,
            TaskRunObservation {
                status: Some(TaskRunStatus::Running),
                wait_reason: None,
                event_label: Some("UserPromptSubmit"),
                at: "2026-06-02T00:00:00.000Z",
                agent_session_id: Some(&AgentSessionId::from_agent("sess-new")),
                terminal_tab_id: None,
                metadata_raw: None,
                plan_file_path: None,
                hold_stop: false,
                release_stop: false,
            },
        )
        .unwrap();
        // Two stragglers in a row: the first must not re-stamp sess-old onto the run, or the
        // second would look same-session and land.
        for _ in 0..2 {
            db.record_task_run_observation(
                &survivor.id,
                terminal_verdict_from(Some(&AgentSessionId::from_agent("sess-old")), status, event),
            )
            .unwrap();
            let run = db.get_task_run(&survivor.id).unwrap().unwrap();
            assert_eq!(run.status, TaskRunStatus::Running, "{event}");
            assert_eq!(run.agent_session_id.as_deref(), Some("sess-new"), "{event}");
        }
        db.record_task_run_observation(
            &survivor.id,
            terminal_verdict_from(Some(&AgentSessionId::from_agent("sess-new")), status, event),
        )
        .unwrap();
        assert_eq!(
            db.get_task_run(&survivor.id).unwrap().unwrap().status,
            status,
            "{event}"
        );
    }
    let anon_settled = start_run(&mut db);
    db.record_task_run_observation(
        &anon_settled.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: None,
            event_label: Some("UserPromptSubmit"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-new")),
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    db.record_task_run_observation(
        &anon_settled.id,
        terminal_verdict_from(None, TaskRunStatus::Stopped, "SessionEnd"),
    )
    .unwrap();
    assert_eq!(
        db.get_task_run(&anon_settled.id).unwrap().unwrap().status,
        TaskRunStatus::Stopped
    );
}

/// Records a typed observation against the store, the way `record_hook` would after the domain has
/// decided `hold_stop`/`release_stop` (the subagent guard derivation itself is covered by the
/// decoder's tests). The store still enforces the `pending_stop` SQL CASE from these flags.
fn record_observation(
    db: &mut SqliteStore,
    run_id: &TaskRunId,
    event: &str,
    status: Option<TaskRunStatus>,
    hold_stop: bool,
    release_stop: bool,
) {
    db.record_task_run_observation(
        run_id,
        TaskRunObservation {
            status,
            wait_reason: status.map(|s| match s {
                TaskRunStatus::WaitingForUser => Some(TaskRunWaitReason::AwaitingPrompt),
                _ => None,
            }),
            event_label: Some(event),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-1")),
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop,
            release_stop,
        },
    )
    .unwrap();
}

fn running_task_run(db: &mut SqliteStore, title: &str) -> TaskRun {
    let task = db.insert_task(dev_task(title)).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    record_observation(db, &run.id, "UserPromptSubmit", Some(TaskRunStatus::Running), false, false);
    run
}

/// The store derives the subagent guard from each event's `background_tasks` — the authoritative,
/// always-present list — not a counter. A Stop whose snapshot still lists a running subagent is
/// held `Running` (`record_hook` passes `status: None` for the suppressed transition); a Stop with
/// an empty snapshot settles the turn. Exercises the SQL guard directly, since hooks land
/// out-of-process and the caller's snapshot check is only advisory.
#[test]
fn task_run_observation_holds_stop_while_background_tasks_run() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let run = running_task_run(&mut db, "subagent");
    let snapshot = |db: &SqliteStore| db.get_task_run(&run.id).unwrap().unwrap();

    // A held Stop (subagent in flight) keeps the run Running and sets pending_stop.
    record_observation(&mut db, &run.id, "Stop", None, true, false);
    let s = snapshot(&db);
    assert_eq!(s.status, TaskRunStatus::Running);
    assert_eq!(s.wait_reason, None);
    assert!(s.pending_stop);
    assert_eq!(s.last_event_name.as_deref(), Some("Stop"));

    // A normal turn end (no subagent) demotes — the guard never pins the run open forever.
    record_observation(&mut db, &run.id, "Stop", Some(TaskRunStatus::WaitingForUser), false, false);
    let s = snapshot(&db);
    assert_eq!(s.status, TaskRunStatus::WaitingForUser);
    assert_eq!(s.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    assert!(!s.pending_stop);
}

/// A held Stop is released by the `SubagentStop` that leaves nothing in flight, firing the deferred
/// `Stop → WaitingForUser` transition atomically. The snapshot is pre-stop, so it still lists the
/// stopping agent (excluded by `agent_id`); a start-less stop whose agent is absent from the
/// snapshot must not release the hold while a real subagent is still running.
#[test]
fn task_run_observation_deferred_stop_fires_on_releasing_subagent_stop() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let run = running_task_run(&mut db, "deferred stop");
    let snapshot = |db: &SqliteStore| db.get_task_run(&run.id).unwrap().unwrap();

    // Two subagents in flight: the Stop is held.
    record_observation(&mut db, &run.id, "Stop", None, true, false);
    assert_eq!(snapshot(&db).status, TaskRunStatus::Running);
    assert!(snapshot(&db).pending_stop);

    // A start-less SubagentStop whose agent is absent from the snapshot leaves others running, so
    // the decoder reports subagents still in flight: no release.
    record_observation(&mut db, &run.id, "SubagentStop", None, false, false);
    assert_eq!(snapshot(&db).status, TaskRunStatus::Running);
    assert!(snapshot(&db).pending_stop);

    // `a` stops while `b` still runs: still held (no release).
    record_observation(&mut db, &run.id, "SubagentStop", None, false, false);
    assert_eq!(snapshot(&db).status, TaskRunStatus::Running);

    // `b` stops, leaving nothing in flight: the deferred stop fires.
    record_observation(&mut db, &run.id, "SubagentStop", None, false, true);
    let s = snapshot(&db);
    assert_eq!(s.status, TaskRunStatus::WaitingForUser);
    assert_eq!(s.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    assert!(!s.pending_stop);
}

/// `pending_stop` is cleared by a real turn boundary (UserPromptSubmit) and by terminal settlement
/// (SessionEnd), so a held Stop whose subagent never reports a stop cannot strand the flag.
#[test]
fn task_run_observation_pending_stop_cleared_by_boundary_and_settlement() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let run = running_task_run(&mut db, "pending clear");
    let snapshot = |db: &SqliteStore| db.get_task_run(&run.id).unwrap().unwrap();

    record_observation(&mut db, &run.id, "Stop", None, true, false);
    assert!(snapshot(&db).pending_stop);
    record_observation(&mut db, &run.id, "UserPromptSubmit", Some(TaskRunStatus::Running), false, false);
    assert!(!snapshot(&db).pending_stop);

    record_observation(&mut db, &run.id, "Stop", None, true, false);
    assert!(snapshot(&db).pending_stop);
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Stopped),
            wait_reason: Some(None),
            event_label: Some("SessionEnd"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-1")),
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    let s = snapshot(&db);
    assert_eq!(s.status, TaskRunStatus::Stopped);
    assert!(!s.pending_stop);
}

#[test]
fn task_run_observation_keeps_existing_tab_and_session_on_none() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("keep tab")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: None,
            event_label: Some("SessionStart"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-1")),
            terminal_tab_id: Some("tab-1"),
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Stopped),
            wait_reason: None,
            event_label: Some("Stop"),
            at: "2026-06-02T00:00:01.000Z",
            agent_session_id: None,
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();

    let run = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(run.agent_session_id.as_deref(), Some("sess-1"));
    assert_eq!(run.terminal_tab_id.as_deref(), Some("tab-1"));
}

#[test]
fn find_task_run_by_terminal_tab_returns_latest_observed_run_in_tab() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("tab lookup")).unwrap();
    let observe = |db: &mut SqliteStore, run_id: &TaskRunId, session: &str, at: &str| {
        db.record_task_run_observation(
            run_id,
            TaskRunObservation {
                status: Some(TaskRunStatus::Running),
                wait_reason: None,
                event_label: Some("SessionStart"),
                at,
                agent_session_id: Some(&AgentSessionId::from_agent(session)),
                terminal_tab_id: Some("tab-1"),
                metadata_raw: None,
                plan_file_path: None,
                hold_stop: false,
                release_stop: false,
            },
        )
        .unwrap();
    };
    let new_run = NewTaskRun {
        task_id: task.id.clone(),
        agent: None,
        branch: None,
        worktree_path: None,
    };
    let first = db.start_task_run(new_run.clone()).unwrap();
    observe(&mut db, &first.id, "sess-1", "2026-06-02T00:00:00.000Z");
    let second = db.start_task_run(new_run).unwrap();
    observe(&mut db, &second.id, "sess-2", "2026-06-02T00:00:00.000Z");

    let found = db.find_task_run_by_terminal_tab("tab-1").unwrap().unwrap();
    assert_eq!(found.id, second.id);
    assert!(db.find_task_run_by_terminal_tab("tab-x").unwrap().is_none());

    // Resuming the older run's session in the tab makes it the latest observed there.
    observe(&mut db, &first.id, "sess-1", "2026-06-02T00:00:05.000Z");
    let found = db.find_task_run_by_terminal_tab("tab-1").unwrap().unwrap();
    assert_eq!(found.id, first.id);
}

#[test]
fn start_task_run_never_reopens_a_closed_task() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("closed stays closed")).unwrap();
    db.update_task_status(&task.id, TaskStatus::Closed).unwrap();

    db.start_task_run(NewTaskRun {
        task_id: task.id.clone(),
        agent: None,
        branch: None,
        worktree_path: None,
    })
    .unwrap();

    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().status,
        TaskStatus::Closed
    );
}

#[test]
fn find_task_run_by_session_is_scoped_to_task() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task_a = db.insert_task(dev_task("task a")).unwrap();
    let task_b = db.insert_task(dev_task("task b")).unwrap();
    let run_a = db
        .start_task_run(NewTaskRun {
            task_id: task_a.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    db.record_task_run_observation(
        &run_a.id,
        TaskRunObservation {
            status: None,
            wait_reason: None,
            event_label: Some("SessionStart"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-shared")),
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();

    let found = db
        .find_task_run_by_session(&task_a.id, &AgentSessionId::from_agent("sess-shared"))
        .unwrap()
        .unwrap();
    assert_eq!(found.id, run_a.id);
    assert!(db
        .find_task_run_by_session(&task_b.id, &AgentSessionId::from_agent("sess-shared"))
        .unwrap()
        .is_none());
}

#[test]
fn task_summaries_count_side_runs_excluding_primary_and_sessionless_failures() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("side runs")).unwrap();
    let bare_task = db.insert_task(dev_task("no runs")).unwrap();
    let new_run = |task_id: &str| NewTaskRun {
        task_id: TaskId::from_store(task_id.to_string()),
        agent: None,
        branch: None,
        worktree_path: None,
    };
    let observe = |db: &mut SqliteStore, run_id: &TaskRunId, status: TaskRunStatus, session: &str| {
        db.record_task_run_observation(
            run_id,
            TaskRunObservation {
                status: Some(status),
                wait_reason: None,
                event_label: None,
                at: "2026-06-02T00:00:00.000Z",
                agent_session_id: Some(&AgentSessionId::from_agent(session)),
                terminal_tab_id: None,
                metadata_raw: None,
                plan_file_path: None,
                hold_stop: false,
                release_stop: false,
            },
        )
        .unwrap();
    };

    let primary = db.start_task_run(new_run(&task.id)).unwrap();
    observe(&mut db, &primary.id, TaskRunStatus::Running, "sess-main");
    db.set_primary_task_run(&task.id, &primary.id).unwrap();

    let observe_waiting =
        |db: &mut SqliteStore, run_id: &TaskRunId, reason: TaskRunWaitReason, session: &str| {
            db.record_task_run_observation(
                run_id,
                TaskRunObservation {
                    status: Some(TaskRunStatus::WaitingForUser),
                    wait_reason: Some(Some(reason)),
                    event_label: None,
                    at: "2026-06-02T00:00:00.000Z",
                    agent_session_id: Some(&AgentSessionId::from_agent(session)),
                    terminal_tab_id: None,
                    metadata_raw: None,
                    plan_file_path: None,
                    hold_stop: false,
                    release_stop: false,
                },
            )
            .unwrap();
        };

    let side_running = db.start_task_run(new_run(&task.id)).unwrap();
    observe(&mut db, &side_running.id, TaskRunStatus::Running, "sess-2");
    let side_waiting = db.start_task_run(new_run(&task.id)).unwrap();
    observe_waiting(
        &mut db,
        &side_waiting.id,
        TaskRunWaitReason::AskUserQuestion,
        "sess-3",
    );
    // A side run idling between turns is healthy, not an attention item.
    let side_idle = db.start_task_run(new_run(&task.id)).unwrap();
    observe_waiting(
        &mut db,
        &side_idle.id,
        TaskRunWaitReason::AwaitingPrompt,
        "sess-5",
    );
    let side_failed = db.start_task_run(new_run(&task.id)).unwrap();
    observe(&mut db, &side_failed.id, TaskRunStatus::Failed, "sess-4");
    // A failed run with no Claude session is an old prepare failure, not a side run.
    let prepare_failed = db.start_task_run(new_run(&task.id)).unwrap();
    db.finish_task_run(&prepare_failed.id, &task.id, TaskRunStatus::Failed)
        .unwrap();

    let summaries = db.list_task_summaries(TaskSummaryFilter::All, None).unwrap();
    let summary = summaries.iter().find(|s| s.id == task.id.as_str()).unwrap();
    assert_eq!(summary.task_run_status, Some(TaskRunStatus::Running));
    assert_eq!(summary.side_runs_running, 1);
    assert_eq!(summary.side_runs_waiting_for_user, 1);
    assert_eq!(summary.side_runs_failed, 1);

    let bare = summaries.iter().find(|s| s.id == bare_task.id.as_str()).unwrap();
    assert_eq!(bare.side_runs_running, 0);
    assert_eq!(bare.side_runs_waiting_for_user, 0);
    assert_eq!(bare.side_runs_failed, 0);
}

#[test]
fn task_summaries_fall_back_to_latest_run_when_primary_pointer_dangles() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("dangling primary")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: None,
            event_label: Some("SessionStart"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-1")),
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    db.set_primary_task_run(&task.id, &rid("run-999")).unwrap();

    let summaries = db.list_task_summaries(TaskSummaryFilter::All, None).unwrap();
    let summary = summaries.iter().find(|s| s.id == task.id.as_str()).unwrap();
    // The task's only run is its de-facto main run, not a side run.
    assert_eq!(summary.task_run_status, Some(TaskRunStatus::Running));
    assert_eq!(summary.side_runs_running, 0);
}

#[test]
fn task_summaries_skip_prepare_for_stopped_primary_with_session() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let resumable = db.insert_task(dev_task("stopped with session")).unwrap();
    let cold = db.insert_task(dev_task("stopped without session")).unwrap();
    let new_run = |task_id: &TaskId| NewTaskRun {
        task_id: task_id.clone(),
        agent: None,
        branch: None,
        worktree_path: None,
    };

    let run = db.start_task_run(new_run(&resumable.id)).unwrap();
    db.set_primary_task_run(&resumable.id, &run.id).unwrap();
    db.finish_task_run(&run.id, &resumable.id, TaskRunStatus::Prepared)
        .unwrap();
    assert!(db.claim_prepared_run(&run.id, &AgentSessionId::from_agent("sess-1")).unwrap());
    db.finish_task_run(&run.id, &resumable.id, TaskRunStatus::Stopped)
        .unwrap();

    let cold_run = db.start_task_run(new_run(&cold.id)).unwrap();
    db.set_primary_task_run(&cold.id, &cold_run.id).unwrap();
    db.finish_task_run(&cold_run.id, &cold.id, TaskRunStatus::Stopped)
        .unwrap();

    let summaries = db.list_task_summaries(TaskSummaryFilter::All, None).unwrap();
    let with_session = summaries.iter().find(|s| s.id == resumable.id.as_str()).unwrap();
    assert_eq!(with_session.status, DisplayStatus::Stopped);
    assert!(!with_session.run_needs_prepare);
    let without_session = summaries.iter().find(|s| s.id == cold.id.as_str()).unwrap();
    assert_eq!(without_session.status, DisplayStatus::Stopped);
    assert!(without_session.run_needs_prepare);
}

#[test]
fn task_summaries_expose_has_plan_from_the_primary_run() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let planned = db.insert_task(dev_task("has a plan")).unwrap();
    let unplanned = db.insert_task(dev_task("no plan")).unwrap();
    let new_run = |task_id: &str| NewTaskRun {
        task_id: TaskId::from_store(task_id.to_string()),
        agent: None,
        branch: None,
        worktree_path: None,
    };

    let primary = db.start_task_run(new_run(&planned.id)).unwrap();
    db.set_primary_task_run(&planned.id, &primary.id).unwrap();
    db.record_task_run_observation(
        &primary.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::WaitingForUser),
            wait_reason: Some(Some(TaskRunWaitReason::ExitPlanMode)),
            event_label: Some("PreToolUse"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-plan")),
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: Some("/Users/me/.claude/plans/hazy-wiggling-salamander.md"),
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    // The plain task records a run that never carried a plan.
    db.start_task_run(new_run(&unplanned.id)).unwrap();

    let has_plan = |db: &SqliteStore, id: &str| {
        db.list_task_summaries(TaskSummaryFilter::All, None)
            .unwrap()
            .into_iter()
            .find(|s| s.id == id)
            .unwrap()
            .has_plan
    };
    assert!(has_plan(&db, &planned.id));
    assert!(!has_plan(&db, &unplanned.id));

    // Approving the plan clears the wait, but the stored path — and so has_plan — must survive.
    db.record_task_run_observation(
        &primary.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: Some(None),
            event_label: Some("UserPromptSubmit"),
            at: "2026-06-02T00:01:00.000Z",
            agent_session_id: None,
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    assert!(has_plan(&db, &planned.id));
}

#[test]
fn task_summary_filter_scopes_the_closed_archive() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let active = db.insert_task(dev_task("still working")).unwrap();
    let archived = db.insert_task(dev_task("wrapped up")).unwrap();
    db.mark_task(&archived.id, TaskStatus::Closed, None).unwrap();

    let ids = |rows: Vec<TaskSummaryRow>| -> Vec<String> { rows.into_iter().map(|r| r.id).collect() };

    let active_only = ids(db.list_task_summaries(TaskSummaryFilter::Active, None).unwrap());
    assert!(active_only.contains(&active.id.to_string()));
    assert!(
        !active_only.contains(&archived.id.to_string()),
        "Active must hide the Closed archive"
    );

    let closed_only = ids(db
        .list_task_summaries(TaskSummaryFilter::Status(DisplayStatus::Closed), None)
        .unwrap());
    assert!(closed_only.contains(&archived.id.to_string()));
    assert!(!closed_only.contains(&active.id.to_string()));

    let everything = ids(db.list_task_summaries(TaskSummaryFilter::All, None).unwrap());
    assert!(everything.contains(&active.id.to_string()));
    assert!(everything.contains(&archived.id.to_string()));
}

#[test]
fn project_round_trip_and_summary_pr_status_stay_wire_compatible() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/repo".to_string());
    db.upsert_project(&project, &ExecutionProfile::default()).unwrap();

    let mut task = dev_task("with pr");
    task.project_id = Some(project.id.clone());
    let item = db.insert_task(task).unwrap();
    let candidate = PullRequestBranchSyncCandidate {
        task_id: item.id.to_string(),
        repo: "owner/repo".to_string(),
        branch: "issue-42".to_string(),
    };
    db.bulk_record_pr_sync(
        &[(
            candidate,
            vec![GithubPullRequest {
                repo: "owner/repo".to_string(),
                number: 7,
                url: "https://github.com/owner/repo/pull/7".to_string(),
                status: GithubPullRequestStatus::Open,
            }],
        )],
        &[],
    )
    .unwrap();

    let summaries = db
        .list_task_summaries(TaskSummaryFilter::Status(DisplayStatus::Ready), Some("owner/repo"))
        .unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(
        summaries[0].github_pull_requests[0].status.as_deref(),
        Some("open")
    );
    assert!(summaries[0].has_open_pull_request);

    // A merged-only task is settled work: no open-PR accent.
    let mut merged_task = dev_task("with merged pr");
    merged_task.project_id = Some(project.id.clone());
    let merged_item = db.insert_task(merged_task).unwrap();
    db.bulk_record_pr_sync(
        &[(
            PullRequestBranchSyncCandidate {
                task_id: merged_item.id.to_string(),
                repo: "owner/repo".to_string(),
                branch: "issue-43".to_string(),
            },
            vec![GithubPullRequest {
                repo: "owner/repo".to_string(),
                number: 8,
                url: "https://github.com/owner/repo/pull/8".to_string(),
                status: GithubPullRequestStatus::Merged,
            }],
        )],
        &[],
    )
    .unwrap();
    let summaries = db.list_task_summaries(TaskSummaryFilter::All, Some("owner/repo"))
            .unwrap();
    let merged_row = summaries.iter().find(|s| s.id == merged_item.id.as_str()).unwrap();
    assert!(!merged_row.has_open_pull_request);

    // Draft counts as open work in flight.
    let mut draft_task = dev_task("with draft pr");
    draft_task.project_id = Some(project.id.clone());
    let draft_item = db.insert_task(draft_task).unwrap();
    db.bulk_record_pr_sync(
        &[(
            PullRequestBranchSyncCandidate {
                task_id: draft_item.id.to_string(),
                repo: "owner/repo".to_string(),
                branch: "issue-44".to_string(),
            },
            vec![GithubPullRequest {
                repo: "owner/repo".to_string(),
                number: 9,
                url: "https://github.com/owner/repo/pull/9".to_string(),
                status: GithubPullRequestStatus::Draft,
            }],
        )],
        &[],
    )
    .unwrap();
    let summaries = db.list_task_summaries(TaskSummaryFilter::All, Some("owner/repo"))
            .unwrap();
    let draft_row = summaries.iter().find(|s| s.id == draft_item.id.as_str()).unwrap();
    assert!(draft_row.has_open_pull_request);
}

#[test]
fn project_primary_note_id_reads_back_and_survives_upsert() {
    use monica_application::ports::NoteStore;

    let mut db = SqliteStore::open_in_memory().unwrap();
    let project = Project::from_repo("owner/repo");
    let saved = db.upsert_project(&project, &ExecutionProfile::default()).unwrap();
    assert_eq!(saved.primary_note_id, None, "新規 project は primary note なし");

    // 列の永続性だけを検証するため、lazy 作成経路と切り離して生 SQL で仕込む
    let note = db.create_note(0).unwrap();
    db.conn()
        .execute(
            "UPDATE projects SET primary_note_id = ?1 WHERE id = 'owner/repo'",
            params![note.id.as_str()],
        )
        .unwrap();
    let read = db.get_project("owner/repo").unwrap().unwrap();
    assert_eq!(read.primary_note_id.as_deref(), Some(note.id.as_str()));

    // 再 upsert（hook 経由の登録更新）が既存の primary_note_id を消さないこと
    db.upsert_project(&project, &ExecutionProfile::default()).unwrap();
    let read = db.get_project("owner/repo").unwrap().unwrap();
    assert_eq!(read.primary_note_id.as_deref(), Some(note.id.as_str()));
}

#[test]
fn all_branch_sync_candidates_use_latest_run_branch_and_project_repo() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let mut project = Project::from_repo("owner/repo");
    project.default_branch = "main".to_string();
    db.upsert_project(&project, &ExecutionProfile::default()).unwrap();
    let mut task = dev_task("latest branch");
    task.project_id = Some(project.id.clone());
    let item = db.insert_task(task).unwrap();
    db.start_task_run(NewTaskRun {
        task_id: item.id.clone(),
        agent: None,
        branch: Some("old-branch".to_string()),
        worktree_path: None,
    })
    .unwrap();
    db.start_task_run(NewTaskRun {
        task_id: item.id.clone(),
        agent: None,
        branch: Some("feature/new-branch".to_string()),
        worktree_path: None,
    })
    .unwrap();

    let candidates = db.all_branch_sync_candidates().unwrap();
    assert_eq!(
        candidates,
        vec![PullRequestBranchSyncCandidate {
            task_id: item.id.to_string(),
            repo: "owner/repo".to_string(),
            branch: "feature/new-branch".to_string(),
        }]
    );
}

// Closing a task is "done-like": it stays a PR sync candidate just as the old `done` status did,
// since dropping the `deleted_at IS NULL` guard removes the only thing that hid it.
#[test]
fn all_branch_sync_candidates_include_closed_tasks() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let mut project = Project::from_repo("owner/repo");
    project.default_branch = "main".to_string();
    db.upsert_project(&project, &ExecutionProfile::default()).unwrap();
    let mut task = dev_task("closed but synced");
    task.project_id = Some(project.id.clone());
    let item = db.insert_task(task).unwrap();
    db.start_task_run(NewTaskRun {
        task_id: item.id.clone(),
        agent: None,
        branch: Some("feature/keep-syncing".to_string()),
        worktree_path: None,
    })
    .unwrap();
    db.mark_task_closed(&item.id).unwrap();

    let candidates = db.all_branch_sync_candidates().unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].task_id, item.id.as_str());
    assert_eq!(candidates[0].branch, "feature/keep-syncing");
}

#[test]
fn mark_task_closed_sets_status_and_closed_at() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("to close")).unwrap();
    assert!(task.closed_at.is_none());

    let closed = db.mark_task_closed(&task.id).unwrap();
    assert_eq!(closed.status, TaskStatus::Closed);
    assert!(
        closed.closed_at.is_some(),
        "mark_task_closed must return the post-update row with closed_at set"
    );

    let refetched = db.get_task(&task.id).unwrap().unwrap();
    assert_eq!(refetched.status, TaskStatus::Closed);
    assert!(refetched.closed_at.is_some());

    assert!(
        db.mark_task_closed(&tid("MON-missing")).is_err(),
        "closing a missing task must error"
    );
}

#[test]
fn all_branch_sync_candidates_skip_main_master_and_default_branch() {
    for branch in ["main", "master", "trunk"] {
        let mut db = SqliteStore::open_in_memory().unwrap();
        project_task_with_branch(&mut db, "owner/repo", "trunk", branch);
        assert!(db.all_branch_sync_candidates().unwrap().is_empty());
    }
}

#[test]
fn all_branch_sync_candidates_keep_already_synced_branches() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let (id1, c1) = project_task_with_branch(&mut db, "owner/repo", "main", "feature/a");
    let (id2, _c2) = project_task_with_branch(&mut db, "owner/repo", "main", "feature/b");
    db.bulk_record_pr_sync(
        &[(
            c1,
            vec![GithubPullRequest {
                repo: "owner/repo".to_string(),
                number: 5,
                url: "https://github.com/owner/repo/pull/5".to_string(),
                status: GithubPullRequestStatus::Merged,
            }],
        )],
        &[],
    )
    .unwrap();

    let candidates = db.all_branch_sync_candidates().unwrap();
    let task_ids: Vec<&str> = candidates.iter().map(|c| c.task_id.as_str()).collect();

    assert_eq!(candidates.len(), 2);
    assert!(
        task_ids.contains(&id1.as_str()),
        "a just-synced branch stays a candidate: every forced sync re-checks all of them"
    );
    assert!(task_ids.contains(&id2.as_str()));
}

#[test]
fn all_branch_sync_candidates_returns_candidates_across_multiple_repos() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    project_task_with_branch(&mut db, "owner/repoA", "main", "feature/a");
    project_task_with_branch(&mut db, "owner/repoB", "main", "feature/b");

    let candidates = db.all_branch_sync_candidates().unwrap();
    let repos: std::collections::HashSet<&str> =
        candidates.iter().map(|c| c.repo.as_str()).collect();

    assert_eq!(candidates.len(), 2);
    assert!(repos.contains("owner/repoA"));
    assert!(repos.contains("owner/repoB"));
}

#[test]
fn bulk_record_pr_sync_with_empty_slices_is_noop() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    db.bulk_record_pr_sync(&[], &[]).unwrap();
    let rows: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM github_pull_request_ref_states",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0);
}

fn pr_status_of(db: &SqliteStore, task_id: &str) -> String {
    db.conn()
        .query_row(
            "SELECT s.status
             FROM github_pull_request_ref_states s
             JOIN external_refs e ON e.id = s.external_ref_id
             WHERE e.task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn bulk_record_pr_sync_upserts_refs_and_states() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let (id1, c1) = project_task_with_branch(&mut db, "owner/repo", "main", "feature/a");
    let (id2, c2) = project_task_with_branch(&mut db, "owner/repo", "main", "feature/b");

    let pr_ref_count = |db: &SqliteStore, task_id: &TaskId| -> usize {
        db.list_external_refs(task_id)
            .unwrap()
            .iter()
            .filter(|r| r.ref_type == RefType::PullRequest)
            .count()
    };

    db.bulk_record_pr_sync(
        &[
            (
                c1.clone(),
                vec![GithubPullRequest {
                    repo: "owner/repo".to_string(),
                    number: 11,
                    url: "https://github.com/owner/repo/pull/11".to_string(),
                    status: GithubPullRequestStatus::Open,
                }],
            ),
            // feature/b matched no PR: no external ref is created.
            (c2.clone(), Vec::new()),
        ],
        &[],
    )
    .unwrap();

    assert_eq!(pr_ref_count(&db, &id1), 1);
    assert_eq!(pr_status_of(&db, &id1), "open");
    assert_eq!(pr_ref_count(&db, &id2), 0);

    // Re-running with a newer status upserts the same ref in place — no duplicate row.
    db.bulk_record_pr_sync(
        &[(
            c1.clone(),
            vec![GithubPullRequest {
                repo: "owner/repo".to_string(),
                number: 11,
                url: "https://github.com/owner/repo/pull/11".to_string(),
                status: GithubPullRequestStatus::Merged,
            }],
        )],
        &[],
    )
    .unwrap();
    assert_eq!(pr_ref_count(&db, &id1), 1, "re-sync upserts, no duplicate ref");
    assert_eq!(pr_status_of(&db, &id1), "merged", "status updated in place");
}

#[test]
fn bulk_record_pr_sync_status_entries_update_state_and_url() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let (id1, c1) = project_task_with_branch(&mut db, "owner/repo", "main", "feature/a");
    db.bulk_record_pr_sync(
        &[(
            c1,
            vec![GithubPullRequest {
                repo: "owner/repo".to_string(),
                number: 11,
                url: "https://github.com/owner/repo/pull/11".to_string(),
                status: GithubPullRequestStatus::Open,
            }],
        )],
        &[],
    )
    .unwrap();
    let unresolved = db.all_unresolved_pull_request_refs().unwrap();
    assert_eq!(unresolved.len(), 1);
    assert_eq!(unresolved[0].task_id, id1.as_str());
    assert_eq!(unresolved[0].number, 11);

    db.bulk_record_pr_sync(
        &[],
        &[(
            unresolved[0].clone(),
            GithubPullRequest {
                repo: "owner/repo".to_string(),
                number: 11,
                url: "https://github.com/owner/repo/pull/11-moved".to_string(),
                status: GithubPullRequestStatus::Merged,
            },
        )],
    )
    .unwrap();

    assert_eq!(pr_status_of(&db, &id1), "merged");
    let url: String = db
        .conn()
        .query_row(
            "SELECT url FROM external_refs WHERE id = ?1",
            params![unresolved[0].external_ref_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(url, "https://github.com/owner/repo/pull/11-moved");
    assert!(
        db.all_unresolved_pull_request_refs().unwrap().is_empty(),
        "a merged PR is settled and leaves the unresolved set"
    );
}

#[test]
fn all_unresolved_pull_request_refs_select_missing_unknown_open_and_draft_states() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let project = Project::from_repo("owner/repo");
    db.upsert_project(&project, &ExecutionProfile::default()).unwrap();
    let mut task = dev_task("many prs");
    task.project_id = Some(project.id.clone());
    let item = db.insert_task(task).unwrap();

    let insert_ref = |db: &SqliteStore, number: i64, status: Option<&str>| {
        db.conn()
            .execute(
                "INSERT INTO external_refs (task_id, provider, ref_type, repo, number, url)
                 VALUES (?1, 'github', 'pull_request', 'owner/repo', ?2, 'u')",
                params![item.id.as_str(), number],
            )
            .unwrap();
        let ref_id = db.conn().last_insert_rowid();
        if let Some(status) = status {
            db.conn()
                .execute(
                    "INSERT INTO github_pull_request_ref_states (external_ref_id, status)
                     VALUES (?1, ?2)",
                    params![ref_id, status],
                )
                .unwrap();
        }
    };
    insert_ref(&db, 1, None); // no state row yet
    insert_ref(&db, 2, Some("open"));
    insert_ref(&db, 3, Some("draft"));
    insert_ref(&db, 4, Some("merged"));
    insert_ref(&db, 5, Some("closed"));

    let unresolved = db.all_unresolved_pull_request_refs().unwrap();
    let numbers: Vec<i64> = unresolved.iter().map(|r| r.number).collect();
    assert_eq!(numbers, vec![1, 2, 3], "settled PRs are not re-checked");
    assert!(unresolved.iter().all(|r| r.task_id == item.id.as_str()));
    assert!(unresolved.iter().all(|r| r.repo == "owner/repo"));
}

fn new_shell_session(runspace: Option<&str>, tab: Option<&str>) -> NewTerminalSession {
    NewTerminalSession {
        runspace_id: runspace.map(rsid),
        tab_id: tab.map(str::to_string),
        kind: TerminalSessionKind::Shell,
        cwd: "/tmp".into(),
        shell: "/bin/zsh".into(),
        rows: 24,
        cols: 80,
    }
}

#[test]
fn terminal_session_create_and_get_round_trip() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let session = db
        .create_terminal_session(new_shell_session(Some("rs-1"), Some("tab-1")))
        .unwrap();

    assert_eq!(session.id, "ts-1");
    assert_eq!(session.status, TerminalSessionStatus::Starting);
    assert_eq!(session.runspace_id.as_deref(), Some("rs-1"));
    assert_eq!(session.tab_id.as_deref(), Some("tab-1"));
    assert_eq!(session.kind, TerminalSessionKind::Shell);
    assert_eq!((session.rows, session.cols), (24, 80));
    assert!(session.pid.is_none());

    let fetched = db.get_terminal_session("ts-1").unwrap().unwrap();
    assert_eq!(fetched, session);
    assert!(db.get_terminal_session("ts-404").unwrap().is_none());

    let second = db.create_terminal_session(new_shell_session(None, None)).unwrap();
    assert_eq!(second.id, "ts-2");
}

#[test]
fn latest_terminal_session_for_tab_resolves_numerically_within_same_timestamp() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    // Same created_at for all rows forces the CAST(SUBSTR(id, 4)) tiebreak: ts-10 must beat
    // ts-2 numerically, not lexicographically.
    for _ in 0..10 {
        db.create_terminal_session(new_shell_session(None, Some("tab-1")))
            .unwrap();
    }
    db.conn()
        .execute_batch("UPDATE terminal_sessions SET created_at = '2026-06-02T00:00:00.000Z'")
        .unwrap();

    let latest = db.latest_terminal_session_for_tab("tab-1").unwrap().unwrap();
    assert_eq!(latest.id, "ts-10");
    assert!(db.latest_terminal_session_for_tab("tab-404").unwrap().is_none());
}

#[test]
fn latest_terminal_session_for_tab_prefers_newer_created_at() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let older = db
        .create_terminal_session(new_shell_session(None, Some("tab-1")))
        .unwrap();
    db.conn()
        .execute(
            "UPDATE terminal_sessions SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            [&older.id],
        )
        .unwrap();
    let newer = db
        .create_terminal_session(new_shell_session(None, Some("tab-1")))
        .unwrap();

    let latest = db.latest_terminal_session_for_tab("tab-1").unwrap().unwrap();
    assert_eq!(latest.id, newer.id);
}

#[test]
fn settle_task_run_if_live_only_stops_session_driven_runs() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("settle")).unwrap();
    let start_run = |db: &mut SqliteStore| {
        db.start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap()
    };
    let observe = |db: &mut SqliteStore, run_id: &TaskRunId, status: TaskRunStatus| {
        db.record_task_run_observation(
            run_id,
            TaskRunObservation {
                status: Some(status),
                wait_reason: None,
                event_label: None,
                at: "2026-06-02T00:00:00.000Z",
                agent_session_id: Some(&AgentSessionId::from_agent("sess-1")),
                terminal_tab_id: None,
                metadata_raw: None,
                plan_file_path: None,
                hold_stop: false,
                release_stop: false,
            },
        )
        .unwrap();
    };

    // Live runs settle and the wait_reason is cleared with them.
    for status in [TaskRunStatus::Running, TaskRunStatus::WaitingForUser] {
        let run = start_run(&mut db);
        observe(&mut db, &run.id, status);
        assert!(db.settle_task_run_if_live(&run.id, &task.id).unwrap(), "{status:?}");
        let run = db.get_task_run(&run.id).unwrap().unwrap();
        assert_eq!(run.status, TaskRunStatus::Stopped);
        assert_eq!(run.wait_reason, None);
    }

    // A pending_stop flag is cleared when the terminal dies.
    let pending = start_run(&mut db);
    observe(&mut db, &pending.id, TaskRunStatus::Running);
    // A Stop held by a running subagent (the suppressed transition lands as status None).
    record_observation(&mut db, &pending.id, "Stop", None, true, false);
    assert!(db.get_task_run(&pending.id).unwrap().unwrap().pending_stop);
    assert!(db.settle_task_run_if_live(&pending.id, &task.id).unwrap());
    let settled = db.get_task_run(&pending.id).unwrap().unwrap();
    assert_eq!(settled.status, TaskRunStatus::Stopped);
    assert!(!settled.pending_stop);

    // A hook-created run parked at setting_up settles only once a session was observed on it.
    let observed = start_run(&mut db);
    db.record_task_run_observation(
        &observed.id,
        TaskRunObservation {
            status: None,
            wait_reason: None,
            event_label: Some("SessionStart"),
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-2")),
            terminal_tab_id: Some("tab-1"),
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    assert!(db.settle_task_run_if_live(&observed.id, &task.id).unwrap());

    // A prepare-flow setting_up run has no session and must survive.
    let preparing = start_run(&mut db);
    assert!(!db.settle_task_run_if_live(&preparing.id, &task.id).unwrap());
    assert_eq!(
        db.get_task_run(&preparing.id).unwrap().unwrap().status,
        TaskRunStatus::SettingUp
    );

    // Already-settled or terminal states are no-ops: a concurrent hook's verdict stands.
    for status in [
        TaskRunStatus::Prepared,
        TaskRunStatus::Stopped,
        TaskRunStatus::Failed,
    ] {
        let run = start_run(&mut db);
        db.finish_task_run(&run.id, &task.id, status).unwrap();
        assert!(!db.settle_task_run_if_live(&run.id, &task.id).unwrap(), "{status:?}");
        assert_eq!(
            db.get_task_run(&run.id).unwrap().unwrap().status,
            status,
            "{status:?}"
        );
    }

    // A mismatched task id never settles someone else's run.
    let run = start_run(&mut db);
    observe(&mut db, &run.id, TaskRunStatus::Running);
    assert!(!db.settle_task_run_if_live(&run.id, &tid("MON-404")).unwrap());
    assert_eq!(
        db.get_task_run(&run.id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );
}

#[test]
fn settle_task_run_if_live_survives_a_closed_task() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("doomed")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: None,
            event_label: None,
            at: "2026-06-02T00:00:00.000Z",
            agent_session_id: Some(&AgentSessionId::from_agent("sess-1")),
            terminal_tab_id: None,
            metadata_raw: None,
            plan_file_path: None,
            hold_stop: false,
            release_stop: false,
        },
    )
    .unwrap();
    db.mark_task_closed(&task.id).unwrap();

    // The terminal dying after the task was closed must still tombstone the run.
    assert!(db.settle_task_run_if_live(&run.id, &task.id).unwrap());
    assert_eq!(
        db.get_task_run(&run.id).unwrap().unwrap().status,
        TaskRunStatus::Stopped
    );
}

#[test]
fn list_driven_task_runs_with_tab_returns_only_tab_pinned_session_driven_runs() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("sweep")).unwrap();
    let start_run = |db: &mut SqliteStore| {
        db.start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap()
    };
    let observe = |db: &mut SqliteStore,
                   run_id: &TaskRunId,
                   status: Option<TaskRunStatus>,
                   session: Option<&str>,
                   tab: Option<&str>| {
        let session = session.map(AgentSessionId::from_agent);
        db.record_task_run_observation(
            run_id,
            TaskRunObservation {
                status,
                wait_reason: None,
                event_label: None,
                at: "2026-06-02T00:00:00.000Z",
                agent_session_id: session.as_ref(),
                terminal_tab_id: tab,
                metadata_raw: None,
                plan_file_path: None,
                hold_stop: false,
                release_stop: false,
            },
        )
        .unwrap();
    };

    let running = start_run(&mut db);
    observe(&mut db, &running.id, Some(TaskRunStatus::Running), Some("s1"), Some("tab-1"));
    let waiting = start_run(&mut db);
    observe(
        &mut db,
        &waiting.id,
        Some(TaskRunStatus::WaitingForUser),
        Some("s2"),
        Some("tab-2"),
    );
    let claimed_setting_up = start_run(&mut db);
    observe(&mut db, &claimed_setting_up.id, None, Some("s3"), Some("tab-3"));

    // Out of scope: a prepare-flow setting_up run (no session), a live run never observed in
    // a tab, and settled runs.
    let preparing = start_run(&mut db);
    observe(&mut db, &preparing.id, None, None, Some("tab-4"));
    let tabless = start_run(&mut db);
    observe(&mut db, &tabless.id, Some(TaskRunStatus::Running), Some("s5"), None);
    let stopped = start_run(&mut db);
    observe(&mut db, &stopped.id, Some(TaskRunStatus::Running), Some("s6"), Some("tab-6"));
    db.finish_task_run(&stopped.id, &task.id, TaskRunStatus::Stopped)
        .unwrap();

    let mut driven: Vec<String> = db
        .list_driven_task_runs_with_tab()
        .unwrap()
        .into_iter()
        .map(|run| run.id.into_string())
        .collect();
    driven.sort();
    let mut expected = vec![running.id.into_string(), waiting.id.into_string(), claimed_setting_up.id.into_string()];
    expected.sort();
    assert_eq!(driven, expected);
}

#[test]
fn terminal_session_started_records_pid_and_running() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let session = db.create_terminal_session(new_shell_session(None, None)).unwrap();

    db.mark_terminal_session_started(&session.id, Some(4242), Some("/tmp/ts-1.log"))
        .unwrap();

    let session = db.get_terminal_session(&session.id).unwrap().unwrap();
    assert_eq!(session.status, TerminalSessionStatus::Running);
    assert_eq!(session.pid, Some(4242));
    assert_eq!(session.transcript_path.as_deref(), Some("/tmp/ts-1.log"));
    assert!(session.started_at.is_some());
    assert!(session.last_seen_at.is_some());
    assert!(session.exited_at.is_none());
}

#[test]
fn terminal_session_updates_stamp_exited_at_once() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let session = db.create_terminal_session(new_shell_session(None, None)).unwrap();
    db.mark_terminal_session_started(&session.id, Some(1), None).unwrap();

    db.apply_terminal_session_updates(&[TerminalSessionUpdate {
        session_id: session.id.clone(),
        status: TerminalSessionStatus::Detached,
        pid: Some(7),
        exit_code: None,
    }])
    .unwrap();
    let detached = db.get_terminal_session(&session.id).unwrap().unwrap();
    assert_eq!(detached.status, TerminalSessionStatus::Detached);
    assert_eq!(detached.pid, Some(7));
    assert!(detached.exited_at.is_none());

    db.update_terminal_session_status(&session.id, TerminalSessionStatus::Exited, Some(130))
        .unwrap();
    let exited = db.get_terminal_session(&session.id).unwrap().unwrap();
    assert_eq!(exited.status, TerminalSessionStatus::Exited);
    assert_eq!(exited.exit_code, Some(130));
    let first_exited_at = exited.exited_at.clone().expect("exited_at must be stamped");
    // pid is preserved for post-mortem inspection.
    assert_eq!(exited.pid, Some(7));

    db.update_terminal_session_status(&session.id, TerminalSessionStatus::Exited, None)
        .unwrap();
    let again = db.get_terminal_session(&session.id).unwrap().unwrap();
    assert_eq!(again.exited_at, Some(first_exited_at));
    assert_eq!(again.exit_code, Some(130));
}

#[test]
fn terminal_session_settled_row_is_never_resurrected() {
    // A late attach response racing the daemon's Exit broadcast must not flip an exited
    // session back to running.
    let mut db = SqliteStore::open_in_memory().unwrap();
    let session = db.create_terminal_session(new_shell_session(None, None)).unwrap();
    db.mark_terminal_session_started(&session.id, Some(1), None).unwrap();
    db.update_terminal_session_status(&session.id, TerminalSessionStatus::Exited, Some(0))
        .unwrap();

    db.update_terminal_session_status(&session.id, TerminalSessionStatus::Running, None)
        .unwrap();

    let settled = db.get_terminal_session(&session.id).unwrap().unwrap();
    assert_eq!(settled.status, TerminalSessionStatus::Exited);
    assert_eq!(settled.exit_code, Some(0));
}

#[test]
fn terminal_session_terminal_statuses_stamp_exited_at_and_freeze_last_seen() {
    for status in [TerminalSessionStatus::Lost, TerminalSessionStatus::Failed] {
        let mut db = SqliteStore::open_in_memory().unwrap();
        let session = db.create_terminal_session(new_shell_session(None, None)).unwrap();
        db.mark_terminal_session_started(&session.id, Some(9), None).unwrap();
        let last_seen = db
            .get_terminal_session(&session.id)
            .unwrap()
            .unwrap()
            .last_seen_at
            .expect("started session must have last_seen_at");

        db.apply_terminal_session_updates(&[TerminalSessionUpdate {
            session_id: session.id.clone(),
            status,
            pid: None,
            exit_code: None,
        }])
        .unwrap();

        let settled = db.get_terminal_session(&session.id).unwrap().unwrap();
        assert_eq!(settled.status, status);
        assert!(settled.exited_at.is_some(), "{status:?} must stamp exited_at");
        assert_eq!(
            settled.last_seen_at.as_deref(),
            Some(last_seen.as_str()),
            "{status:?} must not refresh last_seen_at"
        );
        assert_eq!(settled.pid, Some(9), "COALESCE must keep the pid");
    }
}

#[test]
fn terminal_session_list_filters_by_runspace() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    db.create_terminal_session(new_shell_session(Some("rs-1"), None)).unwrap();
    db.create_terminal_session(new_shell_session(Some("rs-2"), None)).unwrap();
    db.create_terminal_session(new_shell_session(None, None)).unwrap();

    assert_eq!(db.list_terminal_sessions(None).unwrap().len(), 3);
    let scoped = db.list_terminal_sessions(Some(&rsid("rs-1"))).unwrap();
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0].runspace_id.as_deref(), Some("rs-1"));
}

#[test]
fn terminal_state_snapshot_round_trips_session_id() {
    use monica_application::{TerminalRunspaceRow, TerminalStateSnapshot, TerminalTabRow};

    let mut db = SqliteStore::open_in_memory().unwrap();
    let snapshot = TerminalStateSnapshot {
        runspaces: vec![TerminalRunspaceRow {
            id: rsid("rs-1"),
            sort_order: 0,
            pinned_tab_id: None,
            tabs: vec![
                TerminalTabRow {
                    id: "tab-1".into(),
                    cwd: "/tmp".into(),
                    title: "one".into(),
                    sort_order: 0,
                    terminal_session_id: Some("ts-1".into()),
                },
                TerminalTabRow {
                    id: "tab-2".into(),
                    cwd: "/tmp".into(),
                    title: "two".into(),
                    sort_order: 1,
                    terminal_session_id: None,
                },
            ],
        }],
    };
    db.save_terminal_state("main", &snapshot).unwrap();

    let loaded = db.load_terminal_state("main").unwrap();
    let tabs = &loaded.runspaces[0].tabs;
    assert_eq!(tabs[0].terminal_session_id.as_deref(), Some("ts-1"));
    assert_eq!(tabs[1].terminal_session_id, None);
}

#[test]
fn terminal_state_round_trips_pinned_tab_id_and_drops_dangling() {
    use monica_application::{TerminalRunspaceRow, TerminalStateSnapshot, TerminalTabRow};

    let tab = |id: &str| TerminalTabRow {
        id: id.into(),
        cwd: "/tmp".into(),
        title: id.into(),
        sort_order: 0,
        terminal_session_id: None,
    };

    let mut db = SqliteStore::open_in_memory().unwrap();
    let snapshot = TerminalStateSnapshot {
        runspaces: vec![
            TerminalRunspaceRow {
                id: rsid("rs-pinned"),
                sort_order: 0,
                pinned_tab_id: Some("tab-1".into()),
                tabs: vec![tab("tab-1")],
            },
            TerminalRunspaceRow {
                id: rsid("rs-dangling"),
                sort_order: 1,
                pinned_tab_id: Some("tab-gone".into()),
                tabs: vec![tab("tab-2")],
            },
            TerminalRunspaceRow {
                id: rsid("rs-unpinned"),
                sort_order: 2,
                pinned_tab_id: None,
                tabs: vec![tab("tab-3")],
            },
        ],
    };
    db.save_terminal_state("main", &snapshot).unwrap();

    let loaded = db.load_terminal_state("main").unwrap();
    assert_eq!(loaded.runspaces[0].pinned_tab_id.as_deref(), Some("tab-1"));
    assert_eq!(loaded.runspaces[1].pinned_tab_id, None);
    assert_eq!(loaded.runspaces[2].pinned_tab_id, None);
}

#[test]
fn terminal_state_is_scoped_by_window_label() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let main_snap = TerminalStateSnapshot {
        runspaces: vec![TerminalRunspaceRow {
            id: rsid("rs-main"),
            sort_order: 0,
            pinned_tab_id: None,
            tabs: vec![TerminalTabRow {
                id: "tab-m1".into(),
                cwd: "/home".into(),
                title: "main-tab".into(),
                sort_order: 0,
                terminal_session_id: None,
            }],
        }],
    };
    let secondary_snap = TerminalStateSnapshot {
        runspaces: vec![TerminalRunspaceRow {
            id: rsid("rs-sec"),
            sort_order: 0,
            pinned_tab_id: None,
            tabs: vec![TerminalTabRow {
                id: "tab-s1".into(),
                cwd: "/tmp".into(),
                title: "sec-tab".into(),
                sort_order: 0,
                terminal_session_id: Some("ts-99".into()),
            }],
        }],
    };

    db.save_terminal_state("main", &main_snap).unwrap();
    db.save_terminal_state("monica-window-1", &secondary_snap)
        .unwrap();

    let loaded_main = db.load_terminal_state("main").unwrap();
    assert_eq!(loaded_main.runspaces.len(), 1);
    assert_eq!(loaded_main.runspaces[0].id, "rs-main");

    let loaded_sec = db.load_terminal_state("monica-window-1").unwrap();
    assert_eq!(loaded_sec.runspaces.len(), 1);
    assert_eq!(loaded_sec.runspaces[0].id, "rs-sec");
    assert_eq!(
        loaded_sec.runspaces[0].tabs[0].terminal_session_id.as_deref(),
        Some("ts-99")
    );

    // Saving main again must not destroy the secondary window's data.
    let updated_main = TerminalStateSnapshot {
        runspaces: vec![TerminalRunspaceRow {
            id: rsid("rs-main-v2"),
            sort_order: 0,
            pinned_tab_id: None,
            tabs: vec![],
        }],
    };
    db.save_terminal_state("main", &updated_main).unwrap();

    let reloaded_sec = db.load_terminal_state("monica-window-1").unwrap();
    assert_eq!(reloaded_sec.runspaces.len(), 1);
    assert_eq!(reloaded_sec.runspaces[0].id, "rs-sec");

    let reloaded_main = db.load_terminal_state("main").unwrap();
    assert_eq!(reloaded_main.runspaces[0].id, "rs-main-v2");

    // Empty window returns no runspaces.
    let empty = db.load_terminal_state("nonexistent").unwrap();
    assert!(empty.runspaces.is_empty());
}

#[test]
fn same_runspace_id_in_two_windows_does_not_leak_tabs() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let main_snap = TerminalStateSnapshot {
        runspaces: vec![TerminalRunspaceRow {
            id: rsid("bench-task-1"),
            sort_order: 0,
            pinned_tab_id: None,
            tabs: vec![TerminalTabRow {
                id: "tab-main".into(),
                cwd: "/main".into(),
                title: "main".into(),
                sort_order: 0,
                terminal_session_id: Some("ts-1".into()),
            }],
        }],
    };
    let sec_snap = TerminalStateSnapshot {
        runspaces: vec![TerminalRunspaceRow {
            id: rsid("bench-task-1"),
            sort_order: 0,
            pinned_tab_id: None,
            tabs: vec![TerminalTabRow {
                id: "tab-sec".into(),
                cwd: "/secondary".into(),
                title: "sec".into(),
                sort_order: 0,
                terminal_session_id: Some("ts-2".into()),
            }],
        }],
    };

    db.save_terminal_state("main", &main_snap).unwrap();
    db.save_terminal_state("monica-window-1", &sec_snap)
        .unwrap();

    let loaded_main = db.load_terminal_state("main").unwrap();
    assert_eq!(loaded_main.runspaces.len(), 1);
    assert_eq!(loaded_main.runspaces[0].tabs.len(), 1);
    assert_eq!(loaded_main.runspaces[0].tabs[0].id, "tab-main");
    assert_eq!(loaded_main.runspaces[0].tabs[0].cwd, "/main");

    let loaded_sec = db.load_terminal_state("monica-window-1").unwrap();
    assert_eq!(loaded_sec.runspaces.len(), 1);
    assert_eq!(loaded_sec.runspaces[0].tabs.len(), 1);
    assert_eq!(loaded_sec.runspaces[0].tabs[0].id, "tab-sec");
    assert_eq!(loaded_sec.runspaces[0].tabs[0].cwd, "/secondary");

    // Saving main must not destroy the secondary's tabs.
    db.save_terminal_state("main", &main_snap).unwrap();
    let reloaded_sec = db.load_terminal_state("monica-window-1").unwrap();
    assert_eq!(reloaded_sec.runspaces[0].tabs[0].id, "tab-sec");
}

// --- Issue #256: UnitOfWork transaction boundary + prepared-run claim CAS ---

/// A run created inside a [`WorkTransaction`] that is dropped without `commit` must leave no trace.
/// This is the atomicity `start_run` relies on: a failure midway through (run created, then primary
/// or bench write fails) rolls the whole thing back instead of stranding an orphan run.
#[test]
fn work_transaction_rolls_back_when_dropped_without_commit() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("rollback")).unwrap();
    let run_id = {
        let mut tx = db.begin().unwrap();
        let run = tx
            .start_task_run(NewTaskRun {
                task_id: task.id.clone(),
                agent: None,
                branch: Some("issue-1".to_string()),
                worktree_path: None,
            })
            .unwrap();
        run.id
        // `tx` is dropped here without `commit` -> rollback.
    };
    assert!(
        db.get_task_run(&run_id).unwrap().is_none(),
        "an uncommitted run must not persist"
    );
    assert!(db.list_task_runs_for_task(&task.id).unwrap().is_empty());
}

/// Committing persists the run, the primary pointer, and the bench together — the three writes
/// `start_run` performs as one unit.
#[test]
fn work_transaction_commit_persists_run_primary_and_bench() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("atomic")).unwrap();
    let run_id = {
        let mut tx = db.begin().unwrap();
        let run = tx
            .start_task_run(NewTaskRun {
                task_id: task.id.clone(),
                agent: None,
                branch: Some("issue-1".to_string()),
                worktree_path: None,
            })
            .unwrap();
        tx.set_primary_task_run(&task.id, &run.id).unwrap();
        tx.create_bench(&task.id, &rsid("runspace-1"), "/tmp/wt").unwrap();
        tx.commit().unwrap();
        run.id
    };
    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().primary_task_run_id.as_deref(),
        Some(run_id.as_str())
    );
    assert_eq!(
        db.get_bench_for_task(&task.id).unwrap(),
        Some((rsid("runspace-1"), "/tmp/wt".to_string()))
    );
    assert_eq!(db.list_task_runs_for_task(&task.id).unwrap().len(), 1);
}

/// `attach_terminal_session_to_task` binds the tab, takes the primary, and creates the bench as one
/// unit — a crash in between would leave a run with no runspace for the Workbench to move its tab to.
#[test]
fn work_transaction_commit_persists_attach_primary_and_bench() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("attach-atomic")).unwrap();
    let run_id = {
        let mut tx = db.begin().unwrap();
        let attachment = tx
            .attach_terminal_tab_to_task(
                NewTaskRun {
                    task_id: task.id.clone(),
                    agent: Some(Agent::Claude),
                    branch: None,
                    worktree_path: None,
                },
                "tab-1",
                Some(&AgentSessionId::from_agent("sess-1")),
            )
            .unwrap();
        tx.set_primary_task_run(&task.id, &attachment.run.id).unwrap();
        tx.create_bench(&task.id, &rsid("bench-x"), "/home/me").unwrap();
        tx.commit().unwrap();
        attachment.run.id
    };
    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().primary_task_run_id.as_deref(),
        Some(run_id.as_str())
    );
    assert_eq!(
        db.get_bench_for_task(&task.id).unwrap(),
        Some((rsid("bench-x"), "/home/me".to_string()))
    );
    assert_eq!(
        db.find_task_run_by_terminal_tab("tab-1").unwrap().map(|run| run.id),
        Some(run_id)
    );
}

#[test]
fn work_transaction_rolls_back_an_attach_dropped_without_commit() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("attach-rollback")).unwrap();
    {
        let mut tx = db.begin().unwrap();
        let attachment = tx
            .attach_terminal_tab_to_task(
                NewTaskRun {
                    task_id: task.id.clone(),
                    agent: Some(Agent::Claude),
                    branch: None,
                    worktree_path: None,
                },
                "tab-1",
                None,
            )
            .unwrap();
        tx.set_primary_task_run(&task.id, &attachment.run.id).unwrap();
        tx.create_bench(&task.id, &rsid("bench-x"), "/home/me").unwrap();
    }
    assert!(db.find_task_run_by_terminal_tab("tab-1").unwrap().is_none());
    assert_eq!(db.get_task(&task.id).unwrap().unwrap().primary_task_run_id, None);
    assert_eq!(db.get_bench_for_task(&task.id).unwrap(), None);
}

/// `create_lazy_run_for_session(make_primary_if_missing = true)` lands the new run AND the primary
/// pointer in one transaction — the atomicity the hook lazy-create path relies on so a hook firing
/// from a separate process can never strand a run with no primary.
#[test]
fn create_lazy_run_for_session_sets_primary_atomically_when_missing() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("lazy-primary")).unwrap();

    let run = db
        .create_lazy_run_for_session(
            NewTaskRun {
                task_id: task.id.clone(),
                agent: Some(Agent::Claude),
                branch: None,
                worktree_path: None,
            },
            true,
        )
        .unwrap();

    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().primary_task_run_id.as_deref(),
        Some(run.id.as_str()),
        "the new run becomes the primary in the same transaction"
    );
}

/// With a primary already set, `make_primary_if_missing = false` creates a side run and must leave
/// the existing primary pointer untouched.
#[test]
fn create_lazy_run_for_session_leaves_existing_primary_untouched() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("lazy-side")).unwrap();
    let primary = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    db.set_primary_task_run(&task.id, &primary.id).unwrap();

    let side = db
        .create_lazy_run_for_session(
            NewTaskRun {
                task_id: task.id.clone(),
                agent: Some(Agent::Claude),
                branch: None,
                worktree_path: None,
            },
            false,
        )
        .unwrap();

    assert_ne!(side.id, primary.id);
    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().primary_task_run_id.as_deref(),
        Some(primary.id.as_str()),
        "an existing primary must not be overwritten by a side run"
    );
    assert_eq!(db.list_task_runs_for_task(&task.id).unwrap().len(), 2);
}

/// Two near-simultaneous SessionStarts racing for one prepared run: the guarded UPDATE lets exactly
/// one win, the loser changes 0 rows, and only the winner's session id is recorded. This is the
/// race the snapshot-based claim could not close.
#[test]
fn claim_prepared_run_is_won_by_a_single_session() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("cas")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();
    db.finish_task_run(&run.id, &task.id, TaskRunStatus::Prepared)
        .unwrap();

    assert!(
        db.claim_prepared_run(&run.id, &AgentSessionId::from_agent("session-A")).unwrap(),
        "the first claim wins"
    );
    assert!(
        !db.claim_prepared_run(&run.id, &AgentSessionId::from_agent("session-B")).unwrap(),
        "a second claim on an already-claimed run loses"
    );
    assert_eq!(
        db.get_task_run(&run.id).unwrap().unwrap().agent_session_id.as_deref(),
        Some("session-A")
    );
}

/// The claim only fires for a still-`prepared`, unclaimed run; a `SettingUp` run is refused so a
/// stray session can't hijack a run that is not waiting to be claimed.
#[test]
fn claim_prepared_run_refuses_non_prepared_run() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("cas-guard")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();

    // The run is still `SettingUp` (never moved to `Prepared`).
    assert!(!db.claim_prepared_run(&run.id, &AgentSessionId::from_agent("session-A")).unwrap());
    assert!(db
        .get_task_run(&run.id)
        .unwrap()
        .unwrap()
        .agent_session_id
        .is_none());
}

/// A claim against a run that no longer exists changes 0 rows and reports a clean loss rather than
/// erroring — the caller treats it as "someone else took it" and falls through.
#[test]
fn claim_prepared_run_returns_false_for_missing_run() {
    let db = SqliteStore::open_in_memory().unwrap();
    assert!(!db.claim_prepared_run(&rid("run-does-not-exist"), &AgentSessionId::from_agent("session-A")).unwrap());
}

/// Exercises a store contract; reused below against both the direct store and a `WorkTransaction`.
fn workbench_contract<S: WorkbenchStore + ?Sized>(store: &mut S, task_id: &TaskId) {
    store.create_bench(task_id, &rsid("runspace-x"), "/a").unwrap();
    assert_eq!(
        store.get_bench_for_task(task_id).unwrap(),
        Some((rsid("runspace-x"), "/a".to_string()))
    );
    store.update_bench_cwd(task_id, "/b").unwrap();
    assert_eq!(
        store.get_bench_for_task(task_id).unwrap(),
        Some((rsid("runspace-x"), "/b".to_string()))
    );
    assert_eq!(
        store.list_bench_runspace_map().unwrap(),
        vec![(rsid("runspace-x"), task_id.clone())]
    );
}

/// `list_bench_runspace_map` returns `(runspace_id, task_id)` — the pair the workbench uses to map
/// a restored runspace back to its task. Two benches, so a swapped or cross-wired pairing shows up
/// as a mismatch rather than passing by symmetry.
#[test]
fn list_bench_runspace_map_pairs_each_runspace_with_its_own_task() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let first = db.insert_task(dev_task("first")).unwrap();
    let second = db.insert_task(dev_task("second")).unwrap();
    db.create_bench(&first.id, &rsid("bench-first"), "/a").unwrap();
    db.create_bench(&second.id, &rsid("bench-second"), "/b").unwrap();

    let mut map = db.list_bench_runspace_map().unwrap();
    map.sort();
    assert_eq!(
        map,
        vec![(rsid("bench-first"), first.id), (rsid("bench-second"), second.id)]
    );
}

fn task_run_contract<S: TaskRunStore + ?Sized>(store: &mut S, task_id: &TaskId) -> TaskRunId {
    let run = store
        .start_task_run(NewTaskRun {
            task_id: task_id.clone(),
            agent: None,
            branch: Some("br".to_string()),
            worktree_path: None,
        })
        .unwrap();
    let got = store.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(got.branch.as_deref(), Some("br"));
    assert_eq!(got.status, TaskRunStatus::SettingUp);
    store.set_task_run_worktree_path(&run.id, "/wt").unwrap();
    assert_eq!(
        store.get_task_run(&run.id).unwrap().unwrap().worktree_path.as_deref(),
        Some("/wt")
    );
    run.id
}

/// The same store operations must behave identically whether a caller drives `SqliteStore`
/// directly or through a `WorkTransaction` — guarding the shared `*_in` helpers against drift
/// between the two code paths.
#[test]
fn store_contract_holds_for_direct_and_transactional_paths() {
    // Direct path.
    let mut direct = SqliteStore::open_in_memory().unwrap();
    let direct_task = direct.insert_task(dev_task("direct")).unwrap();
    workbench_contract(&mut direct, &direct_task.id);
    task_run_contract(&mut direct, &direct_task.id);

    // Transactional path: the same contract, then committed and re-read on the base store.
    let mut tx_store = SqliteStore::open_in_memory().unwrap();
    let tx_task = tx_store.insert_task(dev_task("transactional")).unwrap();
    let run_id = {
        let mut tx = tx_store.begin().unwrap();
        workbench_contract(&mut *tx, &tx_task.id);
        let run_id = task_run_contract(&mut *tx, &tx_task.id);
        tx.commit().unwrap();
        run_id
    };
    assert_eq!(
        tx_store.get_bench_for_task(&tx_task.id).unwrap(),
        Some((rsid("runspace-x"), "/b".to_string()))
    );
    assert_eq!(
        tx_store.get_task_run(&run_id).unwrap().unwrap().worktree_path.as_deref(),
        Some("/wt")
    );
}


fn attach_tab(db: &mut SqliteStore, task_id: &TaskId, tab_id: &str, session: &str) -> TabAttachment {
    db.attach_terminal_tab_to_task(
        NewTaskRun {
            task_id: task_id.clone(),
            agent: Some(Agent::Claude),
            branch: None,
            worktree_path: None,
        },
        tab_id,
        Some(&AgentSessionId::from_agent(session)),
    )
    .unwrap()
}

/// `monica task attach` lands a `running` run already carrying its tab and session. The store leaves
/// the primary pointer alone: whether the run may take the Main Run slot is the use case's call.
#[test]
fn attach_terminal_tab_to_task_stamps_tab_and_session_without_taking_the_primary() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("attach-target")).unwrap();

    let attachment = attach_tab(&mut db, &task.id, "tab-1", "sess-1");

    assert!(attachment.detached_run_ids.is_empty());
    assert_eq!(attachment.run.status, TaskRunStatus::Running);
    assert_eq!(attachment.run.terminal_tab_id.as_deref(), Some("tab-1"));
    assert_eq!(
        attachment.run.agent_session_id,
        Some(AgentSessionId::from_agent("sess-1"))
    );
    assert_eq!(attachment.run.branch, None);
    assert_eq!(attachment.run.worktree_path, None);
    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().primary_task_run_id,
        None,
        "the store binds the tab only; the primary pointer belongs to the use case"
    );
    assert_eq!(
        db.find_task_run_by_terminal_tab("tab-1").unwrap().map(|run| run.id),
        Some(attachment.run.id)
    );
}

/// Re-attaching a tab settles the run it was driving before unbinding it. Every path that stops a
/// run keys on `terminal_tab_id`, so clearing the tab without settling would leave the old run
/// `running` on its task's board forever, with nothing left to move it. The live session moves
/// with the tab: the old run must not keep naming it, or it would stay resumable under a task the
/// conversation no longer belongs to.
#[test]
fn re_attach_settles_the_previous_run_and_takes_its_session_along() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let first = db.insert_task(dev_task("first")).unwrap();
    let second = db.insert_task(dev_task("second")).unwrap();

    let old = attach_tab(&mut db, &first.id, "tab-1", "sess-1");
    let new = attach_tab(&mut db, &second.id, "tab-1", "sess-1");

    assert_eq!(new.detached_run_ids, vec![old.run.id.clone()]);

    let old = db.get_task_run(&old.run.id).unwrap().unwrap();
    assert_eq!(old.status, TaskRunStatus::Stopped);
    assert_eq!(old.terminal_tab_id, None);
    assert_eq!(old.agent_session_id, None, "the session now drives the second task");
    assert!(old.resumable_session().is_none());
    assert_eq!(
        db.find_task_run_by_terminal_tab("tab-1").unwrap().map(|run| run.id),
        Some(new.run.id),
        "exactly one run answers for the tab"
    );
}

/// A tab whose earlier agent already exited keeps that session on the old run when a *new* agent
/// in the same tab is attached elsewhere: nothing live shares the id, so it is still history.
#[test]
fn re_attach_with_a_different_session_keeps_the_old_one_as_history() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let first = db.insert_task(dev_task("first")).unwrap();
    let second = db.insert_task(dev_task("second")).unwrap();

    let old = attach_tab(&mut db, &first.id, "tab-1", "sess-1");
    attach_tab(&mut db, &second.id, "tab-1", "sess-2");

    let old = db.get_task_run(&old.run.id).unwrap().unwrap();
    assert_eq!(old.terminal_tab_id, None);
    assert_eq!(old.agent_session_id, Some(AgentSessionId::from_agent("sess-1")));
}

/// The detached run drops out of the orphan sweep's candidate set (it no longer has a tab), which
/// is only safe because it was settled on the way out.
#[test]
fn a_detached_run_leaves_the_orphan_sweep_already_settled() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let first = db.insert_task(dev_task("first")).unwrap();
    let second = db.insert_task(dev_task("second")).unwrap();

    let old = attach_tab(&mut db, &first.id, "tab-1", "sess-1");
    assert!(db
        .list_driven_task_runs_with_tab()
        .unwrap()
        .iter()
        .any(|run| run.id == old.run.id));

    attach_tab(&mut db, &second.id, "tab-1", "sess-1");

    assert!(
        !db.list_driven_task_runs_with_tab()
            .unwrap()
            .iter()
            .any(|run| run.id == old.run.id),
        "the detached run is out of the sweep, and already terminal"
    );
    assert!(db.get_task_run(&old.run.id).unwrap().unwrap().status.is_terminal());
}

/// An already-settled previous run is left exactly as it was: the settle step reuses the store's
/// live-only guard rather than forcing every detached run to `stopped`.
#[test]
fn re_attach_leaves_an_already_settled_previous_run_untouched() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let first = db.insert_task(dev_task("first")).unwrap();
    let second = db.insert_task(dev_task("second")).unwrap();

    let old = attach_tab(&mut db, &first.id, "tab-1", "sess-1");
    db.finish_task_run(&old.run.id, &first.id, TaskRunStatus::Failed).unwrap();

    attach_tab(&mut db, &second.id, "tab-1", "sess-1");

    assert_eq!(
        db.get_task_run(&old.run.id).unwrap().unwrap().status,
        TaskRunStatus::Failed
    );
}
