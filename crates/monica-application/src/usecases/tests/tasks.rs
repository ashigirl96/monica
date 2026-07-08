use super::*;
use super::support::*;
use crate::usecases::tasks::MakeMainOutcome;

#[test]
fn create_raw_task_links_project_and_has_no_issue_ref() {
    let mut repos = FakeRepos::default();
    repos.insert_project(Project::from_repo("owner/repo"));
    let task = create_raw_task(&mut repos, "  explore idea  ", "owner/repo").unwrap();
    assert_eq!(task.title, "explore idea");
    assert_eq!(task.project_id.as_deref(), Some("owner/repo"));
    assert!(repos.list_external_refs(&task.id).unwrap().is_empty());
}

#[test]
fn create_raw_task_rejects_blank_title() {
    let mut repos = FakeRepos::default();
    repos.insert_project(Project::from_repo("owner/repo"));
    let err = create_raw_task(&mut repos, "   ", "owner/repo").unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
}

#[test]
fn create_raw_task_rejects_unknown_project() {
    let mut repos = FakeRepos::default();
    let err = create_raw_task(&mut repos, "explore", "owner/repo").unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)), "{err:?}");
}

#[test]
fn close_issue_delegates_run_cleanup_to_git_gateway() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    repos
        .start_task_run(NewTaskRun {
            task_id: TaskId::from_store(task_id.clone()),
            agent: None,
            branch: Some("issue-42".to_string()),
            worktree_path: Some("/tmp/wt".to_string()),
        })
        .unwrap();
    let git = FakeGit::default();
    let report = close_issue(&mut repos, &git, &task_id).unwrap();
    assert_eq!(report.removed_branches, vec!["issue-42"]);
    assert!(git.cleaned());
}


#[test]
fn make_main_by_terminal_tab_promotes_side_run_and_reports_no_ops() {
    let mut repos = FakeRepos::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos);

    assert_eq!(
        make_main_by_terminal_tab(&repos, "tab-unknown").unwrap(),
        MakeMainOutcome::NotFound
    );

    // Side run born in tab-2, then a restarted claude in the same tab: newest run must win.
    record_claude_hook(
        &mut repos,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-2"),
            terminal_session_id: None,
        },
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();
    record_claude_hook(
        &mut repos,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-2"),
            terminal_session_id: None,
        },
        &started("sess-3", Continuation::Fresh),
    )
    .unwrap();
    let latest_in_tab = repos
        .find_task_run_by_session(&task_id, "sess-3")
        .unwrap()
        .unwrap();

    let outcome = make_main_by_terminal_tab(&repos, "tab-2").unwrap();
    assert_eq!(
        outcome,
        MakeMainOutcome::Changed {
            task_id: task_id.clone(),
            task_run_id: latest_in_tab.id.to_string(),
            status: TaskRunStatus::WaitingForUser,
        }
    );
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(
        task.primary_task_run_id.as_deref(),
        Some(latest_in_tab.id.as_str())
    );
    assert_ne!(task.primary_task_run_id.as_deref(), Some(primary_id.as_str()));

    assert_eq!(
        make_main_by_terminal_tab(&repos, "tab-2").unwrap(),
        MakeMainOutcome::AlreadyMain
    );
}

#[test]
fn make_main_by_terminal_tab_refuses_while_primary_is_mid_prepare() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    // A SettingUp primary, as left behind by start_run while execute_run is in flight.
    let preparing = repos
        .start_task_run(NewTaskRun {
            task_id: TaskId::from_store(task_id.clone()),
            agent: None,
            branch: Some("issue-1".to_string()),
            worktree_path: None,
        })
        .unwrap();
    repos.set_primary_task_run(&task_id, &preparing.id).unwrap();

    record_claude_hook(
        &mut repos,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-2"),
            terminal_session_id: None,
        },
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();

    assert_eq!(
        make_main_by_terminal_tab(&repos, "tab-2").unwrap(),
        MakeMainOutcome::PrimaryBusy
    );
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(task.primary_task_run_id.as_deref(), Some(preparing.id.as_str()));
}

#[test]
fn primary_terminal_tab_resolves_through_primary_run() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    assert_eq!(primary_terminal_tab(&repos, &task_id).unwrap(), None);

    record_claude_hook(
        &mut repos,
        HookContext {
            task_id: Some(&task_id),
            task_run_id: None,
            terminal_tab_id: Some("tab-1"),
            terminal_session_id: None,
        },
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert_eq!(
        primary_terminal_tab(&repos, &task_id).unwrap().as_deref(),
        Some("tab-1")
    );
}

#[test]
fn record_claude_hook_prefers_explicit_run_id_over_session_lookup() {
    let mut repos = FakeRepos::default();
    let (task_id, primary_id) = task_with_running_primary(&mut repos);
    let other = repos
        .start_task_run(NewTaskRun {
            task_id: TaskId::from_store(task_id.clone()),
            agent: Some(Agent::Claude),
            branch: None,
            worktree_path: None,
        })
        .unwrap();

    // sess-1 belongs to the primary, but the explicit run id must win.
    let report = record_claude_hook(
        &mut repos,
        hook_ctx(&task_id, Some(&other.id)),
        &started("sess-1", Continuation::Fresh),
    )
    .unwrap();
    assert!(report.task_run_linked);
    assert!(!report.task_run_created);
    assert_eq!(
        repos.get_task_run(&other.id).unwrap().unwrap().status,
        TaskRunStatus::WaitingForUser
    );
    assert_ne!(other.id.as_str(), primary_id.as_str());
}
