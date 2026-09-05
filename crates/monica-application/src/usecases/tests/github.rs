use std::collections::HashMap;

use super::*;
use super::support::*;
use crate::usecases::github::{
    bulk_sync_issues, bulk_sync_pull_requests, TrackGithubIssueInput, TrackOutcome,
};
use crate::{
    FetchedIssue, GithubIssueState, GithubPullRequest, GithubPullRequestStatus, IssueAddress,
    RepoPullRequest, UnresolvedPullRequestRef,
};

#[tokio::test]
async fn track_github_issue_uses_gateway_and_repositories() {
    let mut repos = FakeRepos::default();
    repos.insert_project(Project::from_repo("owner/repo"));
    let report = track_github_issue(
        &mut repos,
        &FakeGithub,
        TrackGithubIssueInput {
            repo: "Owner/Repo".to_string(),
            number: 42,
        },
    )
    .await
    .unwrap();
    assert_eq!(report.task.id, "MON-1");
    assert_eq!(report.task.project_id.as_deref(), Some("owner/repo"));
    assert_eq!(report.issue.number, 42);
    assert_eq!(report.outcome, TrackOutcome::Created);

    let refs = repos.list_external_refs(&report.task.id).unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].provider, Provider::Github);
    assert_eq!(refs[0].ref_type, RefType::Issue);
    assert_eq!(refs[0].number, Some(42));
}


fn track_input() -> TrackGithubIssueInput {
    TrackGithubIssueInput { repo: "owner/repo".to_string(), number: 42 }
}

#[tokio::test]
async fn track_github_issue_returns_the_existing_open_task_on_retrack() {
    let mut repos = FakeRepos::default();
    let first = track_github_issue(&mut repos, &FakeGithub, track_input())
        .await
        .unwrap();
    let second = track_github_issue(&mut repos, &FakeGithub, track_input())
        .await
        .unwrap();

    assert_eq!(first.outcome, TrackOutcome::Created);
    assert_eq!(second.outcome, TrackOutcome::AlreadyTracked);
    assert_eq!(second.task.id, first.task.id);
    assert_eq!(repos.list_tasks().unwrap().len(), 1, "re-tracking must not fork a second task");
    assert_eq!(
        repos.list_external_refs(&first.task.id).unwrap().len(),
        1,
        "the issue ref must not be duplicated either"
    );
}

#[tokio::test]
async fn track_github_issue_creates_a_new_task_when_the_previous_one_is_closed() {
    let mut repos = FakeRepos::default();
    let first = track_github_issue(&mut repos, &FakeGithub, track_input())
        .await
        .unwrap();
    repos.mark_task_closed(&first.task.id).unwrap();

    let second = track_github_issue(&mut repos, &FakeGithub, track_input())
        .await
        .unwrap();

    assert_eq!(second.outcome, TrackOutcome::Created);
    assert_eq!(second.task.id, "MON-2");
    assert_eq!(repos.list_tasks().unwrap().len(), 2);
}

#[tokio::test]
async fn track_github_issue_refreshes_the_cached_title_of_an_existing_task() {
    let mut repos = FakeRepos::default();
    let github = RetitlingGithub::new("original title");
    let first = track_github_issue(&mut repos, &github, track_input())
        .await
        .unwrap();
    assert_eq!(first.task.title, "original title");

    github.set_title("renamed upstream");
    let second = track_github_issue(&mut repos, &github, track_input())
        .await
        .unwrap();

    assert_eq!(second.task.id, first.task.id);
    assert_eq!(second.issue.title, "renamed upstream", "the report still reflects the fetch");
    assert_eq!(
        second.task.title, "renamed upstream",
        "the returned task is re-read after the cache is seeded, not the pre-upsert snapshot"
    );
    let ref_id = repos.list_external_refs(&second.task.id).unwrap()[0].id;
    assert_eq!(
        repos.issue_ref_state(ref_id).map(|(title, _)| title),
        Some("renamed upstream".to_string()),
    );
}

#[tokio::test]
async fn track_github_issue_leaves_the_task_row_without_a_baked_in_title() {
    let mut repos = FakeRepos::default();
    let github = RetitlingGithub::new("upstream title");
    let report = track_github_issue(&mut repos, &github, track_input())
        .await
        .unwrap();

    let ref_id = repos.list_external_refs(&report.task.id).unwrap()[0].id;
    assert_eq!(
        repos.issue_ref_state(ref_id),
        Some(("upstream title".to_string(), GithubIssueState::Open)),
        "the fetched title and state land in the ref cache",
    );
    // With the cache cleared the resolved title falls back to the (empty) stored column, which is
    // what proves nothing was written into `tasks.title`.
    repos.clear_issue_ref_states();
    assert_eq!(repos.get_task(&report.task.id).unwrap().unwrap().title, "");
}

fn sub_issue(number: i64, parent_repo: &str, parent_number: i64) -> FetchedIssue {
    FetchedIssue {
        parent: Some(IssueAddress { repo: parent_repo.to_string(), number: parent_number }),
        ..open_issue(number, "sub issue")
    }
}

fn open_issue(number: i64, title: &str) -> FetchedIssue {
    FetchedIssue {
        number,
        title: title.to_string(),
        state: GithubIssueState::Open,
        parent: None,
    }
}

#[tokio::test]
async fn bulk_sync_issues_refreshes_open_tasks_only() {
    let mut repos = FakeRepos::default();
    let tracked = track_github_issue(&mut repos, &FakeGithub, track_input())
        .await
        .unwrap();
    let closed = track_github_issue(
        &mut repos,
        &FakeGithub,
        TrackGithubIssueInput { repo: "owner/repo".to_string(), number: 43 },
    )
    .await
    .unwrap();
    repos.mark_task_closed(&closed.task.id).unwrap();

    let github = RepoIssueGithub::new(HashMap::from([(
        "owner/repo".to_string(),
        Some(vec![
            open_issue(42, "fresh 42"),
            open_issue(43, "fresh 43"),
        ]),
    )]));
    let synced = bulk_sync_issues(&mut repos, &github).await.unwrap();

    assert_eq!(synced, 1);
    assert_eq!(
        github.requested(),
        vec![("owner/repo".to_string(), vec![42])],
        "a closed task's issue is never even asked for"
    );
    assert_eq!(repos.get_task(&tracked.task.id).unwrap().unwrap().title, "fresh 42");
    assert_eq!(repos.get_task(&closed.task.id).unwrap().unwrap().title, "owner/repo issue");
}

#[tokio::test]
async fn bulk_sync_issues_records_the_state_without_touching_task_status() {
    let mut repos = FakeRepos::default();
    let tracked = track_github_issue(&mut repos, &FakeGithub, track_input())
        .await
        .unwrap();

    let github = RepoIssueGithub::new(HashMap::from([(
        "owner/repo".to_string(),
        Some(vec![FetchedIssue {
            number: 42,
            title: "closed upstream".to_string(),
            state: GithubIssueState::Closed,
            parent: None,
        }]),
    )]));
    bulk_sync_issues(&mut repos, &github).await.unwrap();

    let ref_id = repos.list_external_refs(&tracked.task.id).unwrap()[0].id;
    assert_eq!(
        repos.issue_ref_state(ref_id),
        Some(("closed upstream".to_string(), GithubIssueState::Closed))
    );
    assert_eq!(
        repos.get_task(&tracked.task.id).unwrap().unwrap().status,
        TaskStatus::Ready,
        "a closed issue must not close the task"
    );
}

#[tokio::test]
async fn bulk_sync_issues_keeps_known_state_when_a_repo_fetch_fails() {
    let mut repos = FakeRepos::default();
    let good = track_github_issue(&mut repos, &FakeGithub, track_input())
        .await
        .unwrap();
    let bad = track_github_issue(
        &mut repos,
        &FakeGithub,
        TrackGithubIssueInput { repo: "other/repo".to_string(), number: 7 },
    )
    .await
    .unwrap();

    let github = RepoIssueGithub::new(HashMap::from([
        (
            "owner/repo".to_string(),
            Some(vec![open_issue(42, "fresh 42")]),
        ),
        ("other/repo".to_string(), None),
    ]));
    let synced = bulk_sync_issues(&mut repos, &github).await.unwrap();

    assert_eq!(synced, 1, "only the healthy repo is recorded");
    assert_eq!(repos.get_task(&good.task.id).unwrap().unwrap().title, "fresh 42");
    assert_eq!(
        repos.get_task(&bad.task.id).unwrap().unwrap().title,
        "other/repo issue",
        "the failed repo keeps what track already cached instead of being blanked"
    );
}

#[tokio::test]
async fn bulk_sync_issues_is_a_noop_without_tracked_issues() {
    let mut repos = FakeRepos::default();
    let github = RepoIssueGithub::new(HashMap::new());
    assert_eq!(bulk_sync_issues(&mut repos, &github).await.unwrap(), 0);
    assert!(github.requested().is_empty());
}

#[tokio::test]
async fn bulk_sync_issues_fetches_a_shared_issue_once_and_writes_both_refs() {
    let mut repos = FakeRepos::default();
    let first = track_github_issue(&mut repos, &FakeGithub, track_input())
        .await
        .unwrap();
    repos.mark_task_closed(&first.task.id).unwrap();
    let second = track_github_issue(&mut repos, &FakeGithub, track_input())
        .await
        .unwrap();
    // Reopen the first so both tasks carry the same issue address at once.
    repos.update_task_status(&first.task.id, TaskStatus::Ready).unwrap();

    let github = RepoIssueGithub::new(HashMap::from([(
        "owner/repo".to_string(),
        Some(vec![open_issue(42, "shared")]),
    )]));
    let synced = bulk_sync_issues(&mut repos, &github).await.unwrap();

    assert_eq!(synced, 2, "both refs are recorded");
    assert_eq!(
        github.requested(),
        vec![("owner/repo".to_string(), vec![42])],
        "the shared number is fetched once"
    );
    assert_eq!(repos.get_task(&first.task.id).unwrap().unwrap().title, "shared");
    assert_eq!(repos.get_task(&second.task.id).unwrap().unwrap().title, "shared");
}

#[test]
fn github_auth_status_uses_auth_gateway() {
    let status = github_auth_status(&FakeAuth);
    assert!(status.authenticated);
}

fn recent_pr(
    number: i64,
    status: GithubPullRequestStatus,
    head_branch: &str,
    updated_at: &str,
) -> RepoPullRequest {
    RepoPullRequest {
        number,
        url: format!("https://github.com/owner/repo/pull/{number}"),
        status,
        head_branch: head_branch.to_string(),
        updated_at: updated_at.to_string(),
    }
}

fn candidate(task_id: &str, repo: &str, branch: &str) -> PullRequestBranchSyncCandidate {
    PullRequestBranchSyncCandidate {
        task_id: task_id.to_string(),
        repo: repo.to_string(),
        branch: branch.to_string(),
    }
}

fn unresolved(
    task_id: &str,
    external_ref_id: i64,
    repo: &str,
    number: i64,
) -> UnresolvedPullRequestRef {
    UnresolvedPullRequestRef {
        task_id: task_id.to_string(),
        external_ref_id,
        repo: repo.to_string(),
        number,
    }
}

#[tokio::test]
async fn bulk_sync_matches_recent_prs_to_branch_candidates() {
    let mut repos = FakeRepos::default();
    repos.set_branch_sync_candidates(vec![
        candidate("MON-1", "Owner/RepoA", "feature/x"),
        candidate("MON-2", "Owner/RepoA", "Feature/Y"),
        candidate("MON-3", "owner/repoB", "feature/z"),
        candidate("MON-4", "owner/repoC", "feature/w"),
    ]);

    let mut by_repo = HashMap::new();
    by_repo.insert(
        "Owner/RepoA".to_string(),
        Some(vec![
            recent_pr(10, GithubPullRequestStatus::Open, "feature/x", "2026-01-01T00:00:00Z"),
            // Same branch carries a newer Closed PR and an older Open one; active must win.
            recent_pr(20, GithubPullRequestStatus::Closed, "feature/y", "2026-03-01T00:00:00Z"),
            recent_pr(21, GithubPullRequestStatus::Open, "feature/y", "2026-02-01T00:00:00Z"),
        ]),
    );
    by_repo.insert(
        "owner/repoB".to_string(),
        Some(vec![recent_pr(
            30,
            GithubPullRequestStatus::Open,
            "unrelated-branch",
            "2026-01-01T00:00:00Z",
        )]),
    );
    // repoC fetch fails — must not abort the other repos.
    by_repo.insert("owner/repoC".to_string(), None);

    let github = RecentPrGithub::new(by_repo);
    let synced = bulk_sync_pull_requests(&mut repos, &github).await.unwrap();

    assert_eq!(synced, 2, "only MON-1 and MON-2 matched a PR");

    let recorded = repos.bulk_recorded();
    assert_eq!(recorded.len(), 3, "failed repo candidates are excluded from the record");
    let by_task: HashMap<String, Vec<GithubPullRequest>> = recorded
        .iter()
        .map(|(c, prs)| (c.task_id.clone(), prs.clone()))
        .collect();

    let m1 = &by_task["MON-1"];
    assert_eq!(m1.len(), 1);
    assert_eq!(m1[0].number, 10);
    assert_eq!(m1[0].repo, "owner/repoa", "repo persisted lowercased");
    assert_eq!(m1[0].status, GithubPullRequestStatus::Open);

    let m2 = &by_task["MON-2"];
    assert_eq!(m2.len(), 1);
    assert_eq!(m2[0].number, 21, "best-per-branch prefers the active PR over a newer closed one");
    assert_eq!(m2[0].status, GithubPullRequestStatus::Open);

    assert!(by_task["MON-3"].is_empty(), "no matching branch -> empty");
    assert!(!by_task.contains_key("MON-4"), "failed repo candidates are not recorded at all");
}

#[tokio::test]
async fn bulk_sync_no_candidates_and_no_unresolved_refs_is_noop() {
    let mut repos = FakeRepos::default();
    let github = RecentPrGithub::new(HashMap::new());
    let synced = bulk_sync_pull_requests(&mut repos, &github).await.unwrap();
    assert_eq!(synced, 0);
    assert!(repos.bulk_recorded().is_empty());
    assert!(repos.status_recorded().is_empty());
}

#[tokio::test]
async fn bulk_sync_refreshes_unresolved_refs_without_branch_candidates() {
    // All development work is settled (no branch candidates), but a tracked PR is still open in
    // the DB: the status pass must run anyway and fetch it by number.
    let mut repos = FakeRepos::default();
    repos.set_unresolved_pr_refs(vec![unresolved("MON-1", 7, "owner/repo", 12)]);
    let github = RecentPrGithub::new(HashMap::new()).with_pull_request(GithubPullRequest {
        repo: "owner/repo".to_string(),
        number: 12,
        url: "https://github.com/owner/repo/pull/12".to_string(),
        status: GithubPullRequestStatus::Merged,
    });

    let synced = bulk_sync_pull_requests(&mut repos, &github).await.unwrap();

    assert_eq!(synced, 1);
    assert_eq!(github.fetched_pull_requests(), vec![("owner/repo".to_string(), 12)]);
    let recorded = repos.status_recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0.external_ref_id, 7);
    assert_eq!(recorded[0].1.status, GithubPullRequestStatus::Merged);
}

#[tokio::test]
async fn bulk_sync_reuses_repo_listing_for_unresolved_refs() {
    // The unresolved PR appears in the repo's recent listing (under a branch that is no longer a
    // candidate), so its status is taken from memory without a by-number fetch.
    let mut repos = FakeRepos::default();
    repos.set_branch_sync_candidates(vec![candidate("MON-1", "owner/repo", "feature/current")]);
    repos.set_unresolved_pr_refs(vec![unresolved("MON-1", 7, "owner/repo", 12)]);
    let mut by_repo = HashMap::new();
    by_repo.insert(
        "owner/repo".to_string(),
        Some(vec![recent_pr(
            12,
            GithubPullRequestStatus::Merged,
            "feature/old",
            "2026-01-01T00:00:00Z",
        )]),
    );
    let github = RecentPrGithub::new(by_repo);

    let synced = bulk_sync_pull_requests(&mut repos, &github).await.unwrap();

    assert_eq!(synced, 1, "no branch match, one status refresh");
    assert!(github.fetched_pull_requests().is_empty(), "listing data is reused in memory");
    let recorded = repos.status_recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].1.status, GithubPullRequestStatus::Merged);
}

#[tokio::test]
async fn bulk_sync_counts_branch_matched_refs_once() {
    // The PR matched by the branch pass is also an unresolved ref of the same task; it must not
    // be re-fetched or double-counted. Another task tracking the same PR still gets its own state
    // row refreshed (the branch pass only writes the matched task's row).
    let mut repos = FakeRepos::default();
    repos.set_branch_sync_candidates(vec![candidate("MON-1", "owner/repo", "feature/x")]);
    repos.set_unresolved_pr_refs(vec![
        unresolved("MON-1", 7, "owner/repo", 10),
        unresolved("MON-2", 8, "owner/repo", 10),
    ]);
    let mut by_repo = HashMap::new();
    by_repo.insert(
        "owner/repo".to_string(),
        Some(vec![recent_pr(
            10,
            GithubPullRequestStatus::Open,
            "feature/x",
            "2026-01-01T00:00:00Z",
        )]),
    );
    let github = RecentPrGithub::new(by_repo);

    let synced = bulk_sync_pull_requests(&mut repos, &github).await.unwrap();

    assert_eq!(synced, 2, "one branch match plus MON-2's status refresh, not three");
    assert!(github.fetched_pull_requests().is_empty());
    let recorded = repos.status_recorded();
    assert_eq!(recorded.len(), 1, "MON-1's ref is covered by the branch pass");
    assert_eq!(recorded[0].0.task_id, "MON-2");
    assert_eq!(recorded[0].0.external_ref_id, 8);
}

#[tokio::test]
async fn bulk_sync_skips_unresolved_refs_of_failed_repos_and_tolerates_fetch_errors() {
    let mut repos = FakeRepos::default();
    repos.set_unresolved_pr_refs(vec![
        unresolved("MON-1", 7, "owner/failing", 12),
        unresolved("MON-2", 8, "owner/repo", 13),
        unresolved("MON-3", 9, "owner/repo", 14),
    ]);
    let mut by_repo = HashMap::new();
    by_repo.insert("owner/failing".to_string(), None);
    by_repo.insert("owner/repo".to_string(), Some(Vec::new()));
    // Only #13 is scripted; #14's fetch errors and must be skipped without failing the sync.
    let github = RecentPrGithub::new(by_repo).with_pull_request(GithubPullRequest {
        repo: "owner/repo".to_string(),
        number: 13,
        url: "https://github.com/owner/repo/pull/13".to_string(),
        status: GithubPullRequestStatus::Closed,
    });
    // The failing repo needs a branch candidate so its listing is fetched (and fails).
    repos.set_branch_sync_candidates(vec![
        candidate("MON-1", "owner/failing", "feature/a"),
        candidate("MON-2", "owner/repo", "feature/b"),
    ]);

    let synced = bulk_sync_pull_requests(&mut repos, &github).await.unwrap();

    assert_eq!(synced, 1, "only #13 was refreshed");
    let fetched = github.fetched_pull_requests();
    assert_eq!(fetched.len(), 2, "the failed repo's ref is never fetched by number");
    assert!(!fetched.iter().any(|(repo, _)| repo == "owner/failing"));
    let recorded = repos.status_recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0.external_ref_id, 8);
    assert_eq!(recorded[0].1.status, GithubPullRequestStatus::Closed);
}

#[tokio::test]
async fn bulk_sync_keeps_active_pr_when_a_worse_one_arrives_later() {
    // The selection must keep the active PR even when a newer *closed* PR for the same branch
    // follows it in the listing (exercises is_better_branch_pr returning false).
    let mut repos = FakeRepos::default();
    repos.set_branch_sync_candidates(vec![candidate("MON-1", "owner/repo", "feature/x")]);
    let mut by_repo = HashMap::new();
    by_repo.insert(
        "owner/repo".to_string(),
        Some(vec![
            recent_pr(50, GithubPullRequestStatus::Open, "feature/x", "2026-01-01T00:00:00Z"),
            recent_pr(51, GithubPullRequestStatus::Closed, "feature/x", "2026-05-01T00:00:00Z"),
        ]),
    );
    let github = RecentPrGithub::new(by_repo);

    let synced = bulk_sync_pull_requests(&mut repos, &github).await.unwrap();
    assert_eq!(synced, 1);

    let recorded = repos.bulk_recorded();
    let matched = &recorded
        .iter()
        .find(|(c, _)| c.task_id == "MON-1")
        .unwrap()
        .1;
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].number, 50, "the active PR is kept over a newer closed one");
    assert_eq!(matched[0].status, GithubPullRequestStatus::Open);
}

/// An epic (#42) and a sub-issue (#43), both tracked as tasks.
async fn tracked_epic_and_sub(repos: &mut FakeRepos) -> (TaskId, TaskId) {
    let epic = track_github_issue(repos, &FakeGithub, track_input()).await.unwrap();
    let sub = track_github_issue(
        repos,
        &FakeGithub,
        TrackGithubIssueInput { repo: "owner/repo".to_string(), number: 43 },
    )
    .await
    .unwrap();
    (epic.task.id, sub.task.id)
}

/// A gateway reporting #43 as a sub-issue of #42.
fn linked_hierarchy() -> RepoIssueGithub {
    RepoIssueGithub::new(HashMap::from([(
        "owner/repo".to_string(),
        Some(vec![open_issue(42, "epic"), sub_issue(43, "owner/repo", 42)]),
    )]))
}

#[tokio::test]
async fn bulk_sync_issues_links_a_sub_issue_to_its_parent_task() {
    let mut repos = FakeRepos::default();
    let (epic, sub) = tracked_epic_and_sub(&mut repos).await;

    bulk_sync_issues(&mut repos, &linked_hierarchy()).await.unwrap();

    assert_eq!(repos.get_task(&sub).unwrap().unwrap().parent_task_id, Some(epic.clone()));
    assert_eq!(
        repos.get_task(&epic).unwrap().unwrap().parent_task_id,
        None,
        "the epic has no parent of its own"
    );
}

#[tokio::test]
async fn bulk_sync_issues_unlinks_a_parent_github_dropped() {
    let mut repos = FakeRepos::default();
    let (_, sub) = tracked_epic_and_sub(&mut repos).await;
    bulk_sync_issues(&mut repos, &linked_hierarchy()).await.unwrap();

    let unlinked = RepoIssueGithub::new(HashMap::from([(
        "owner/repo".to_string(),
        Some(vec![open_issue(42, "epic"), open_issue(43, "sub issue")]),
    )]));
    bulk_sync_issues(&mut repos, &unlinked).await.unwrap();

    assert_eq!(repos.get_task(&sub).unwrap().unwrap().parent_task_id, None);
}
