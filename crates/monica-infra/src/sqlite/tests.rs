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
            metadata: Some(&metadata),
        },
    )
    .unwrap();

    let run = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AskUserQuestion));
    assert_eq!(run.provider_session_id.as_deref(), Some("provider-session"));
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
fn task_summary_uses_active_run_before_latest_run() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("active run")).unwrap();
    let active = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: Some("active-branch".to_string()),
            worktree_path: None,
        })
        .unwrap();
    db.finish_task_run(&active.id, &task.id, TaskRunStatus::Running)
        .unwrap();
    let latest = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: Some("latest-branch".to_string()),
            worktree_path: None,
        })
        .unwrap();
    db.finish_task_run(&latest.id, &task.id, TaskRunStatus::Failed)
        .unwrap();

    db.set_active_task_run(&task.id, &active.id).unwrap();

    let summary = db.list_task_summaries(None, None).unwrap().remove(0);
    assert_eq!(
        summary.active_task_run_id.as_deref(),
        Some(active.id.as_str())
    );
    assert_eq!(summary.task_run_id.as_deref(), Some(active.id.as_str()));
    assert_eq!(summary.branch.as_deref(), Some("active-branch"));
    assert_eq!(summary.task_run_status, Some(TaskRunStatus::Running));
    assert_eq!(summary.status, DisplayStatus::Running);
}

#[test]
fn task_summary_falls_back_to_latest_run_without_active_run() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("latest run")).unwrap();
    db.start_task_run(NewTaskRun {
        task_id: task.id.clone(),
        agent: None,
        branch: Some("old-branch".to_string()),
        worktree_path: None,
    })
    .unwrap();
    let latest = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: Some("latest-branch".to_string()),
            worktree_path: None,
        })
        .unwrap();

    let summary = db.list_task_summaries(None, None).unwrap().remove(0);
    assert_eq!(summary.active_task_run_id, None);
    assert_eq!(summary.task_run_id.as_deref(), Some(latest.id.as_str()));
    assert_eq!(summary.branch.as_deref(), Some("latest-branch"));
}

#[test]
fn set_active_task_run_rejects_run_from_another_task() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("task")).unwrap();
    let other = db.insert_task(dev_task("other")).unwrap();
    let other_run = db
        .start_task_run(NewTaskRun {
            task_id: other.id,
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();

    let err = db.set_active_task_run(&task.id, &other_run.id).unwrap_err();
    assert!(err.to_string().contains("is not linked"));
    assert_eq!(
        db.get_task(&task.id).unwrap().unwrap().active_task_run_id,
        None
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
