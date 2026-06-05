use monica_core::{
    Agent, DisplayStatus, ExternalRef, GithubPullRequest, GithubPullRequestStatus, NewTask,
    NewTaskRun, Project, PullRequestSyncCandidate, RefType, TaskKind, TaskRunObservation,
    TaskRunStatus, TaskRunWaitReason, TaskStatus,
};
use serde_json::json;

use super::SqliteStore;

fn dev_task(title: &str) -> NewTask {
    NewTask::new(TaskKind::Development, title)
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
    assert_eq!(db.get_task(&task.id).unwrap().unwrap().status, TaskStatus::Done);
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
fn project_round_trip_and_summary_pr_status_stay_wire_compatible() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/repo".to_string());
    db.upsert_project(&project).unwrap();

    let mut task = dev_task("with pr");
    task.project_id = Some(project.id.clone());
    let item = db.insert_task(task).unwrap();
    let candidate = PullRequestSyncCandidate {
        task_id: item.id.clone(),
        source_ref_id: db
            .save_external_ref(&ExternalRef::new(
                &item.id,
                RefType::GithubIssue,
                Some("owner/repo".to_string()),
                Some(42),
                None,
            ))
            .unwrap(),
        repo: "owner/repo".to_string(),
        issue_number: 42,
    };
    db.record_pull_request_sync_success(
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
    assert_eq!(summaries[0].github_pull_requests[0].status.as_deref(), Some("open"));
}
