use super::*;
use super::support::*;
use crate::bench::bench_runspace_id;
use crate::usecases::tasks::{
    attach_terminal_session_to_task, list_tab_task_bindings, MakeMainOutcome, TabTaskBinding,
};
use monica_domain::{AgentSessionId, RunspaceId};

/// A shell session spawned inside `runspace_id` — the shape of a tab opened in a task's bench.
fn tab_session_in_runspace(repos: &mut FakeRepos, tab_id: &str, runspace_id: &RunspaceId) -> String {
    repos
        .create_terminal_session(NewTerminalSession {
            runspace_id: Some(runspace_id.clone()),
            tab_id: Some(tab_id.to_string()),
            kind: TerminalSessionKind::Shell,
            cwd: "/repo".to_string(),
            shell: "/bin/zsh".to_string(),
            rows: 24,
            cols: 80,
        })
        .unwrap()
        .id
}

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
fn attach_creates_a_running_primary_run_carrying_the_tab_and_session() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let report =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    assert_eq!(report.task_id, task_id);
    assert_eq!(report.task_title, "tracked");
    assert!(report.detached_run_ids.is_empty());
    assert_eq!(
        report.agent_session_id,
        Some(AgentSessionId::from_agent("sess-1"))
    );
    assert!(report.became_primary());
    assert_eq!(report.runspace_id, bench_runspace_id(&task_id));

    let run = repos.get_task_run(&report.task_run_id).unwrap().unwrap();
    assert_eq!(run.status, TaskRunStatus::Running);
    assert_eq!(run.terminal_tab_id.as_deref(), Some("tab-1"));
    assert_eq!(run.agent, Some(Agent::Claude));
    assert_eq!(run.branch, None);
    assert_eq!(run.worktree_path, None);
    // The task follows its run into in_progress, exactly as a hook-created run would.
    let task = repos.get_task(&task_id).unwrap().unwrap();
    assert_eq!(task.status, TaskStatus::InProgress);
    // The tab becomes the task's main workplace, so its run takes the Main Run slot.
    assert_eq!(task.primary_task_run_id, Some(report.task_run_id));
}

/// The bench is where the Workbench moves the tab, so attach creates it when the task has none —
/// at the directory the shell is in now, not where its session was spawned.
#[test]
fn attach_creates_the_bench_at_the_tab_cwd_when_the_task_has_none() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    // The session remembers where it was spawned; the caller passes where the shell is now.
    let session_id = raw_tab_session_at(&mut repos, "tab-1", Some("sess-1"), "/spawned/here");

    attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/now/here")
        .unwrap();

    assert_eq!(
        repos.get_bench_for_task(&task_id).unwrap(),
        Some((bench_runspace_id(&task_id), "/now/here".to_string()))
    );
}

/// An existing bench keeps its cwd: a worktree run may have pinned it, and the tab's shell does not
/// move anyway.
#[test]
fn attach_leaves_an_existing_bench_cwd_alone() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    repos
        .create_bench(&task_id, &bench_runspace_id(&task_id), "/wt/issue-1")
        .unwrap();
    let session_id = raw_tab_session_at(&mut repos, "tab-1", Some("sess-1"), "/somewhere/else");

    let report =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    assert_eq!(report.runspace_id, bench_runspace_id(&task_id));
    assert_eq!(
        repos.get_bench_for_task(&task_id).unwrap(),
        Some((bench_runspace_id(&task_id), "/wt/issue-1".to_string()))
    );
}

/// A primary still mid-prepare keeps the slot: displacing it would orphan the prepared worktree,
/// the same rule `make_main_by_terminal_tab` applies.
#[test]
fn attach_keeps_a_prepared_primary_in_place_and_reports_it() {
    let mut repos = FakeRepos::default();
    let (task_id, prepared_id) = task_with_prepared_primary(&mut repos);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let report =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    assert!(!report.became_primary());
    assert_eq!(report.kept_primary_run_id, Some(prepared_id.clone()));
    assert_eq!(
        repos.get_task(&task_id).unwrap().unwrap().primary_task_run_id,
        Some(prepared_id)
    );
    // The attached run still exists and drives the tab.
    assert_eq!(
        repos.find_task_run_by_terminal_tab("tab-1").unwrap().map(|run| run.id),
        Some(report.task_run_id)
    );
}

/// A running worktree primary is displaced like any other live run: the attached tab is now the
/// task's main workplace.
#[test]
fn attach_displaces_a_running_primary() {
    let mut repos = FakeRepos::default();
    let (task_id, running_id) = task_with_running_primary(&mut repos);
    let session_id = raw_tab_session(&mut repos, "tab-9", Some("sess-9"));

    let report =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-9", &session_id, "/repo").unwrap();

    assert!(report.became_primary());
    assert_eq!(
        repos.get_task(&task_id).unwrap().unwrap().primary_task_run_id,
        Some(report.task_run_id)
    );
    // The displaced run keeps running as a side run; nothing settles it.
    assert_eq!(
        repos.get_task_run(&running_id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );
}

/// A shell spawned inside a bench carries MONICA_TASK_ID and its hooks resolve task-scoped, so a
/// run attached to it would be dead — the GUI has no env to check, so the session's runspace is
/// the tell.
#[test]
fn attach_rejects_a_session_spawned_in_a_bench_runspace() {
    let mut repos = FakeRepos::default();
    let bench_task = repos.insert_task_for_run(None);
    let other_task = repos.insert_task_for_run(None);
    let bench = bench_runspace_id(&bench_task);
    repos.create_bench(&bench_task, &bench, "/repo").unwrap();
    let session_id = tab_session_in_runspace(&mut repos, "tab-1", &bench);

    let err = attach_terminal_session_to_task(&mut repos, &other_task, Agent::Claude, "tab-1", &session_id, "/repo")
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
    assert!(err.to_string().contains(bench_task.as_str()), "{err}");
    assert!(repos.find_task_run_by_terminal_tab("tab-1").unwrap().is_none());
}

/// A tab that already moved into one task's bench (its session still records the shell runspace
/// it was spawned in) can be re-attached to another task.
/// A dead session has no agent to adopt. Without this the menu's own liveness check is the only
/// guard, and it goes stale the moment the shell exits behind an open picker.
#[test]
fn attach_rejects_a_dead_session() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));
    repos
        .update_terminal_session_status(&session_id, TerminalSessionStatus::Exited, Some(0))
        .unwrap();

    let err = attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo")
        .unwrap_err();

    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
    assert!(err.to_string().contains("exited"), "{err}");
    assert!(repos.find_task_run_by_terminal_tab("tab-1").unwrap().is_none());
    assert_eq!(
        repos.get_task(&task_id).unwrap().unwrap().primary_task_run_id,
        None
    );
}

#[test]
fn attach_accepts_a_session_spawned_in_a_plain_shell_runspace() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let shell = RunspaceId::from_store("shell-1".to_string());
    let session_id = tab_session_in_runspace(&mut repos, "tab-1", &shell);

    attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    assert!(repos.find_task_run_by_terminal_tab("tab-1").unwrap().is_some());
}

#[test]
fn attach_without_an_observed_agent_session_still_binds_the_tab() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", None);

    let report =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    assert_eq!(report.agent_session_id, None);
    let run = repos.get_task_run(&report.task_run_id).unwrap().unwrap();
    assert_eq!(run.terminal_tab_id.as_deref(), Some("tab-1"));
}

#[test]
fn re_attach_settles_the_previous_run_and_takes_its_session_along() {
    let mut repos = FakeRepos::default();
    let first_task = repos.insert_task_for_run(None);
    let second_task = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let first =
        attach_terminal_session_to_task(&mut repos, &first_task, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();
    let second =
        attach_terminal_session_to_task(&mut repos, &second_task, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    assert_eq!(second.detached_run_ids, vec![first.task_run_id.clone()]);

    // Every settlement path keys on the tab, so unbinding without settling would strand this run
    // as "running" forever on the first task's board.
    let old = repos.get_task_run(&first.task_run_id).unwrap().unwrap();
    assert_eq!(old.status, TaskRunStatus::Stopped);
    assert_eq!(old.terminal_tab_id, None);
    // The old run stays the first task's primary, so it must not stay resumable: Run there would
    // `--resume` the very conversation now driving the second task.
    assert_eq!(
        repos.get_task(&first_task).unwrap().unwrap().primary_task_run_id,
        Some(first.task_run_id.clone())
    );
    assert_eq!(old.agent_session_id, None);
    assert!(old.resumable_session().is_none());

    // Exactly one run answers for the tab.
    assert_eq!(
        repos
            .find_task_run_by_terminal_tab("tab-1")
            .unwrap()
            .map(|run| run.id),
        Some(second.task_run_id.clone())
    );
    // The second task gets the tab as its Main Run and a bench to show it in.
    assert_eq!(
        repos.get_task(&second_task).unwrap().unwrap().primary_task_run_id,
        Some(second.task_run_id)
    );
    assert_eq!(second.runspace_id, bench_runspace_id(&second_task));
    assert!(repos.get_bench_for_task(&second_task).unwrap().is_some());
}

#[test]
fn list_tab_task_bindings_pairs_live_tab_runs_with_their_bench() {
    let mut repos = FakeRepos::default();
    let attached = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));
    let report =
        attach_terminal_session_to_task(&mut repos, &attached, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    // A hook-driven run in a bench tab is bound the same way.
    let (running_task, _) = task_with_running_primary(&mut repos);
    repos
        .create_bench(&running_task, &bench_runspace_id(&running_task), "/wt")
        .unwrap();
    record_claude_hook(
        &mut repos,
        HookContext {
            task_id: Some(&running_task),
            terminal_tab_id: Some("tab-2"),
            ..HookContext::default()
        },
        &started("sess-2", Continuation::Fresh),
    )
    .unwrap();

    // A live tab run whose task has no bench has nowhere to go and is skipped.
    let benchless = repos.insert_task_for_run(None);
    record_claude_hook(
        &mut repos,
        HookContext {
            task_id: Some(&benchless),
            terminal_tab_id: Some("tab-3"),
            ..HookContext::default()
        },
        &started("sess-3", Continuation::Fresh),
    )
    .unwrap();

    let mut bindings = list_tab_task_bindings(&repos).unwrap();
    bindings.sort_by(|a, b| a.terminal_tab_id.cmp(&b.terminal_tab_id));
    assert_eq!(
        bindings,
        vec![
            TabTaskBinding {
                terminal_tab_id: "tab-1".to_string(),
                task_id: attached.clone(),
                runspace_id: bench_runspace_id(&attached),
            },
            TabTaskBinding {
                terminal_tab_id: "tab-2".to_string(),
                task_id: running_task.clone(),
                runspace_id: bench_runspace_id(&running_task),
            },
        ]
    );

    // A settled run no longer drives its tab.
    repos
        .finish_task_run(&report.task_run_id, &attached, TaskRunStatus::Stopped)
        .unwrap();
    let bindings = list_tab_task_bindings(&repos).unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].terminal_tab_id, "tab-2");
}

/// Only the session that actually moves is taken along. A new agent in the same tab leaves the
/// earlier agent's session on the old run, which stays resumable for its task.
#[test]
fn re_attach_with_a_new_agent_session_keeps_the_old_run_resumable() {
    let mut repos = FakeRepos::default();
    let first_task = repos.insert_task_for_run(None);
    let second_task = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let first =
        attach_terminal_session_to_task(&mut repos, &first_task, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();
    repos
        .set_terminal_session_agent_status(
            &session_id,
            Some(AgentSessionStatus::Running),
            None,
            Some(&AgentSessionId::from_agent("sess-2")),
        )
        .unwrap();
    attach_terminal_session_to_task(&mut repos, &second_task, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

    let old = repos.get_task_run(&first.task_run_id).unwrap().unwrap();
    assert_eq!(old.status, TaskRunStatus::Stopped);
    assert_eq!(
        old.resumable_session(),
        Some(&AgentSessionId::from_agent("sess-1"))
    );
}

#[test]
fn re_attach_leaves_an_already_settled_previous_run_untouched() {
    let mut repos = FakeRepos::default();
    let first_task = repos.insert_task_for_run(None);
    let second_task = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let first =
        attach_terminal_session_to_task(&mut repos, &first_task, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();
    repos
        .finish_task_run(&first.task_run_id, &first_task, TaskRunStatus::Failed)
        .unwrap();

    attach_terminal_session_to_task(&mut repos, &second_task, Agent::Claude, "tab-1", &session_id, "/repo").unwrap();

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
        "/repo",
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
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo").unwrap_err();
    assert!(matches!(err, ApplicationError::Validation(_)), "{err:?}");
}

#[test]
fn attach_rejects_an_unknown_terminal_session() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let err =
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", "ts-404", "/repo").unwrap_err();
    assert!(matches!(err, ApplicationError::NotFound(_)), "{err:?}");
}

#[test]
fn attach_rejects_a_session_belonging_to_another_tab() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    let session_id = raw_tab_session(&mut repos, "tab-1", Some("sess-1"));

    let err = attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-2", &session_id, "/repo")
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
        attach_terminal_session_to_task(&mut repos, &task_id, Agent::Claude, "tab-1", &session_id, "/repo")
            .unwrap();

    assert_eq!(
        repos.get_task_run(&report.task_run_id).unwrap().unwrap().agent,
        Some(Agent::Claude)
    );
}
