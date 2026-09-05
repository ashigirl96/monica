use std::collections::HashMap;
use std::time::Instant;

use super::ports::{GithubGateway, GithubIssueSyncStore, PullRequestSyncStore};
use crate::{ApplicationResult, FetchedIssue, GithubPullRequest};

/// Forced issue refresh, the issue half of the GitHub sync. Fetches every repo's tracked issues in
/// one batched request each — all repos in parallel — and records the fresh title and state in a
/// single transaction. Only open tasks are covered: a closed task's issue needs no freshness.
///
/// The same fetch carries each issue's closing PRs, which the branch pass cannot see for a task
/// whose runs never took a branch (attach and in-place runs are deliberately branch-less), so they
/// are linked here. Returns the number of refs whose cache was refreshed plus the PRs linked.
pub async fn bulk_sync_issues<R, G>(repos: &mut R, github: &G) -> ApplicationResult<u32>
where
    R: GithubIssueSyncStore + PullRequestSyncStore,
    G: GithubGateway,
{
    let started = Instant::now();
    let refs = repos.all_open_task_issue_refs()?;
    if refs.is_empty() {
        return Ok(0);
    }

    // One request set per repo, with the numbers deduplicated: the same issue tracked by two
    // tasks is fetched once and written to both ref rows.
    let mut numbers_by_repo: HashMap<String, Vec<i64>> = HashMap::new();
    for issue_ref in &refs {
        let numbers = numbers_by_repo
            .entry(issue_ref.repo.to_ascii_lowercase())
            .or_default();
        if !numbers.contains(&issue_ref.number) {
            numbers.push(issue_ref.number);
        }
    }
    let repo_batches: Vec<(String, Vec<i64>)> = numbers_by_repo.into_iter().collect();

    let fetch_started = Instant::now();
    let fetches = repo_batches.iter().map(|(repo, numbers)| async move {
        let started = Instant::now();
        let result = github.fetch_issues(repo, numbers).await;
        (started.elapsed(), result)
    });
    let results = futures_util::future::join_all(fetches).await;
    let fetch_ms = fetch_started.elapsed().as_millis();

    let mut by_repo: HashMap<String, HashMap<i64, FetchedIssue>> = HashMap::new();
    for ((repo, _), (elapsed, result)) in repo_batches.iter().zip(results) {
        match result {
            Ok(issues) => {
                let fetched = issues.len();
                let map = by_repo.entry(repo.clone()).or_default();
                for issue in issues {
                    map.insert(issue.number, issue);
                }
                log::info!(
                    target: "monica_application::github_sync",
                    "bulk issue fetch repo={repo} fetched={fetched} in {}ms",
                    elapsed.as_millis()
                );
            }
            // A failed repo is left out of `by_repo`, so none of its refs produce an entry
            // below. Recording them as empty successes would blank every cached title in that
            // repo over a transient error.
            Err(e) => log::warn!(
                target: "monica_application::github_sync",
                "bulk issue fetch failed repo={repo} after {}ms error={e:#}",
                elapsed.as_millis()
            ),
        }
    }

    let mut entries: Vec<(i64, FetchedIssue)> = Vec::with_capacity(refs.len());
    let mut linked: Vec<(String, GithubPullRequest)> = Vec::new();
    for issue_ref in &refs {
        let repo_key = issue_ref.repo.to_ascii_lowercase();
        if let Some(issue) = by_repo
            .get(&repo_key)
            .and_then(|issues| issues.get(&issue_ref.number))
        {
            linked.extend(
                issue
                    .linked_pull_requests
                    .iter()
                    .map(|pull_request| (issue_ref.task_id.clone(), pull_request.clone())),
            );
            entries.push((issue_ref.external_ref_id, issue.clone()));
        }
    }

    let synced_count = (entries.len() + linked.len()) as u32;
    let record_started = Instant::now();
    repos.bulk_record_issue_sync(&entries)?;
    repos.record_linked_pull_requests(&linked)?;
    log::info!(
        target: "monica_application::github_sync",
        "bulk issue sync done: refs={} repos={} synced={} linked={} | fetch={fetch_ms}ms record={}ms total={}ms",
        refs.len(),
        repo_batches.len(),
        entries.len(),
        linked.len(),
        record_started.elapsed().as_millis(),
        started.elapsed().as_millis()
    );
    Ok(synced_count)
}
