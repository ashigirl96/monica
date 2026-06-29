use std::collections::HashMap;

use super::*;
use super::support::*;
use crate::usecases::github::{bulk_sync_pull_requests, TrackGithubIssueInput};
use crate::{GithubPullRequest, GithubPullRequestStatus, RepoPullRequest};

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

    let refs = repos.list_external_refs(&report.task.id).unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].provider, Provider::Github);
    assert_eq!(refs[0].ref_type, RefType::Issue);
    assert_eq!(refs[0].number, Some(42));
}


#[tokio::test]
async fn sync_pull_requests_records_branch_gateway_result() {
    let mut repos = FakeRepos::default();
    repos.seed_pr_branch_candidate(PullRequestBranchSyncCandidate {
        task_id: "MON-1".to_string(),
        repo: "owner/repo".to_string(),
        branch: "issue-42".to_string(),
    });
    let result = sync_next_pull_request(&mut repos, &FakeGithub)
        .await
        .unwrap();
    assert_eq!(result.status, PullRequestSyncStatus::Synced);
    assert_eq!(repos.pr_branch_success_count(), 1);
}

#[test]
fn github_auth_status_uses_auth_gateway() {
    let status = github_auth_status(&FakeAuth);
    assert!(status.authenticated);
    assert_eq!(status.source, "fake");
}

#[tokio::test]
async fn github_auth_flow_usecases_delegate_to_auth_gateway() {
    let auth = FakeAuth;
    let flow = begin_github_device_flow(&auth).await.unwrap();
    assert_eq!(flow.user_code, "CODE");
    let status = wait_for_github_device_flow(&auth, &flow).await.unwrap();
    assert_eq!(status.login.as_deref(), Some("user"));
    logout_github(&auth).await.unwrap();
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
async fn bulk_sync_no_candidates_is_noop() {
    let mut repos = FakeRepos::default();
    let github = RecentPrGithub::new(HashMap::new());
    let synced = bulk_sync_pull_requests(&mut repos, &github).await.unwrap();
    assert_eq!(synced, 0);
    assert!(repos.bulk_recorded().is_empty());
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
