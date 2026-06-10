use monica_core::{
    Agent, DisplayStatus, ExternalRef, GithubPullRequest, GithubPullRequestStatus, NewTask,
    NewTaskRun, Project, PullRequestBranchSyncCandidate, RefType, TaskKind, TaskRunObservation,
    TaskRunStatus, TaskRunWaitReason, TaskStatus,
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
fn find_task_run_by_terminal_tab_returns_latest_run_in_tab() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("tab lookup")).unwrap();
    let observe = |db: &mut SqliteStore, run_id: &str, session: &str| {
        db.record_task_run_observation(
            run_id,
            TaskRunObservation {
                status: Some(TaskRunStatus::Running),
                wait_reason: None,
                event_name: Some("SessionStart"),
                at: "2026-06-02T00:00:00.000Z",
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
    observe(&mut db, &first.id, "sess-1");
    let second = db.start_task_run(new_run).unwrap();
    observe(&mut db, &second.id, "sess-2");

    let found = db.find_task_run_by_terminal_tab("tab-1").unwrap().unwrap();
    assert_eq!(found.id, second.id);
    assert!(db.find_task_run_by_terminal_tab("tab-x").unwrap().is_none());
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

    let side_running = db.start_task_run(new_run(&task.id)).unwrap();
    observe(&mut db, &side_running.id, TaskRunStatus::Running, "sess-2");
    let side_waiting = db.start_task_run(new_run(&task.id)).unwrap();
    observe(
        &mut db,
        &side_waiting.id,
        TaskRunStatus::WaitingForUser,
        "sess-3",
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
