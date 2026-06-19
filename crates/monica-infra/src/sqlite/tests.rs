use monica_core::{
    Agent, ArtifactDraftKind, ArtifactRepository, DisplayStatus, ExternalRef, GithubPullRequest,
    GithubPullRequestStatus, NewDraft, NewTask, NewTaskRun, NewTerminalSession, Project,
    ProjectRepository, PullRequestBranchSyncCandidate, RefType, TaskKind, TaskRepository,
    TaskRunObservation, TaskRunRepository, TaskRunStatus, TaskRunWaitReason, TaskStatus,
    TaskSummaryFilter, TaskSummaryRow, TerminalSessionKind, TerminalSessionStatus,
    TerminalSessionUpdate,
};
use rusqlite::params;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

fn temp_artifact_store(name: &str) -> (PathBuf, SqliteStore) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("monica-{name}-{}-{nanos}", std::process::id()));
    let db_dir = root.join("db");
    std::fs::create_dir_all(&db_dir).unwrap();
    let db = SqliteStore::open_at(db_dir.join("monica.db")).unwrap();
    (root, db)
}

fn attach_file_to_entry(db: &mut SqliteStore, root: &Path, entry_id: &str) -> PathBuf {
    let entry_dir = root.join("attachments").join(entry_id);
    std::fs::create_dir_all(&entry_dir).unwrap();
    std::fs::write(entry_dir.join("image.png"), b"png").unwrap();
    db.insert_attachment(
        entry_id,
        "image.png",
        Some("image/png"),
        3,
        &format!("{entry_id}/image.png"),
    )
    .unwrap();
    assert!(entry_dir.join("image.png").exists());
    entry_dir
}

#[test]
fn drafts_round_trip_with_attachments() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let draft = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Memo,
            body: "draft with image".to_string(),
            occurred_at: None,
        })
        .unwrap();
    let attachment = db
        .insert_attachment(
            &draft.id,
            "image.png",
            Some("image/png"),
            123,
            &format!("{}/ATT-1.png", draft.id),
        )
        .unwrap();

    let fetched = db.get_draft(&draft.id).unwrap().unwrap();
    assert_eq!(fetched.attachments, vec![attachment.clone()]);

    let drafts = db.list_drafts().unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].attachments, vec![attachment]);
}

#[test]
fn delete_draft_removes_attachment_directory() {
    let (root, mut db) = temp_artifact_store("delete-draft-attachments");
    let draft = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Memo,
            body: "draft with image".to_string(),
            occurred_at: None,
        })
        .unwrap();
    let entry_dir = attach_file_to_entry(&mut db, &root, &draft.id);

    db.delete_draft(&draft.id).unwrap();

    assert!(db.get_draft(&draft.id).unwrap().is_none());
    assert!(!entry_dir.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn delete_artifact_removes_attachment_directory() {
    let (root, mut db) = temp_artifact_store("delete-artifact-attachments");
    let draft = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Memo,
            body: "saved artifact with image".to_string(),
            occurred_at: None,
        })
        .unwrap();
    let entry_dir = attach_file_to_entry(&mut db, &root, &draft.id);
    let artifact = monica_core::artifact_ops::save_draft(&mut db, &draft.id).unwrap();

    db.delete_artifact(&artifact.id).unwrap();

    assert!(db.get_artifact(&artifact.id).unwrap().is_none());
    assert!(!entry_dir.exists());
    let _ = std::fs::remove_dir_all(root);
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
            event_name: Some("UserPromptSubmit"),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: Some("sess-old"),
            terminal_tab_id: None,
            metadata: None,
        },
    )
    .unwrap();
    db.finish_task_run(&relaunched.id, &task.id, TaskRunStatus::Stopped)
        .unwrap();
    let generic_wait_from = |session: &'static str, event: &'static str| TaskRunObservation {
        status: Some(TaskRunStatus::WaitingForUser),
        wait_reason: Some(Some(TaskRunWaitReason::AwaitingPrompt)),
        event_name: Some(event),
        at: "2026-06-02T00:00:00.000Z",
        provider_session_id: Some(session),
        terminal_tab_id: None,
        metadata: None,
    };
    db.record_task_run_observation(&relaunched.id, generic_wait_from("sess-old", "Stop"))
        .unwrap();
    assert_eq!(
        db.get_task_run(&relaunched.id).unwrap().unwrap().status,
        TaskRunStatus::Stopped
    );
    db.record_task_run_observation(
        &relaunched.id,
        generic_wait_from("sess-new", "SessionStart"),
    )
    .unwrap();
    let run = db.get_task_run(&relaunched.id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::WaitingForUser);
    assert_eq!(run.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
    assert_eq!(run.provider_session_id.as_deref(), Some("sess-new"));

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

    // A terminal verdict is scoped to the session that died: a stale SessionEnd from the
    // previous session must not kill the run its successor now drives, while the successor's
    // own verdict (or an anonymous one) still lands.
    let terminal_verdict_from = |session: Option<&'static str>,
                                 status: TaskRunStatus,
                                 event: &'static str| TaskRunObservation {
        status: Some(status),
        wait_reason: Some(None),
        event_name: Some(event),
        at: "2026-06-02T00:00:00.000Z",
        provider_session_id: session,
        terminal_tab_id: None,
        metadata: None,
    };
    for (status, event) in [(TaskRunStatus::Stopped, "SessionEnd")] {
        let survivor = start_run(&mut db);
        db.record_task_run_observation(
            &survivor.id,
            TaskRunObservation {
                status: Some(TaskRunStatus::Running),
                wait_reason: None,
                event_name: Some("UserPromptSubmit"),
                at: "2026-06-02T00:00:00.000Z",
                provider_session_id: Some("sess-new"),
                terminal_tab_id: None,
                metadata: None,
            },
        )
        .unwrap();
        // Two stragglers in a row: the first must not re-stamp sess-old onto the run, or the
        // second would look same-session and land.
        for _ in 0..2 {
            db.record_task_run_observation(
                &survivor.id,
                terminal_verdict_from(Some("sess-old"), status, event),
            )
            .unwrap();
            let run = db.get_task_run(&survivor.id).unwrap().unwrap();
            assert_eq!(run.status, TaskRunStatus::Running, "{event}");
            assert_eq!(run.provider_session_id.as_deref(), Some("sess-new"), "{event}");
        }
        db.record_task_run_observation(
            &survivor.id,
            terminal_verdict_from(Some("sess-new"), status, event),
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
            event_name: Some("UserPromptSubmit"),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: Some("sess-new"),
            terminal_tab_id: None,
            metadata: None,
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

fn record_observation(
    db: &mut SqliteStore,
    run_id: &str,
    event: &str,
    status: Option<TaskRunStatus>,
    metadata: Option<&serde_json::Value>,
) {
    db.record_task_run_observation(
        run_id,
        TaskRunObservation {
            status,
            wait_reason: status.map(|s| match s {
                TaskRunStatus::WaitingForUser => Some(TaskRunWaitReason::AwaitingPrompt),
                _ => None,
            }),
            event_name: Some(event),
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: Some("sess-1"),
            terminal_tab_id: None,
            metadata,
        },
    )
    .unwrap();
}

/// A `Stop` fires at the end of the parent's turn even while a subagent (Task tool) is still
/// running. The store's `active_subagents` counter must hold the run `Running` across that Stop
/// and only release it once the subagent ends — exercising the SQL guard directly, since hooks
/// land out-of-process and the caller's snapshot check is advisory.
#[test]
fn task_run_observation_holds_stop_while_subagent_runs() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("subagent")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();

    let observe = |db: &mut SqliteStore, event: &str, status: Option<TaskRunStatus>, source: Option<&str>| {
        let metadata = source.map(|s| serde_json::json!({ "source": s }));
        record_observation(db, &run.id, event, status, metadata.as_ref());
    };
    let count = |db: &SqliteStore| db.get_task_run(&run.id).unwrap().unwrap().active_subagents;

    // The turn is live, then a subagent starts.
    observe(&mut db, "UserPromptSubmit", Some(TaskRunStatus::Running), None);
    assert_eq!(count(&db), 0);
    observe(&mut db, "SubagentStart", None, None);
    assert_eq!(count(&db), 1);

    // The trailing Stop is held: the run stays Running rather than dropping to "your turn".
    observe(&mut db, "Stop", Some(TaskRunStatus::WaitingForUser), None);
    let after_stop = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(after_stop.status, TaskRunStatus::Running);
    assert_eq!(after_stop.wait_reason, None);
    assert_eq!(after_stop.last_event_name.as_deref(), Some("Stop"));

    // The subagent ends; the count returns to zero and a real final Stop now lands.
    observe(&mut db, "SubagentStop", None, None);
    assert_eq!(count(&db), 0);
    observe(&mut db, "Stop", Some(TaskRunStatus::WaitingForUser), None);
    let final_stop = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(final_stop.status, TaskRunStatus::WaitingForUser);
    assert_eq!(final_stop.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

/// MON-73 regression: a `<task-notification>` `UserPromptSubmit` (Claude re-injecting a finished
/// background subagent's result) used to reset `active_subagents` to 0 mid-turn, letting the
/// trailing `Stop` drop the run to "your turn" while siblings still ran. The fix keeps the count
/// across that re-injection *and* reads the `Stop`'s own `background_tasks` as a backstop, so even
/// a count of 0 cannot demote a run the parent still reports as having a subagent in flight.
#[test]
fn task_run_observation_holds_stop_when_background_tasks_running() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("bg tasks")).unwrap();
    let run = db
        .start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap();

    let observe = |db: &mut SqliteStore, event: &str, status: Option<TaskRunStatus>, metadata: Option<serde_json::Value>| {
        record_observation(db, &run.id, event, status, metadata.as_ref());
    };
    let count = |db: &SqliteStore| db.get_task_run(&run.id).unwrap().unwrap().active_subagents;

    observe(&mut db, "UserPromptSubmit", Some(TaskRunStatus::Running), None);

    // The `<task-notification>` re-injection arrives mid-turn and must NOT zero the count, even
    // though it is a UserPromptSubmit.
    observe(
        &mut db,
        "UserPromptSubmit",
        Some(TaskRunStatus::Running),
        Some(serde_json::json!({"prompt": "<task-notification>\n<task-id>abc</task-id>"})),
    );
    assert_eq!(count(&db), 0);

    // A Stop whose payload still lists a running subagent is held even though the count is 0.
    observe(
        &mut db,
        "Stop",
        Some(TaskRunStatus::WaitingForUser),
        Some(serde_json::json!({"background_tasks": [{"id": "a", "status": "running"}]})),
    );
    let after_held = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(after_held.status, TaskRunStatus::Running);
    assert_eq!(after_held.wait_reason, None);

    // The control: a normal turn end (no running background tasks, count 0) still demotes — the
    // guard does not pin the run open forever.
    observe(
        &mut db,
        "Stop",
        Some(TaskRunStatus::WaitingForUser),
        Some(serde_json::json!({"background_tasks": []})),
    );
    let after_final = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(after_final.status, TaskRunStatus::WaitingForUser);
    assert_eq!(after_final.wait_reason, Some(TaskRunWaitReason::AwaitingPrompt));
}

/// The counter resets only on true turn boundaries. A `UserPromptSubmit` (and a fresh
/// `SessionStart`) zeroes a stale count so a subagent that died without `SubagentStop` cannot
/// strand it; a mid-turn continuation `SessionStart` (`compact`) must NOT, or the trailing Stop
/// would flicker again.
#[test]
fn task_run_observation_subagent_count_reset_rules() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let task = db.insert_task(dev_task("reset")).unwrap();
    let start = |db: &mut SqliteStore| {
        db.start_task_run(NewTaskRun {
            task_id: task.id.clone(),
            agent: None,
            branch: None,
            worktree_path: None,
        })
        .unwrap()
    };
    let bump = |db: &mut SqliteStore, id: &str| {
        db.record_task_run_observation(
            id,
            TaskRunObservation {
                status: None,
                wait_reason: None,
                event_name: Some("SubagentStart"),
                at: "2026-06-02T00:00:00.000Z",
                provider_session_id: Some("sess-1"),
                terminal_tab_id: None,
                metadata: None,
            },
        )
        .unwrap();
    };
    let reset_event = |db: &mut SqliteStore, id: &str, event: &str, source: Option<&str>| {
        let metadata = source.map(|s| serde_json::json!({ "source": s }));
        db.record_task_run_observation(
            id,
            TaskRunObservation {
                status: None,
                wait_reason: None,
                event_name: Some(event),
                at: "2026-06-02T00:00:00.000Z",
                provider_session_id: Some("sess-1"),
                terminal_tab_id: None,
                metadata: metadata.as_ref(),
            },
        )
        .unwrap();
        db.get_task_run(id).unwrap().unwrap().active_subagents
    };

    // UserPromptSubmit resets.
    let a = start(&mut db);
    bump(&mut db, &a.id);
    assert_eq!(reset_event(&mut db, &a.id, "UserPromptSubmit", None), 0);

    // A fresh SessionStart resets.
    let b = start(&mut db);
    bump(&mut db, &b.id);
    assert_eq!(reset_event(&mut db, &b.id, "SessionStart", Some("startup")), 0);

    // A mid-turn compact SessionStart does not — the subagent is still in flight.
    let c = start(&mut db);
    bump(&mut db, &c.id);
    assert_eq!(reset_event(&mut db, &c.id, "SessionStart", Some("compact")), 1);
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

    let summaries = db.list_task_summaries(TaskSummaryFilter::All, None).unwrap();
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

    let summaries = db.list_task_summaries(TaskSummaryFilter::All, None).unwrap();
    let summary = summaries.iter().find(|s| s.id == task.id).unwrap();
    // The task's only run is its de-facto main run, not a side run.
    assert_eq!(summary.task_run_status, Some(TaskRunStatus::Running));
    assert_eq!(summary.side_runs_running, 0);
}

#[test]
fn task_summary_filter_scopes_the_closed_archive() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let active = db.insert_task(dev_task("still working")).unwrap();
    let archived = db.insert_task(dev_task("wrapped up")).unwrap();
    db.mark_task(&archived.id, TaskStatus::Closed, None).unwrap();

    let ids = |rows: Vec<TaskSummaryRow>| -> Vec<String> { rows.into_iter().map(|r| r.id).collect() };

    let active_only = ids(db.list_task_summaries(TaskSummaryFilter::Active, None).unwrap());
    assert!(active_only.contains(&active.id));
    assert!(
        !active_only.contains(&archived.id),
        "Active must hide the Closed archive"
    );

    let closed_only = ids(db
        .list_task_summaries(TaskSummaryFilter::Status(DisplayStatus::Closed), None)
        .unwrap());
    assert!(closed_only.contains(&archived.id));
    assert!(!closed_only.contains(&active.id));

    let everything = ids(db.list_task_summaries(TaskSummaryFilter::All, None).unwrap());
    assert!(everything.contains(&active.id));
    assert!(everything.contains(&archived.id));
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
    db.record_pull_request_branch_sync_success(
        &PullRequestBranchSyncCandidate {
            task_id: merged_item.id.clone(),
            repo: "owner/repo".to_string(),
            branch: "issue-43".to_string(),
        },
        &[GithubPullRequest {
            repo: "owner/repo".to_string(),
            number: 8,
            url: "https://github.com/owner/repo/pull/8".to_string(),
            status: GithubPullRequestStatus::Merged,
        }],
    )
    .unwrap();
    let summaries = db.list_task_summaries(TaskSummaryFilter::All, Some("owner/repo"))
            .unwrap();
    let merged_row = summaries.iter().find(|s| s.id == merged_item.id).unwrap();
    assert!(!merged_row.has_open_pull_request);

    // Draft counts as open work in flight.
    let mut draft_task = dev_task("with draft pr");
    draft_task.project_id = Some(project.id.clone());
    let draft_item = db.insert_task(draft_task).unwrap();
    db.record_pull_request_branch_sync_success(
        &PullRequestBranchSyncCandidate {
            task_id: draft_item.id.clone(),
            repo: "owner/repo".to_string(),
            branch: "issue-44".to_string(),
        },
        &[GithubPullRequest {
            repo: "owner/repo".to_string(),
            number: 9,
            url: "https://github.com/owner/repo/pull/9".to_string(),
            status: GithubPullRequestStatus::Draft,
        }],
    )
    .unwrap();
    let summaries = db.list_task_summaries(TaskSummaryFilter::All, Some("owner/repo"))
            .unwrap();
    let draft_row = summaries.iter().find(|s| s.id == draft_item.id).unwrap();
    assert!(draft_row.has_open_pull_request);
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

// Closing a task is "done-like": it stays a PR sync candidate just as the old `done` status did,
// since dropping the `deleted_at IS NULL` guard removes the only thing that hid it.
#[test]
fn branch_pull_request_candidate_includes_closed_tasks() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let mut project = Project::from_repo("owner/repo");
    project.default_branch = "main".to_string();
    db.upsert_project(&project).unwrap();
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

    let candidate = db
        .next_pull_request_branch_sync_candidate()
        .unwrap()
        .unwrap();
    assert_eq!(candidate.task_id, item.id);
    assert_eq!(candidate.branch, "feature/keep-syncing");
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
        db.mark_task_closed("MON-missing").is_err(),
        "closing a missing task must error"
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
fn force_clear_pr_sync_state_resets_open_pr_states_but_preserves_branch_syncs() {
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

    // Branch sync: next_retry_at must be preserved. cmd+r refreshes PR statuses, not branch
    // discovery; resetting branches here would starve the forced batch's status sync.
    let branch_retry: Option<String> = db
        .conn()
        .query_row(
            "SELECT next_retry_at FROM github_pull_request_branch_syncs WHERE task_id = ?1",
            params![&open_candidate.task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        branch_retry.is_some(),
        "branch next_retry_at should be preserved, not cleared"
    );

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

    // A mismatched task id never settles someone else's run.
    let run = start_run(&mut db);
    observe(&mut db, &run.id, TaskRunStatus::Running);
    assert!(!db.settle_task_run_if_live(&run.id, "MON-404").unwrap());
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
            event_name: None,
            at: "2026-06-02T00:00:00.000Z",
            provider_session_id: Some("sess-1"),
            terminal_tab_id: None,
            metadata: None,
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
                   run_id: &str,
                   status: Option<TaskRunStatus>,
                   session: Option<&str>,
                   tab: Option<&str>| {
        db.record_task_run_observation(
            run_id,
            TaskRunObservation {
                status,
                wait_reason: None,
                event_name: None,
                at: "2026-06-02T00:00:00.000Z",
                provider_session_id: session,
                terminal_tab_id: tab,
                metadata: None,
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
        .map(|run| run.id)
        .collect();
    driven.sort();
    let mut expected = vec![running.id, waiting.id, claimed_setting_up.id];
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

#[test]
fn artifact_draft_crud_and_promote() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let draft = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Essay { title: Some("Test Essay".into()) },
            body: "Hello world".into(),
            occurred_at: None,
        })
        .unwrap();
    assert!(draft.id.starts_with("ART-"));
    assert_eq!(draft.kind.kind_str(), "essay");
    assert_eq!(draft.body, "Hello world");
    assert_eq!(draft.revision, 0);

    let updated = db
        .update_draft(
            &draft.id,
            &ArtifactDraftKind::Essay { title: Some("Updated".into()) },
            "New body",
            None,
            0,
        )
        .unwrap();
    assert_eq!(updated.revision, 1);

    let stale = db.update_draft(
        &draft.id,
        &ArtifactDraftKind::Essay { title: Some("Stale".into()) },
        "Stale body",
        None,
        0,
    );
    assert!(stale.is_err(), "stale write should fail");

    let artifact = db
        .promote_draft(
            &draft.id,
            monica_core::NewArtifact {
                kind: monica_core::ArtifactKind::Essay { title: "Final Title".into() },
                body: "New body".into(),
                occurred_at: None,
            },
        )
        .unwrap();
    assert_eq!(artifact.id, draft.id);

    assert!(db.get_draft(&draft.id).unwrap().is_none());
    assert!(db.get_artifact(&draft.id).unwrap().is_some());

    let essays = db.list_essays().unwrap();
    assert_eq!(essays.len(), 1);
    assert_eq!(essays[0].title, "Final Title");
}

#[test]
fn artifact_convert_kind() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let draft = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Memo,
            body: "A memo".into(),
            occurred_at: None,
        })
        .unwrap();

    let artifact = db
        .promote_draft(
            &draft.id,
            monica_core::NewArtifact {
                kind: monica_core::ArtifactKind::Memo,
                body: "A memo".into(),
                occurred_at: None,
            },
        )
        .unwrap();

    let converted = db
        .convert_artifact_kind(
            &artifact.id,
            &monica_core::ArtifactKind::Essay { title: "Now an essay".into() },
            artifact.revision,
        )
        .unwrap();
    assert_eq!(converted.kind.kind_str(), "essay");
    assert_eq!(converted.kind.title(), Some("Now an essay"));
    assert_eq!(converted.revision, artifact.revision + 1);
}

#[test]
fn artifact_timeline_items() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let _task = db.insert_task(dev_task("A task")).unwrap();

    let draft = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Memo,
            body: "Timeline memo".into(),
            occurred_at: None,
        })
        .unwrap();
    db.promote_draft(
        &draft.id,
        monica_core::NewArtifact {
            kind: monica_core::ArtifactKind::Memo,
            body: "Timeline memo".into(),
            occurred_at: None,
        },
    )
    .unwrap();

    let items = db.list_timeline_items(None, None, 30).unwrap();
    assert!(items.len() >= 2);

    let artifact_items: Vec<_> = items
        .iter()
        .filter(|i| matches!(i, monica_core::TimelineItem::Artifact { .. }))
        .collect();
    assert_eq!(artifact_items.len(), 1);

    let task_items: Vec<_> = items
        .iter()
        .filter(|i| matches!(i, monica_core::TimelineItem::TaskCreated { .. }))
        .collect();
    assert_eq!(task_items.len(), 1);
}

#[test]
fn artifact_attachment_round_trip() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let draft = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Memo,
            body: "With image".into(),
            occurred_at: None,
        })
        .unwrap();

    let att = db
        .insert_attachment(&draft.id, "photo.jpg", Some("image/jpeg"), 12345, "ART-1/ATT-1.jpg")
        .unwrap();
    assert!(att.id.starts_with("ATT-"));
    assert_eq!(att.entry_id, draft.id);
    assert_eq!(att.byte_size, 12345);

    let list = db.list_attachments(&draft.id).unwrap();
    assert_eq!(list.len(), 1);

    let path = db.delete_attachment(&att.id).unwrap();
    assert_eq!(path, Some("ART-1/ATT-1.jpg".to_string()));

    let list = db.list_attachments(&draft.id).unwrap();
    assert!(list.is_empty());

    let missing = db.delete_attachment("ATT-999").unwrap();
    assert_eq!(missing, None, "deleting a non-existent attachment should return None");
}

#[test]
fn save_draft_validates_kind_and_body() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let memo = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Memo,
            body: String::new(),
            occurred_at: None,
        })
        .unwrap();
    let err = monica_core::artifact_ops::save_draft(&mut db, &memo.id);
    assert!(err.is_err(), "empty memo body must be rejected");

    let essay = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Essay { title: None },
            body: "has body".into(),
            occurred_at: None,
        })
        .unwrap();
    let err = monica_core::artifact_ops::save_draft(&mut db, &essay.id);
    assert!(err.is_err(), "essay without title must be rejected");

    let intent = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Intent {
                title: Some("   ".into()),
                project_id: None,
            },
            body: "has body".into(),
            occurred_at: None,
        })
        .unwrap();
    let err = monica_core::artifact_ops::save_draft(&mut db, &intent.id);
    assert!(err.is_err(), "intent with whitespace-only title must be rejected");

    let not_found = monica_core::artifact_ops::save_draft(&mut db, "ART-999");
    assert!(not_found.is_err(), "non-existent draft must be rejected");

    let valid_memo = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Memo,
            body: "a real memo".into(),
            occurred_at: None,
        })
        .unwrap();
    let artifact = monica_core::artifact_ops::save_draft(&mut db, &valid_memo.id).unwrap();
    assert_eq!(artifact.id, valid_memo.id);
}

#[test]
fn list_intents_groups_by_project() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let project = monica_core::Project::from_repo("owner/repo-a");
    db.upsert_project(&project).unwrap();

    for (title, project_id) in [
        ("Intent A1", Some(project.id.as_str())),
        ("Intent A2", Some(project.id.as_str())),
        ("Intent U1", None),
        ("Intent U2", None),
    ] {
        let d = db
            .insert_draft(NewDraft {
                kind: ArtifactDraftKind::Intent {
                    title: Some(title.into()),
                    project_id: project_id.map(String::from),
                },
                body: "body".into(),
                occurred_at: None,
            })
            .unwrap();
        db.promote_draft(
            &d.id,
            monica_core::NewArtifact {
                kind: monica_core::ArtifactKind::Intent {
                    title: title.into(),
                    project_id: project_id.map(String::from),
                },
                body: "body".into(),
                occurred_at: None,
            },
        )
        .unwrap();
    }

    let groups = db.list_intents_by_project().unwrap();
    assert_eq!(groups.len(), 2, "should have 2 groups (project + unassigned)");
    assert_eq!(groups[0].project_id, Some(project.id.clone()));
    assert_eq!(groups[0].items.len(), 2);
    assert_eq!(groups[1].project_id, None);
    assert_eq!(groups[1].items.len(), 2);
}

#[test]
fn update_artifact_revision_guard() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let d = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Memo,
            body: "original".into(),
            occurred_at: None,
        })
        .unwrap();
    let artifact = db
        .promote_draft(
            &d.id,
            monica_core::NewArtifact {
                kind: monica_core::ArtifactKind::Memo,
                body: "original".into(),
                occurred_at: None,
            },
        )
        .unwrap();

    let updated = db
        .update_artifact(
            &artifact.id,
            &monica_core::ArtifactKind::Memo,
            "updated body",
            None,
            artifact.revision,
        )
        .unwrap();
    assert_eq!(updated.revision, artifact.revision + 1);
    assert_eq!(updated.body, "updated body");

    let stale = db.update_artifact(
        &artifact.id,
        &monica_core::ArtifactKind::Memo,
        "stale body",
        None,
        artifact.revision,
    );
    assert!(stale.is_err(), "stale revision must fail");
}

#[test]
fn timeline_pagination_cursor_and_since() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    for i in 0..5 {
        let d = db
            .insert_draft(NewDraft {
                kind: ArtifactDraftKind::Memo,
                body: format!("memo {i}"),
                occurred_at: None,
            })
            .unwrap();
        db.promote_draft(
            &d.id,
            monica_core::NewArtifact {
                kind: monica_core::ArtifactKind::Memo,
                body: format!("memo {i}"),
                occurred_at: None,
            },
        )
        .unwrap();
    }

    let page1 = db.list_timeline_items(None, None, 3).unwrap();
    assert_eq!(page1.len(), 3);

    let cursor = monica_core::TimelineCursor {
        timeline_at: page1[2].timeline_at().to_string(),
        item_key: page1[2].item_key().to_string(),
    };
    let page2 = db.list_timeline_items(Some(&cursor), None, 3).unwrap();
    assert_eq!(page2.len(), 2);

    let all_keys: Vec<String> = page1
        .iter()
        .chain(page2.iter())
        .map(|i| i.item_key().to_string())
        .collect();
    let unique: std::collections::HashSet<&String> = all_keys.iter().collect();
    assert_eq!(all_keys.len(), unique.len(), "no duplicates across pages");

    let since_items = db
        .list_timeline_items(None, Some("2099-01-01T00:00:00.000Z"), 30)
        .unwrap();
    assert!(since_items.is_empty(), "future since should return nothing");
}

#[test]
fn insert_saved_memo_creates_saved_artifact() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let artifact = db.insert_saved_memo("Quick memo").unwrap();
    assert!(artifact.id.starts_with("ART-"));
    assert_eq!(artifact.kind, monica_core::ArtifactKind::Memo);
    assert_eq!(artifact.body, "Quick memo");

    let fetched = db.get_artifact(&artifact.id).unwrap().unwrap();
    assert_eq!(fetched.id, artifact.id);
    assert_eq!(fetched.body, "Quick memo");
}

#[test]
fn quick_save_memo_rejects_empty_body() {
    let mut db = SqliteStore::open_in_memory().unwrap();
    let result = monica_core::artifact_ops::quick_save_memo(&mut db, "   ");
    assert!(result.is_err());
}

#[test]
fn timeline_memo_returns_full_body() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let long_body = "a".repeat(500);
    db.insert_saved_memo(&long_body).unwrap();

    let d = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Essay {
                title: Some("Essay title".into()),
            },
            body: "b".repeat(500),
            occurred_at: None,
        })
        .unwrap();
    db.promote_draft(
        &d.id,
        monica_core::NewArtifact {
            kind: monica_core::ArtifactKind::Essay {
                title: "Essay title".into(),
            },
            body: "b".repeat(500),
            occurred_at: None,
        },
    )
    .unwrap();

    let items = db.list_timeline_items(None, None, 30).unwrap();
    for item in &items {
        if let monica_core::TimelineItem::Artifact {
            artifact_kind,
            body_preview,
            ..
        } = item
        {
            match artifact_kind.as_str() {
                "memo" => assert_eq!(body_preview.len(), 500, "memo should return full body"),
                "essay" => assert_eq!(body_preview.len(), 200, "essay should truncate to 200"),
                _ => {}
            }
        }
    }
}

#[test]
fn timeline_artifact_includes_project_name_and_thumbnails() {
    let mut db = SqliteStore::open_in_memory().unwrap();

    let proj = monica_core::Project::from_repo("owner/My Project");
    let project = db.upsert_project(&proj).unwrap();

    let d = db
        .insert_draft(NewDraft {
            kind: ArtifactDraftKind::Intent {
                title: Some("Plan".into()),
                project_id: Some(project.id.clone()),
            },
            body: "intent body".into(),
            occurred_at: None,
        })
        .unwrap();
    db.promote_draft(
        &d.id,
        monica_core::NewArtifact {
            kind: monica_core::ArtifactKind::Intent {
                title: "Plan".into(),
                project_id: Some(project.id.clone()),
            },
            body: "intent body".into(),
            occurred_at: None,
        },
    )
    .unwrap();

    let memo = db.insert_saved_memo("memo with image").unwrap();
    db.insert_attachment(&memo.id, "photo.jpg", Some("image/jpeg"), 1000, "ART-2/ATT-1.jpg")
        .unwrap();

    let items = db.list_timeline_items(None, None, 30).unwrap();
    for item in &items {
        if let monica_core::TimelineItem::Artifact {
            artifact_kind,
            project_name,
            thumbnail_paths,
            ..
        } = item
        {
            match artifact_kind.as_str() {
                "intent" => {
                    assert_eq!(project_name.as_deref(), Some("My Project"));
                }
                "memo" => {
                    assert_eq!(thumbnail_paths, &["ART-2/ATT-1.jpg"]);
                }
                _ => {}
            }
        }
    }
}
