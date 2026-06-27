use super::*;
use super::support::*;

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
