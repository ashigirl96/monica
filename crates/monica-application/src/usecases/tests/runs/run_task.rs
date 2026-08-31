use super::*;
use monica_domain::{AgentSessionId, RunMode, TaskId, TaskRunId};


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
    let err = start_run(&mut repos, &TaskId::from_store("MON-404".to_string())).unwrap_err();
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

    let err = run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::Worktree).unwrap_err();
    assert!(err.to_string().contains("expected prepared"), "{err}");
}

/// A run that never had a worktree — in-place, or attached — launches in the project checkout
/// rather than erroring. This is what lets an attach run stand as primary without breaking Run.
#[test]
fn prepare_claude_for_run_falls_back_to_project_path_without_worktree() {
    let mut repos = FakeRepos::default();
    let (task_id, checkout) = checkout_backed_task(&mut repos);
    let prep = start_run(&mut repos, &task_id).unwrap();
    repos
        .finish_task_run(&prep.task_run_id, &task_id, TaskRunStatus::Prepared)
        .unwrap();

    let result =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::Worktree)
            .unwrap();
    assert_eq!(result.cwd, checkout.to_string_lossy());
}

/// A worktree that is merely *missing* must stay an error: falling back would run an isolated
/// branch's agent against the primary checkout, and `claude --resume` resolves its session by cwd
/// so it would not find the session there either.
#[test]
fn prepare_claude_for_run_rejects_missing_worktree() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let prep = start_run(&mut repos, &task_id).unwrap();
    repos
        .finish_task_run(&prep.task_run_id, &task_id, TaskRunStatus::Prepared)
        .unwrap();
    repos
        .set_task_run_worktree_path(&prep.task_run_id, "/nonexistent/worktree")
        .unwrap();

    let err =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::Worktree)
            .unwrap_err();
    assert!(err.to_string().contains("worktree does not exist"), "{err}");
}

fn prepared_run_with_worktree(
    repos: &mut FakeRepos,
    task_id: &TaskId,
    prompt_body: &str,
) -> (TaskRunId, PathBuf) {
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
    (prep.task_run_id, worktree)
}

#[test]
fn prepare_claude_for_run_seeds_prompt_for_issue_backed_task() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = insert_issue_backed_task(&mut repos, 7);

    let (_, worktree) = prepared_run_with_worktree(&mut repos, &task_id, "do the thing");
    let result =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::Worktree).unwrap();
    std::fs::remove_dir_all(&worktree).ok();

    assert_eq!(result.initial_command, "claude 'do the thing'");
}

#[test]
fn prepare_claude_for_run_resumes_stopped_primary_with_session() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = insert_issue_backed_task(&mut repos, 7);

    let (run_id, worktree) = prepared_run_with_worktree(&mut repos, &task_id, "stale prompt");
    assert!(repos.claim_prepared_run(&run_id, &AgentSessionId::from_agent("sess-42")).unwrap());
    repos
        .finish_task_run(&run_id, &task_id, TaskRunStatus::Stopped)
        .unwrap();

    let result =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::Worktree).unwrap();
    std::fs::remove_dir_all(&worktree).ok();

    assert_eq!(result.task_run_id, run_id, "the stopped run is reused, not replaced");
    assert_eq!(
        result.initial_command, "claude --resume 'sess-42'",
        "resume reopens the recorded session and ignores the prompt file"
    );
}

/// A fresh launch stamps the effective agent on the run. Without it the run would keep
/// `agent = NULL` and a later resume would fall back to the profile default instead of the agent
/// that actually opened the session.
#[test]
fn launch_agent_is_stamped_on_the_run_and_drives_the_resume() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let (run_id, worktree) = prepared_run_with_worktree(&mut repos, &task_id, "");
    let fresh = run_task(
        &mut repos,
        &FakeTaskRunOutputs::default(),
        &task_id,
        Some(Agent::Claude),
        RunMode::Worktree,
    )
    .unwrap();
    assert_eq!(fresh.initial_command, "claude");
    assert_eq!(
        repos.get_task_run(&run_id).unwrap().unwrap().agent,
        Some(Agent::Claude),
        "the effective agent is persisted on the run at launch"
    );

    assert!(repos.claim_prepared_run(&run_id, &AgentSessionId::from_agent("sess-9")).unwrap());
    repos
        .finish_task_run(&run_id, &task_id, TaskRunStatus::Stopped)
        .unwrap();

    let resumed =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::Worktree).unwrap();
    std::fs::remove_dir_all(&worktree).ok();

    assert_eq!(
        resumed.initial_command, "claude --resume 'sess-9'",
        "resume reopens the session recorded on the run"
    );
}

#[test]
fn prepare_claude_for_run_rejects_stopped_primary_without_session() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let (run_id, worktree) = prepared_run_with_worktree(&mut repos, &task_id, "");
    repos
        .finish_task_run(&run_id, &task_id, TaskRunStatus::Stopped)
        .unwrap();

    let err =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::Worktree).unwrap_err();
    std::fs::remove_dir_all(&worktree).ok();

    assert!(matches!(err, ApplicationError::Conflict(_)), "{err:?}");
    assert!(err.to_string().contains("no session to resume"), "{err}");
}

#[test]
fn prepare_claude_for_run_ignores_prompt_for_raw_task() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = create_raw_task(&mut repos, "explore idea", "owner/repo")
        .unwrap()
        .id;

    let (_, worktree) = prepared_run_with_worktree(&mut repos, &task_id, "leftover prompt");
    let result =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::Worktree).unwrap();
    std::fs::remove_dir_all(&worktree).ok();

    assert_eq!(result.initial_command, "claude");
}

fn in_place_run(repos: &mut FakeRepos, task_id: &TaskId) -> crate::RunTaskResult {
    run_task(repos, &FakeTaskRunOutputs::default(), task_id, None, RunMode::InPlace).unwrap()
}

/// An in-place run stats the project checkout before launching, so these tests need one that
/// actually exists rather than the `/repo` placeholder.
fn checkout_backed_task(repos: &mut FakeRepos) -> (TaskId, PathBuf) {
    let checkout = temp_dir_named("monica-checkout");
    insert_runnable_project_at(repos, &checkout.to_string_lossy());
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    (task_id, checkout)
}

#[test]
fn run_task_in_place_creates_prepared_run_without_branch_or_worktree() {
    let mut repos = FakeRepos::default();
    let (task_id, _checkout) = checkout_backed_task(&mut repos);

    let result = in_place_run(&mut repos, &task_id);

    let run = repos.get_task_run(&result.task_run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Prepared);
    assert_eq!(run.branch, None, "a branch here would be deleted by close_task's cleanup");
    assert_eq!(run.worktree_path, None);
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(task.primary_task_run_id.as_deref(), Some(result.task_run_id.as_str()));
}

#[test]
fn run_task_in_place_launches_claude_at_project_path() {
    let mut repos = FakeRepos::default();
    let (task_id, checkout) = checkout_backed_task(&mut repos);

    let result = in_place_run(&mut repos, &task_id);

    let expected = checkout.to_string_lossy();
    assert_eq!(result.cwd, expected);
    assert_eq!(result.initial_command, "claude");
    let (_, cwd) = repos.get_bench_for_task(&task_id).unwrap().unwrap();
    assert_eq!(cwd, expected, "the bench is pinned to the run's cwd");
}

/// The mode only decides how a *new* run is born. A stopped in-place primary that recorded a
/// session is reopened where it was, not replaced by a second in-place run.
#[test]
fn run_task_in_place_resumes_stopped_in_place_primary() {
    let mut repos = FakeRepos::default();
    let (task_id, checkout) = checkout_backed_task(&mut repos);

    let first = in_place_run(&mut repos, &task_id);
    assert!(repos
        .claim_prepared_run(&first.task_run_id, &AgentSessionId::from_agent("sess-7"))
        .unwrap());
    repos
        .finish_task_run(&first.task_run_id, &task_id, TaskRunStatus::Stopped)
        .unwrap();

    let resumed = in_place_run(&mut repos, &task_id);

    assert_eq!(resumed.task_run_id, first.task_run_id, "the stopped run is reused");
    assert_eq!(resumed.initial_command, "claude --resume 'sess-7'");
    assert_eq!(resumed.cwd, checkout.to_string_lossy());
}

#[test]
fn run_task_in_place_reuses_existing_prepared_primary() {
    let mut repos = FakeRepos::default();
    let (task_id, _checkout) = checkout_backed_task(&mut repos);

    let first = in_place_run(&mut repos, &task_id);
    let second = in_place_run(&mut repos, &task_id);

    assert_eq!(second.task_run_id, first.task_run_id);
    assert_eq!(repos.list_task_runs_for_task(&task_id).unwrap().len(), 1);
}

#[test]
fn run_task_in_place_rejects_active_primary() {
    let mut repos = FakeRepos::default();
    let (task_id, _checkout) = checkout_backed_task(&mut repos);
    start_run(&mut repos, &task_id).unwrap();

    let err =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::InPlace)
            .unwrap_err();
    assert!(matches!(err, ApplicationError::Conflict(_)), "{err:?}");
    assert!(err.to_string().contains("already has an active run"), "{err}");
}

#[test]
fn run_task_in_place_rejects_closed_task() {
    let mut repos = FakeRepos::default();
    let (task_id, _checkout) = checkout_backed_task(&mut repos);
    repos.update_task_status(&task_id, TaskStatus::Closed).unwrap();

    let err =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::InPlace)
            .unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
    assert!(err.to_string().contains("is closed"), "{err}");
}

/// The launch cwd comes from the run's own worktree, never from a sibling's: a task that already
/// carries a worktree run must still open an in-place run in the project checkout.
#[test]
fn run_task_in_place_ignores_sibling_worktree() {
    let mut repos = FakeRepos::default();
    let (task_id, checkout) = checkout_backed_task(&mut repos);

    let (worktree_run, worktree) = prepared_run_with_worktree(&mut repos, &task_id, "");
    repos
        .finish_task_run(&worktree_run, &task_id, TaskRunStatus::Stopped)
        .unwrap();

    let result = in_place_run(&mut repos, &task_id);
    std::fs::remove_dir_all(&worktree).ok();

    let expected = checkout.to_string_lossy();
    assert_ne!(result.task_run_id, worktree_run);
    assert_eq!(result.cwd, expected);
    let (_, cwd) = repos.get_bench_for_task(&task_id).unwrap().unwrap();
    assert_eq!(cwd, expected, "the bench follows the in-place run, not the sibling worktree");
}

/// `default_bench_cwd` would answer `$HOME` (then `/tmp`) here — fine for a browsing shell, but a
/// Run must never launch its agent outside the project.
#[test]
fn run_task_in_place_rejects_project_without_checkout_path() {
    let mut repos = FakeRepos::default();
    repos.insert_project(Project::from_repo("owner/repo"));
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let err =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::InPlace)
            .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
    assert!(err.to_string().contains("has no checkout path"), "{err}");
    assert_eq!(repos.list_task_runs_for_task(&task_id).unwrap().len(), 0);
}

/// A checkout that moved or was deleted fails at Run, not at terminal spawn: a run committed as
/// `Prepared` against a bad cwd cannot be prepared again and Run would just retry it.
#[test]
fn run_task_in_place_rejects_missing_checkout_and_creates_no_run() {
    let mut repos = FakeRepos::default();
    insert_runnable_project_at(&repos, "/nonexistent/checkout");
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let err =
        run_task(&mut repos, &FakeTaskRunOutputs::default(), &task_id, None, RunMode::InPlace)
            .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
    assert!(err.to_string().contains("project checkout does not exist"), "{err}");
    assert_eq!(
        repos.list_task_runs_for_task(&task_id).unwrap().len(),
        0,
        "no dead-end Prepared run is left behind"
    );
    assert_eq!(repos.get_bench_for_task(&task_id).unwrap(), None);
}
