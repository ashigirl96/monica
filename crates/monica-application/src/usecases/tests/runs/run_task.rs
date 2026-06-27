use super::*;


#[test]
fn start_run_names_branch_from_mon_id_and_creates_bench() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let prep = start_run(&mut repos, &task_id).unwrap();

    assert_eq!(prep.branch, "mon-1");
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(task.primary_task_run_id.as_deref(), Some(prep.task_run_id.as_str()));
    let (_, cwd) = repos.get_bench_for_task(&task_id).unwrap().unwrap();
    assert_eq!(cwd, "/repo");
}

#[test]
fn start_run_prefers_linked_issue_number_for_branch() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = insert_issue_backed_task(&mut repos, 9);

    let prep = start_run(&mut repos, &task_id).unwrap();
    assert_eq!(prep.branch, "issue-9");
}

#[test]
fn start_run_rejects_active_primary_run() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    start_run(&mut repos, &task_id).unwrap();

    let err = start_run(&mut repos, &task_id).unwrap_err();
    assert!(matches!(err, ApplicationError::Conflict(_)), "{err:?}");
    assert!(err.to_string().contains("already has an active run"), "{err}");
}

#[test]
fn start_run_rejects_closed_task() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    repos.update_task_status(&task_id, TaskStatus::Closed).unwrap();

    let err = start_run(&mut repos, &task_id).unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
    assert!(err.to_string().contains("is closed"), "{err}");
}

#[test]
fn start_run_missing_task_is_not_found() {
    let mut repos = FakeRepos::default();
    let err = start_run(&mut repos, "MON-404").unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)), "{err:?}");
}

#[test]
fn execute_run_records_failed_on_setup_failure() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let prep = start_run(&mut repos, &task_id).unwrap();
    let setup = FakeSetupRunner::with_outcome(SetupOutcome::Failed {
        code: Some(1),
        timed_out: false,
    });

    let status = execute_run(
        &mut repos,
        &FakeGit::default(),
        &setup,
        &FakeTaskRunOutputs::default(),
        &task_id,
        &prep.task_run_id,
    )
    .unwrap();

    assert_eq!(status, TaskRunStatus::Failed);
    let run = repos.get_task_run(&prep.task_run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Failed);
    assert_eq!(
        run.worktree_path.as_deref(),
        Some("/repo/.worktrees/mon-1"),
        "worktree path is recorded even when setup fails"
    );
}

#[test]
fn execute_run_prepares_run_and_pins_bench_to_worktree() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let prep = start_run(&mut repos, &task_id).unwrap();

    let status = execute_run(
        &mut repos,
        &FakeGit::default(),
        &FakeSetupRunner::default(),
        &FakeTaskRunOutputs::default(),
        &task_id,
        &prep.task_run_id,
    )
    .unwrap();

    assert_eq!(status, TaskRunStatus::Prepared);
    let run = repos.get_task_run(&prep.task_run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Prepared);
    let (_, cwd) = repos.get_bench_for_task(&task_id).unwrap().unwrap();
    assert_eq!(cwd, "/repo/.worktrees/mon-1");
}

/// A git worktree-creation failure is an external-process fault, not a storage fault: it must
/// surface as `External` (distinct `ApiErrorCode` for the front end), and the run still settles to
/// `Failed`.
#[test]
fn execute_run_classifies_worktree_failure_as_external() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let prep = start_run(&mut repos, &task_id).unwrap();
    let git = FakeGit::with_create_worktree_error("fatal: worktree add failed");

    let err = execute_run(
        &mut repos,
        &git,
        &FakeSetupRunner::default(),
        &FakeTaskRunOutputs::default(),
        &task_id,
        &prep.task_run_id,
    )
    .unwrap_err();

    assert!(matches!(err, ApplicationError::External(_)), "{err:?}");
    assert_eq!(
        repos.get_task_run(&prep.task_run_id).unwrap().unwrap().status,
        TaskRunStatus::Failed
    );
}

/// A failure to *run* the setup script (spawn/timeout infra fault, distinct from the script exiting
/// non-zero) is also external, not storage.
#[test]
fn execute_run_classifies_setup_script_run_failure_as_external() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let prep = start_run(&mut repos, &task_id).unwrap();
    let setup = FakeSetupRunner::with_error("setup runner failed to spawn");

    let err = execute_run(
        &mut repos,
        &FakeGit::default(),
        &setup,
        &FakeTaskRunOutputs::default(),
        &task_id,
        &prep.task_run_id,
    )
    .unwrap_err();

    assert!(matches!(err, ApplicationError::External(_)), "{err:?}");
    assert_eq!(
        repos.get_task_run(&prep.task_run_id).unwrap().unwrap().status,
        TaskRunStatus::Failed
    );
}

#[test]
fn prepare_claude_for_run_rejects_non_prepared_primary() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    start_run(&mut repos, &task_id).unwrap();

    let err = prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap_err();
    assert!(err.to_string().contains("expected prepared"), "{err}");
}

#[test]
fn prepare_claude_for_run_rejects_missing_worktree() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let prep = start_run(&mut repos, &task_id).unwrap();
    repos
        .finish_task_run(&prep.task_run_id, &task_id, TaskRunStatus::Prepared)
        .unwrap();

    let err = prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap_err();
    assert!(err.to_string().contains("no worktree path"), "{err}");

    repos
        .set_task_run_worktree_path(&prep.task_run_id, "/nonexistent/worktree")
        .unwrap();
    let err = prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap_err();
    assert!(err.to_string().contains("worktree does not exist"), "{err}");
}

fn prepared_run_with_worktree(repos: &mut FakeRepos, task_id: &str, prompt_body: &str) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    let prep = start_run(repos, task_id).unwrap();
    repos
        .finish_task_run(&prep.task_run_id, task_id, TaskRunStatus::Prepared)
        .unwrap();

    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let worktree =
        std::env::temp_dir().join(format!("monica-prep-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(worktree.join(".monica")).unwrap();
    std::fs::write(worktree.join(".monica/prompt.md"), prompt_body).unwrap();
    repos
        .set_task_run_worktree_path(&prep.task_run_id, &worktree.to_string_lossy())
        .unwrap();
    worktree
}

#[test]
fn prepare_claude_for_run_seeds_prompt_for_issue_backed_task() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = insert_issue_backed_task(&mut repos, 7);

    let worktree = prepared_run_with_worktree(&mut repos, &task_id, "do the thing");
    let result =
        prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap();
    std::fs::remove_dir_all(&worktree).ok();

    assert_eq!(result.initial_command, "claude 'do the thing'");
}

#[test]
fn prepare_claude_for_run_ignores_prompt_for_raw_task() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = create_raw_task(&mut repos, "explore idea", "owner/repo")
        .unwrap()
        .id;

    let worktree = prepared_run_with_worktree(&mut repos, &task_id, "leftover prompt");
    let result =
        prepare_claude_for_run(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None).unwrap();
    std::fs::remove_dir_all(&worktree).ok();

    assert_eq!(result.initial_command, "claude");
}
