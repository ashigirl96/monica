use super::*;
use crate::usecases::runs::{take_launchable_pending_launches, worktree_run_needs_fresh_run};
use crate::{PendingLaunchStore, RunTaskResult};
use monica_domain::{AgentSessionId, RunspaceId, TaskRunId};

fn launch_for(task_id: &TaskId, run_id: &TaskRunId) -> RunTaskResult {
    RunTaskResult {
        task_id: task_id.clone(),
        task_run_id: run_id.clone(),
        runspace_id: RunspaceId::from_store(format!("bench-{task_id}")),
        cwd: "/wt".to_string(),
        env: Vec::new(),
        initial_command: "claude".to_string(),
    }
}

fn stop_primary(repos: &mut FakeRepos, task_id: &TaskId, run_id: &TaskRunId, session: Option<&str>) {
    if let Some(session) = session {
        assert!(repos
            .claim_prepared_run(run_id, &AgentSessionId::from_agent(session))
            .unwrap());
    }
    repos.finish_task_run(run_id, task_id, TaskRunStatus::Stopped).unwrap();
}

#[test]
fn worktree_run_needs_fresh_run_without_a_primary() {
    let mut repos = FakeRepos::default();
    let task_id = repos.insert_task_for_run(None);
    assert!(worktree_run_needs_fresh_run(&repos, &task_id).unwrap());
}

#[test]
fn worktree_run_launches_a_prepared_primary_as_it_stands() {
    let mut repos = FakeRepos::default();
    let (task_id, _) = task_with_prepared_primary(&mut repos);
    assert!(!worktree_run_needs_fresh_run(&repos, &task_id).unwrap());
}

#[test]
fn worktree_run_resumes_a_stopped_primary_with_a_session() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_prepared_primary(&mut repos);
    stop_primary(&mut repos, &task_id, &run_id, Some("sess-1"));
    assert!(!worktree_run_needs_fresh_run(&repos, &task_id).unwrap());
}

#[test]
fn worktree_run_needs_fresh_run_after_a_stop_with_no_session() {
    let mut repos = FakeRepos::default();
    let (task_id, run_id) = task_with_prepared_primary(&mut repos);
    stop_primary(&mut repos, &task_id, &run_id, None);
    assert!(worktree_run_needs_fresh_run(&repos, &task_id).unwrap());
}

#[test]
fn take_returns_launches_for_runs_that_can_still_open() {
    let mut repos = FakeRepos::default();
    let (prepared_task, prepared_run) = task_with_prepared_primary(&mut repos);
    let (resumable_task, resumable_run) = task_with_prepared_primary(&mut repos);
    stop_primary(&mut repos, &resumable_task, &resumable_run, Some("sess-1"));
    repos.put_pending_launch(&launch_for(&prepared_task, &prepared_run)).unwrap();
    repos.put_pending_launch(&launch_for(&resumable_task, &resumable_run)).unwrap();

    let taken = take_launchable_pending_launches(&mut repos).unwrap();

    let mut ids: Vec<String> = taken.iter().map(|l| l.task_run_id.to_string()).collect();
    ids.sort();
    let mut expected = vec![prepared_run.to_string(), resumable_run.to_string()];
    expected.sort();
    assert_eq!(ids, expected);
    assert!(take_launchable_pending_launches(&mut repos).unwrap().is_empty());
}

#[test]
fn take_drops_launches_whose_run_can_no_longer_open() {
    let mut repos = FakeRepos::default();
    let (failed_task, failed_run) = task_with_prepared_primary(&mut repos);
    repos
        .finish_task_run(&failed_run, &failed_task, TaskRunStatus::Failed)
        .unwrap();
    let (running_task, running_run) = task_with_running_primary(&mut repos);
    let (stopped_task, stopped_run) = task_with_prepared_primary(&mut repos);
    stop_primary(&mut repos, &stopped_task, &stopped_run, None);
    repos.put_pending_launch(&launch_for(&failed_task, &failed_run)).unwrap();
    repos.put_pending_launch(&launch_for(&running_task, &running_run)).unwrap();
    repos.put_pending_launch(&launch_for(&stopped_task, &stopped_run)).unwrap();
    repos
        .put_pending_launch(&launch_for(
            &TaskId::from_store("MON-404".to_string()),
            &TaskRunId::from_store("run-404".to_string()),
        ))
        .unwrap();

    assert!(take_launchable_pending_launches(&mut repos).unwrap().is_empty());
    // Dropped, not deferred: a second take finds nothing left behind either.
    assert!(take_launchable_pending_launches(&mut repos).unwrap().is_empty());
}
