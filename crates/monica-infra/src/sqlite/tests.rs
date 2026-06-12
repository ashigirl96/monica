use monica_core::{
    Agent, DisplayStatus, ExternalRef, GithubPullRequest, GithubPullRequestStatus, NewTask,
    NewTaskRun, NewTerminalSession, Project, ProjectRepository, PullRequestBranchSyncCandidate,
    RefType, TaskKind, TaskRepository, TaskRunObservation, TaskRunRepository, TaskRunStatus,
    TaskRunWaitReason, TaskStatus, TerminalSessionKind, TerminalSessionStatus,
    TerminalSessionUpdate,
};
use rusqlite::params;
use serde_json::json;

use super::SqliteStore;

fn dev_task(title: &str) -> NewTask {
    NewTask::new(TaskKind::Development, title)
}

fn project_task_with_branch(
    db: &mut SqliteStore,
    repo: &str,
    default_branch: &str,
    branch: &str,
) -> (String, PullRequestBranchSyncCandidate) {
    let mut project = Project::from_repo(repo);
    project.default_branch = default_branch.to_string();
    db.upsert_project(&project).unwrap();
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
            task_id: item.id,
            repo: repo.to_string(),
            branch: branch.to_string(),
        },
    )
}

fn branch_retry_delay_seconds(db: &SqliteStore, task_id: &str) -> i64 {
    db.conn()
        .query_row(
            "SELECT CAST(round((julianday(next_retry_at) - julianday(COALESCE(last_synced_at, created_at))) * 86400.0) AS INTEGER)
             FROM github_pull_request_branch_syncs
             WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn task_and_external_ref_round_trip_through_sqlite_repository() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let mut task = dev_task("tracked issue");
    task.status = TaskStatus::Ready;
    let item = db
        .insert_task_with_ref(
            task,
            ExternalRef::new(
                "",
                RefType::GithubIssue,
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
    assert_eq!(refs[0].ref_type, RefType::GithubIssue);
    assert_eq!(refs[0].number, Some(42));
}

#[test]
fn task_run_agent_is_typed_and_done_task_is_not_regressed_by_finish() {
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

    db.mark_task(&task.id, TaskStatus::Done, None).unwrap();
    db.finish_task_run(&run.id, &task.id, TaskRunStatus::Running)
        .unwrap();
    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().status,
        TaskStatus::Done
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
    let metadata = json!({ "hook_event_name": "PreToolUse" });
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::WaitingForUser),
            wait_reason: Some(Some(TaskRunWaitReason::AskUserQuestion)),
            event_name: Some("PreToolUse"),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: Some("provider-session"),
            terminal_tab_id: Some("tab-1"),
            metadata: Some(&metadata),
        },
    )
    .unwrap();

    let run = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AskUserQuestion));
    assert_eq!(run.provider_session_id.as_deref(), Some("provider-session"));
    assert_eq!(run.terminal_tab_id.as_deref(), Some("tab-1"));
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
        event_name: Some("Stop"),
        at: "2026-06-02T00:00:00.000Z",
        provider_session_id: None,
        terminal_tab_id: None,
        metadata: None,
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

    // A trailing Stop must not blur a pending question into a generic wait.
    let asking = start_run(&mut db);
    db.record_task_run_observation(
        &asking.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::WaitingForUser),
            wait_reason: Some(Some(TaskRunWaitReason::AskUserQuestion)),
            event_name: Some("PreToolUse"),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: None,
            terminal_tab_id: None,
            metadata: None,
        },
    )
    .unwrap();
    db.record_task_run_observation(&asking.id, generic_wait)
        .unwrap();
    let run = db.get_task_run(&asking.id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AskUserQuestion));

    // Failed is sticky against any transition.
    let failed = start_run(&mut db);
    db.finish_task_run(&failed.id, &task.id, TaskRunStatus::Failed)
        .unwrap();
    for status in [
        TaskRunStatus::Running,
        TaskRunStatus::Stopped,
        TaskRunStatus::WaitingForUser,
    ] {
        db.record_task_run_observation(
            &failed.id,
            TaskRunObservation {
                status: Some(status),
                wait_reason: Some(None),
                event_name: None,
                at: "2026-06-02T00:00:00.000Z",
                provider_session_id: None,
                terminal_tab_id: None,
                metadata: None,
            },
        )
        .unwrap();
        assert_eq!(
            db.get_task_run(&failed.id).unwrap().unwrap().status,
            TaskRunStatus::Failed,
            "{status:?}"
        );
    }

    // A real prompt does revive a stopped run: only the generic wait is refused.
    let revived = start_run(&mut db);
    db.finish_task_run(&revived.id, &task.id, TaskRunStatus::Stopped)
        .unwrap();
    db.record_task_run_observation(
        &revived.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Running),
            wait_reason: Some(None),
            event_name: Some("UserPromptSubmit"),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: None,
            terminal_tab_id: None,
            metadata: None,
        },
    )
    .unwrap();
    assert_eq!(
        db.get_task_run(&revived.id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );
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
            event_name: Some("SessionStart"),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: Some("sess-1"),
            terminal_tab_id: Some("tab-1"),
            metadata: None,
        },
    )
    .unwrap();
    db.record_task_run_observation(
        &run.id,
        TaskRunObservation {
            status: Some(TaskRunStatus::Stopped),
            wait_reason: None,
            event_name: Some("Stop"),
            at: "2026-06-02T00:00:01.000Z",
            provider_session_id: None,
            terminal_tab_id: None,
            metadata: None,
        },
    )
    .unwrap();

    let run = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(run.provider_session_id.as_deref(), Some("sess-1"));
    assert_eq!(run.terminal_tab_id.as_deref(), Some("tab-1"));
}

#[test]
fn find_task_run_by_terminal_tab_returns_latest_observed_run_in_tab() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("tab lookup")).unwrap();
    let observe = |db: &mut SqliteStore, run_id: &str, session: &str, at: &str| {
        db.record_task_run_observation(
            run_id,
            TaskRunObservation {
                status: Some(TaskRunStatus::Running),
                wait_reason: None,
                event_name: Some("SessionStart"),
                at,
                provider_session_id: Some(session),
                terminal_tab_id: Some("tab-1"),
                metadata: None,
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
fn start_task_run_never_reopens_a_done_task() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("done stays done")).unwrap();
    db.update_task_status(&task.id, TaskStatus::Done).unwrap();

    db.start_task_run(NewTaskRun {
        task_id: task.id.clone(),
        agent: None,
        branch: None,
        worktree_path: None,
    })
    .unwrap();

    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().status,
        TaskStatus::Done
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
            event_name: Some("SessionStart"),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: Some("sess-shared"),
            terminal_tab_id: None,
            metadata: None,
        },
    )
    .unwrap();

    let found = db
        .find_task_run_by_session(&task_a.id, "sess-shared")
        .unwrap()
        .unwrap();
    assert_eq!(found.id, run_a.id);
    assert!(db
        .find_task_run_by_session(&task_b.id, "sess-shared")
        .unwrap()
        .is_none());
}

#[test]
fn task_summaries_count_side_runs_excluding_primary_and_sessionless_failures() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("side runs")).unwrap();
    let bare_task = db.insert_task(dev_task("no runs")).unwrap();
    let new_run = |task_id: &str| NewTaskRun {
        task_id: task_id.to_string(),
        agent: None,
        branch: None,
        worktree_path: None,
    };
    let observe = |db: &mut SqliteStore, run_id: &str, status: TaskRunStatus, session: &str| {
        db.record_task_run_observation(
            run_id,
            TaskRunObservation {
                status: Some(status),
                wait_reason: None,
                event_name: None,
                at: "2026-06-02T00:00:00.000Z",
                provider_session_id: Some(session),
                terminal_tab_id: None,
                metadata: None,
            },
        )
        .unwrap();
    };

    let primary = db.start_task_run(new_run(&task.id)).unwrap();
    observe(&mut db, &primary.id, TaskRunStatus::Running, "sess-main");
    db.set_primary_task_run(&task.id, &primary.id).unwrap();

    let observe_waiting =
        |db: &mut SqliteStore, run_id: &str, reason: TaskRunWaitReason, session: &str| {
            db.record_task_run_observation(
                run_id,
                TaskRunObservation {
                    status: Some(TaskRunStatus::WaitingForUser),
                    wait_reason: Some(Some(reason)),
                    event_name: None,
                    at: "2026-06-02T00:00:00.000Z",
                    provider_session_id: Some(session),
                    terminal_tab_id: None,
                    metadata: None,
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

    let summaries = db.list_task_summaries(None, None).unwrap();
    let summary = summaries.iter().find(|s| s.id == task.id).unwrap();
    assert_eq!(summary.task_run_status, Some(TaskRunStatus::Running));
    assert_eq!(summary.side_runs_running, 1);
    assert_eq!(summary.side_runs_waiting_for_user, 1);
    assert_eq!(summary.side_runs_failed, 1);

    let bare = summaries.iter().find(|s| s.id == bare_task.id).unwrap();
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
            event_name: Some("SessionStart"),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: Some("sess-1"),
            terminal_tab_id: None,
            metadata: None,
        },
    )
    .unwrap();
    db.set_primary_task_run(&task.id, "run-999").unwrap();

    let summaries = db.list_task_summaries(None, None).unwrap();
    let summary = summaries.iter().find(|s| s.id == task.id).unwrap();
    // The task's only run is its de-facto main run, not a side run.
    assert_eq!(summary.task_run_status, Some(TaskRunStatus::Running));
    assert_eq!(summary.side_runs_running, 0);
}

#[test]
fn migration_creates_pull_request_branch_sync_state_table() {
    let db = SqliteStore::open_in_memory().unwrap();
    let count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'github_pull_request_branch_syncs'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn project_round_trip_and_summary_pr_status_stay_wire_compatible() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/repo".to_string());
    db.upsert_project(&project).unwrap();

    let mut task = dev_task("with pr");
    task.project_id = Some(project.id.clone());
    let item = db.insert_task(task).unwrap();
    let candidate = PullRequestBranchSyncCandidate {
        task_id: item.id.clone(),
        repo: "owner/repo".to_string(),
        branch: "issue-42".to_string(),
    };
    db.record_pull_request_branch_sync_success(
        &candidate,
        &[GithubPullRequest {
            repo: "owner/repo".to_string(),
            number: 7,
            url: "https://github.com/owner/repo/pull/7".to_string(),
            status: GithubPullRequestStatus::Open,
        }],
    )
    .unwrap();

    let summaries = db
        .list_task_summaries(Some(DisplayStatus::Inbox), Some("owner/repo"))
        .unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(
        summaries[0].github_pull_requests[0].status.as_deref(),
        Some("open")
    );
}

#[test]
fn branch_pull_request_candidate_uses_latest_run_branch_and_project_repo() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let mut project = Project::from_repo("owner/repo");
    project.default_branch = "main".to_string();
    db.upsert_project(&project).unwrap();
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

    let candidate = db
        .next_pull_request_branch_sync_candidate()
        .unwrap()
        .unwrap();
    assert_eq!(
        candidate,
        PullRequestBranchSyncCandidate {
            task_id: item.id,
            repo: "owner/repo".to_string(),
            branch: "feature/new-branch".to_string(),
        }
    );
}

#[test]
fn branch_pull_request_candidate_skips_main_master_and_default_branch() {
    for branch in ["main", "master", "trunk"] {
        let mut db = SqliteStore::open_in_memory().unwrap();
        project_task_with_branch(&mut db, "owner/repo", "trunk", branch);
        assert!(db
            .next_pull_request_branch_sync_candidate()
            .unwrap()
            .is_none());
    }
}

#[test]
fn empty_branch_pr_sync_result_defers_candidate_so_queue_can_advance() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let (first_id, first_candidate) =
        project_task_with_branch(&mut db, "owner/repo", "main", "feature/first");
    let (second_id, _) = project_task_with_branch(&mut db, "owner/repo", "main", "feature/second");

    db.record_pull_request_branch_sync_success(&first_candidate, &[])
        .unwrap();

    let (next_retry_at, last_error) = db
        .conn()
        .query_row(
            "SELECT next_retry_at, last_error FROM github_pull_request_branch_syncs WHERE task_id = ?1",
            params![&first_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .unwrap();
    assert!(next_retry_at.is_some());
    assert_eq!(last_error, None);
    assert!((55..=65).contains(&branch_retry_delay_seconds(&db, &first_id)));

    let next = db
        .next_pull_request_branch_sync_candidate()
        .unwrap()
        .unwrap();
    assert_eq!(next.task_id, second_id);
}

#[test]
fn branch_pr_sync_retry_policy_depends_on_result() {
    for (status, expected_range) in [
        (GithubPullRequestStatus::Open, 55..=65),
        (GithubPullRequestStatus::Draft, 55..=65),
        (GithubPullRequestStatus::Merged, 895..=905),
        (GithubPullRequestStatus::Closed, 895..=905),
    ] {
        let mut db = SqliteStore::open_in_memory().unwrap();
        let (task_id, candidate) =
            project_task_with_branch(&mut db, "owner/repo", "main", "feature/retry");
        db.record_pull_request_branch_sync_success(
            &candidate,
            &[GithubPullRequest {
                repo: "owner/repo".to_string(),
                number: 7,
                url: "https://github.com/owner/repo/pull/7".to_string(),
                status,
            }],
        )
        .unwrap();
        assert!(expected_range.contains(&branch_retry_delay_seconds(&db, &task_id)));
    }
}

#[test]
fn branch_pr_sync_failure_retries_after_five_minutes() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let (task_id, candidate) =
        project_task_with_branch(&mut db, "owner/repo", "main", "feature/fails");
    db.record_pull_request_branch_sync_failure(&candidate, "temporary GitHub failure")
        .unwrap();

    let (last_error, delay): (Option<String>, i64) = db
        .conn()
        .query_row(
            "SELECT last_error,
                    CAST(round((julianday(next_retry_at) - julianday(created_at)) * 86400.0) AS INTEGER)
             FROM github_pull_request_branch_syncs
             WHERE task_id = ?1",
            params![&task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(last_error.as_deref(), Some("temporary GitHub failure"));
    assert!((295..=305).contains(&delay));
}

#[test]
fn force_clear_pr_sync_state_resets_branch_syncs_and_open_pr_states() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    // Set up a branch sync with a future next_retry_at (via failure)
    let (_, open_candidate) =
        project_task_with_branch(&mut db, "owner/repo", "main", "feature/open");
    db.record_pull_request_branch_sync_failure(&open_candidate, "transient error")
        .unwrap();

    // Set up an open PR state via branch sync success
    db.record_pull_request_branch_sync_success(
        &open_candidate,
        &[GithubPullRequest {
            repo: "owner/repo".to_string(),
            number: 1,
            url: "https://github.com/owner/repo/pull/1".to_string(),
            status: GithubPullRequestStatus::Open,
        }],
    )
    .unwrap();

    // Set up a merged PR state (should NOT be cleared by force_clear)
    let (_, merged_candidate) =
        project_task_with_branch(&mut db, "owner/repo", "main", "feature/merged");
    db.record_pull_request_branch_sync_success(
        &merged_candidate,
        &[GithubPullRequest {
            repo: "owner/repo".to_string(),
            number: 2,
            url: "https://github.com/owner/repo/pull/2".to_string(),
            status: GithubPullRequestStatus::Merged,
        }],
    )
    .unwrap();

    // Action
    db.force_clear_pr_sync_state().unwrap();

    // Branch sync: next_retry_at should be NULL for all rows
    let branch_retry: Option<String> = db
        .conn()
        .query_row(
            "SELECT next_retry_at FROM github_pull_request_branch_syncs WHERE task_id = ?1",
            params![&open_candidate.task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(branch_retry, None, "branch next_retry_at should be cleared");

    // Open PR state: synced_at and next_retry_at should be NULL
    let (open_synced_at, open_retry): (Option<String>, Option<String>) = db
        .conn()
        .query_row(
            "SELECT synced_at, next_retry_at FROM github_pull_request_ref_states WHERE status = 'open'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(open_synced_at, None, "open PR synced_at should be cleared");
    assert_eq!(open_retry, None, "open PR next_retry_at should be cleared");

    // Merged PR state: synced_at should remain (terminal states not touched)
    let merged_synced_at: Option<String> = db
        .conn()
        .query_row(
            "SELECT synced_at FROM github_pull_request_ref_states WHERE status = 'merged'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        merged_synced_at.is_some(),
        "merged PR synced_at should NOT be cleared"
    );
}

fn new_shell_session(runspace: Option<&str>, tab: Option<&str>) -> NewTerminalSession {
    NewTerminalSession {
        runspace_id: runspace.map(str::to_string),
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
    let observe = |db: &mut SqliteStore, run_id: &str, status: TaskRunStatus| {
        db.record_task_run_observation(
            run_id,
            TaskRunObservation {
                status: Some(status),
                wait_reason: None,
                event_name: None,
                at: "2026-06-02T00:00:00.000Z",
                provider_session_id: Some("sess-1"),
                terminal_tab_id: None,
                metadata: None,
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

    // A hook-created run parked at setting_up settles only once a session was observed on it.
    let observed = start_run(&mut db);
    db.record_task_run_observation(
        &observed.id,
        TaskRunObservation {
            status: None,
            wait_reason: None,
            event_name: Some("SessionStart"),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: Some("sess-2"),
            terminal_tab_id: Some("tab-1"),
            metadata: None,
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
    let scoped = db.list_terminal_sessions(Some("rs-1")).unwrap();
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0].runspace_id.as_deref(), Some("rs-1"));
}

#[test]
fn terminal_state_snapshot_round_trips_session_id() {
    use crate::sqlite::{TerminalRunspaceRow, TerminalStateSnapshot, TerminalTabRow};

    let mut db = SqliteStore::open_in_memory().unwrap();
    let snapshot = TerminalStateSnapshot {
        runspaces: vec![TerminalRunspaceRow {
            id: "rs-1".into(),
            sort_order: 0,
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
    db.save_terminal_state(&snapshot).unwrap();

    let loaded = db.load_terminal_state().unwrap();
    let tabs = &loaded.runspaces[0].tabs;
    assert_eq!(tabs[0].terminal_session_id.as_deref(), Some("ts-1"));
    assert_eq!(tabs[1].terminal_session_id, None);
}
