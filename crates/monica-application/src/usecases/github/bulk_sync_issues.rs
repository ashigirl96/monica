use std::collections::HashMap;
use std::time::Instant;

use super::ports::{GithubGateway, GithubIssueSyncStore};
use crate::{
    ApplicationResult, FetchedIssue, GithubSyncScope, IssueSyncChange, OpenIssueRef,
    SyncPassOutcome,
};

/// Forced issue refresh, the issue half of the GitHub sync. Fetches every repo's tracked issues in
/// one batched request each — all repos in parallel — and records the fresh title and state in a
/// single transaction. Only open tasks are covered: a closed task's issue needs no freshness.
/// `scope` narrows the refs before any request goes out.
pub async fn bulk_sync_issues<R, G>(
    repos: &mut R,
    github: &G,
    scope: &GithubSyncScope,
) -> ApplicationResult<SyncPassOutcome<IssueSyncChange>>
where
    R: GithubIssueSyncStore,
    G: GithubGateway,
{
    let started = Instant::now();
    let refs: Vec<OpenIssueRef> = repos
        .all_open_task_issue_refs()?
        .into_iter()
        .filter(|issue_ref| scope.covers(&issue_ref.task_id))
        .collect();
    if refs.is_empty() {
        return Ok(SyncPassOutcome::default());
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
    let mut failed_repos: Vec<String> = Vec::new();
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
            Err(e) => {
                failed_repos.push(repo.clone());
                log::warn!(
                    target: "monica_application::github_sync",
                    "bulk issue fetch failed repo={repo} after {}ms error={e:#}",
                    elapsed.as_millis()
                );
            }
        }
    }

    let mut entries: Vec<(OpenIssueRef, FetchedIssue)> = Vec::with_capacity(refs.len());
    for issue_ref in &refs {
        let repo_key = issue_ref.repo.to_ascii_lowercase();
        if let Some(issue) = by_repo
            .get(&repo_key)
            .and_then(|issues| issues.get(&issue_ref.number))
        {
            entries.push((issue_ref.clone(), issue.clone()));
        }
    }

    let synced_count = entries.len() as u32;
    let record_started = Instant::now();
    let changes = repos.bulk_record_issue_sync(&entries)?;
    log::info!(
        target: "monica_application::github_sync",
        "bulk issue sync done: refs={} repos={} synced={synced_count} | fetch={fetch_ms}ms record={}ms total={}ms",
        refs.len(),
        repo_batches.len(),
        record_started.elapsed().as_millis(),
        started.elapsed().as_millis()
    );
    Ok(SyncPassOutcome {
        synced_count,
        changes,
        failed_repos,
    })
}
