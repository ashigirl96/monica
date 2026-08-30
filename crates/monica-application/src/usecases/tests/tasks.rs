use super::*;
use super::support::*;
use crate::usecases::tasks::{attach_terminal_session_to_task, MakeMainOutcome};
use monica_domain::AgentSessionId;

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
fn close_task_delegates_run_cleanup_to_git_gateway() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    repos
        .start_task_run(NewTaskRun {
            task_id: task_id.clone(),
            agent: None,
            branch: Some("issue-42".to_string()),
            worktree_path: Some("/tmp/wt".to_string()),
        })
        .unwrap();
    let git = FakeGit::default();
    let report = close_task(&mut repos, &git, &task_id).unwrap();
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
            terminal_tab_id: Some("tab-2"),
            ..HookContext::default()
        },
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();
    record_claude_hook(
        &mut repos,
        HookContext {
            task_id: Some(&task_id),
            terminal_tab_id: Some("tab-2"),
            ..HookContext::default()
        },
        &started("sess-3", Continuation::Fresh),
    )
    .unwrap();
    let latest_in_tab = repos
        .find_task_run_by_session(&task_id, &AgentSessionId::from_agent("sess-3"))
        .unwrap()
        .unwrap();

    let outcome = make_main_by_terminal_tab(&repos, "tab-2").unwrap();
    assert_eq!(
        outcome,
        MakeMainOutcome::Changed {
            task_id: task_id.to_string(),
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
            task_id: task_id.clone(),
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
            terminal_tab_id: Some("tab-2"),
            ..HookContext::default()
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
            terminal_tab_id: Some("tab-1"),
            ..HookContext::default()
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
            task_id: task_id.clone(),
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


#[test]
fn attach_creates_a_running_side_run_carrying_the_tab_and_session() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let report =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id).unwrap();

    assert_eq!(report.task_id, task_id);
    assert_eq!(report.task_title, "tracked");
    assert!(report.detached_run_ids.is_empty());
    assert_eq!(
        report.agent_session_id,
        Some(AgentSessionId::from_agent("sess-1"))
    );

    let run = repos.get_task_run(&report.task_run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Running);
    assert_eq!(run.terminal_tab_id.as_deref(), Some("tab-1"));
    assert_eq!(run.agent, Some(Agent::Claude));
    assert_eq!(run.branch, None);
    assert_eq!(run.worktree_path, None);
    // The task follows its run into in_progress, exactly as a hook-created run would.
    assert_eq!(
        repos.get_task(&task_id).unwrap().unwrap().status,
        TaskStatus::InProgress
    );
}

#[test]
fn attach_leaves_the_primary_pointer_alone_so_prepare_stays_available() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id).unwrap();

    assert_eq!(
        repos.get_task(&task_id).unwrap().unwrap().primary_task_run_id,
        None
    );
}

#[test]
fn attach_without_an_observed_agent_session_still_binds_the_tab() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", None);

    let report =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id).unwrap();

    assert_eq!(report.agent_session_id, None);
    let run = repos.get_task_run(&report.task_run_id).unwrap().unwrap();
    assert_eq!(run.terminal_tab_id.as_deref(), Some("tab-1"));
}

#[test]
fn re_attach_settles_the_previous_run_and_keeps_its_session_as_history() {
    let mut repos = FakeRepos::default();
    let first_task = repos.insert_task_for_run(None);
    let second_task = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let first =
        attach_terminal_session_to_task(&mut repos, &first_task, Agent::Claude, "tab-1", &session_id).unwrap();
    let second =
        attach_terminal_session_to_task(&mut repos, &second_task, Agent::Claude, "tab-1", &session_id).unwrap();

    assert_eq!(second.detached_run_ids, vec![first.task_run_id.clone()]);

    // Every settlement path keys on the tab, so unbinding without settling would strand this run
    // as "running" forever on the first task's board.
    let old = repos.get_task_run(&first.task_run_id).unwrap().unwrap();
    assert_eq!(old.status, TaskRunStatus::Stopped);
    assert_eq!(old.terminal_tab_id, None);
    assert_eq!(
        old.agent_session_id,
        Some(AgentSessionId::from_agent("sess-1"))
    );

    // Exactly one run answers for the tab.
    assert_eq!(
        repos
            .find_task_run_by_terminal_tab("tab-1")
            .unwrap()
            .map(|run| run.id),
        Some(second.task_run_id)
    );
}

#[test]
fn re_attach_leaves_an_already_settled_previous_run_untouched() {
    let mut repos = FakeRepos::default();
    let first_task = repos.insert_task_for_run(None);
    let second_task = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let first =
        attach_terminal_session_to_task(&mut repos, &first_task, Agent::Claude, "tab-1", &session_id).unwrap();
    repos
        .finish_task_run(&first.task_run_id, &first_task, TaskRunStatus::Failed)
        .unwrap();

    attach_terminal_session_to_task(&mut repos, &second_task, Agent::Claude, "tab-1", &session_id).unwrap();

    assert_eq!(
        repos.get_task_run(&first.task_run_id).unwrap().unwrap().status,
        TaskRunStatus::Failed
    );
}

#[test]
fn attach_rejects_an_unknown_task() {
    let mut repos = FakeRepos::default();
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));
    let err = attach_terminal_session_to_task(
        &mut repos,
        &TaskId::from_store("MON-404".to_string()),
        Agent::Claude,
        "tab-1",
        &session_id,
    )
    .unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)), "{err:?}");
}

#[test]
fn attach_rejects_a_closed_task() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    repos.mark_task_closed(&task_id).unwrap();
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let err =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id).unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
}

#[test]
fn attach_rejects_an_unknown_terminal_session() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let err =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", "ts-404").unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)), "{err:?}");
}

#[test]
fn attach_rejects_a_session_belonging_to_another_tab() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let err = attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-2", &session_id)
        .unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
}

/// Nothing corrects `agent` after the fact — hook observations never touch it — and a resume
/// builds its command line from it, so the caller's agent must land verbatim rather than staying
/// NULL for the profile default to fill in later.
#[test]
fn attach_records_the_agent_it_was_given() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let report =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id)
            .unwrap();

    assert_eq!(
        repos.get_task_run(&report.task_run_id).unwrap().unwrap().agent,
        Some(Agent::Claude)
    );
}
