use super::*;
use crate::github::{GithubIssueState, IssueAddress, IssueBlocker};
use monica_domain::{RunMode, TaskId};

// The gate reads what a sync mirrored, so every case seeds blockers and then asks whether a first
// run may start.

fn blocker(number: i64, state: GithubIssueState, merged_pr: bool) -> IssueBlocker {
    IssueBlocker {
        address: IssueAddress { repo: "owner/repo".to_string(), number },
        state,
        closed_by_merged_pull_request: merged_pr,
    }
}

fn blocked_task(repos: &mut FakeRepos, blockers: Vec<IssueBlocker>) -> TaskId {
    insert_runnable_project(repos);
    let task_id = insert_issue_backed_task(repos, 9);
    repos.set_task_blockers(task_id.as_str(), blockers);
    task_id
}

#[test]
fn a_task_with_no_blockers_starts() {
    let mut repos = FakeRepos::default();
    let task_id = blocked_task(&mut repos, vec![]);

    assert!(start_run(&mut repos, &task_id, false).is_ok());
}

#[test]
fn an_unfinished_blocker_refuses_the_run_and_names_what_blocks_it() {
    let mut repos = FakeRepos::default();
    let task_id = blocked_task(&mut repos, vec![blocker(7, GithubIssueState::Open, false)]);

    let err = start_run(&mut repos, &task_id, false).unwrap_err();

    assert!(matches!(err, ApplicationError::Conflict(_)), "{err:?}");
    assert!(
        err.to_string().contains("owner/repo#7"),
        "the reader has to learn which issue to go land: {err}"
    );
}

#[test]
fn every_unfinished_blocker_is_named_not_just_the_first() {
    let mut repos = FakeRepos::default();
    let task_id = blocked_task(
        &mut repos,
        vec![
            blocker(7, GithubIssueState::Open, false),
            blocker(8, GithubIssueState::Closed, false),
            blocker(9, GithubIssueState::Open, false),
        ],
    );

    let err = start_run(&mut repos, &task_id, false).unwrap_err();

    let message = err.to_string();
    assert!(message.contains("owner/repo#7"), "{message}");
    assert!(message.contains("owner/repo#9"), "{message}");
    assert!(
        !message.contains("owner/repo#8"),
        "a cleared blocker is not something the reader can act on: {message}"
    );
}

#[test]
fn a_closed_blocker_lets_the_run_start() {
    let mut repos = FakeRepos::default();
    let task_id = blocked_task(&mut repos, vec![blocker(7, GithubIssueState::Closed, false)]);

    assert!(start_run(&mut repos, &task_id, false).is_ok());
}

#[test]
fn a_blocker_closed_by_a_merged_pull_request_lets_the_run_start_while_still_open() {
    let mut repos = FakeRepos::default();
    let task_id = blocked_task(&mut repos, vec![blocker(7, GithubIssueState::Open, true)]);

    assert!(
        start_run(&mut repos, &task_id, false).is_ok(),
        "the upstream work landed at the merge; waiting for the issue to close would stall the \
         next task on bookkeeping"
    );
}

#[test]
fn a_blocker_no_task_tracks_still_blocks() {
    let mut repos = FakeRepos::default();
    insert_runnable_project(&repos);
    let task_id = insert_issue_backed_task(&mut repos, 9);
    // Nothing in `repos` tracks issue 404 — the gate decides from GitHub's answer alone, which is
    // why blockers are stored as addresses rather than resolved into task ids the way parents are.
    repos.set_task_blockers(
        task_id.as_str(),
        vec![IssueBlocker {
            address: IssueAddress { repo: "other/repo".to_string(), number: 404 },
            state: GithubIssueState::Open,
            closed_by_merged_pull_request: false,
        }],
    );

    let err = start_run(&mut repos, &task_id, false).unwrap_err();
    assert!(err.to_string().contains("other/repo#404"), "{err}");
}

#[test]
fn force_starts_a_blocked_task() {
    let mut repos = FakeRepos::default();
    let task_id = blocked_task(&mut repos, vec![blocker(7, GithubIssueState::Open, false)]);

    assert!(start_run(&mut repos, &task_id, true).is_ok());
}

#[test]
fn an_in_place_run_is_gated_too() {
    let mut repos = FakeRepos::default();
    let task_id = blocked_task(&mut repos, vec![blocker(7, GithubIssueState::Open, false)]);

    let err = run_task(
        &mut repos,
        &FakeTaskRunOutputs::default(),
        &task_id,
        None,
        RunMode::InPlace,
        false,
    )
    .unwrap_err();

    assert!(matches!(err, ApplicationError::Conflict(_)), "{err:?}");
    assert!(err.to_string().contains("owner/repo#7"), "{err}");
}

#[test]
fn a_refused_run_leaves_no_run_behind() {
    let mut repos = FakeRepos::default();
    let task_id = blocked_task(&mut repos, vec![blocker(7, GithubIssueState::Open, false)]);

    start_run(&mut repos, &task_id, false).unwrap_err();

    assert_eq!(
        repos.get_task(&task_id).unwrap().unwrap().primary_task_run_id,
        None,
        "the gate runs before the run is created, so a refusal costs nothing to undo"
    );
}
