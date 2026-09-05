use std::collections::{HashMap, HashSet};
use std::time::Instant;

use super::ports::{GithubGateway, PullRequestSyncStore};
use crate::{
    ApplicationResult, GithubPullRequest, GithubSyncScope, PullRequestBranchSyncCandidate,
    PullRequestSyncChange, RepoPullRequest, UnresolvedPullRequestRef,
};

/// Forced PR refresh, the only sync path. Fetches every tracked repo's recent PRs once — in
/// parallel — and matches them to branch candidates in memory, then re-checks every unresolved
/// tracked PR the branch pass didn't cover (reusing the repo listings where possible, fetching by
/// number otherwise), and persists everything in a single transaction. `scope` narrows the
/// candidates and refs before any request goes out. Returns the number of branch candidates that
/// matched at least one PR plus the number of unresolved refs refreshed, along with the refs whose
/// status actually moved.
pub async fn bulk_sync_pull_requests<R, G>(
    repos: &mut R,
    github: &G,
    scope: &GithubSyncScope,
) -> ApplicationResult<(u32, Vec<PullRequestSyncChange>)>
where
    R: PullRequestSyncStore,
    G: GithubGateway,
{
    let started = Instant::now();
    let candidates: Vec<PullRequestBranchSyncCandidate> = repos
        .all_branch_sync_candidates()?
        .into_iter()
        .filter(|candidate| scope.covers(&candidate.task_id))
        .collect();
    let unresolved: Vec<UnresolvedPullRequestRef> = repos
        .all_unresolved_pull_request_refs()?
        .into_iter()
        .filter(|pr_ref| scope.covers(&pr_ref.task_id))
        .collect();
    let candidates_ms = started.elapsed().as_millis();
    if candidates.is_empty() && unresolved.is_empty() {
        return Ok((0, Vec::new()));
    }

    let mut seen = HashSet::new();
    let distinct_repos: Vec<String> = candidates
        .iter()
        .filter(|c| seen.insert(c.repo.to_ascii_lowercase()))
        .map(|c| c.repo.clone())
        .collect();

    // One request per repo, all in flight at once; `repos` is untouched here so the &mut for the
    // bulk write below does not overlap this borrow of `github`. Each fetch times itself so a slow
    // repo is visible in the logs.
    let fetch_started = Instant::now();
    let fetches = distinct_repos.iter().map(|repo| async move {
        let started = Instant::now();
        let result = github.fetch_recent_pull_requests(repo).await;
        (started.elapsed(), result)
    });
    let results = futures_util::future::join_all(fetches).await;
    let fetch_ms = fetch_started.elapsed().as_millis();

    let mut by_branch: HashMap<String, HashMap<String, RepoPullRequest>> = HashMap::new();
    let mut by_number: HashMap<String, HashMap<i64, RepoPullRequest>> = HashMap::new();
    let mut failed_repos: HashSet<String> = HashSet::new();
    for (repo, (elapsed, result)) in distinct_repos.iter().zip(results) {
        let pull_requests = match result {
            Ok(pull_requests) => pull_requests,
            Err(e) => {
                log::warn!(
                    target: "monica_application::github_sync",
                    "bulk PR fetch failed repo={repo} after {}ms error={e:#}",
                    elapsed.as_millis()
                );
                failed_repos.insert(repo.to_ascii_lowercase());
                continue;
            }
        };
        let fetched = pull_requests.len();
        let branch_map = by_branch.entry(repo.to_ascii_lowercase()).or_default();
        let number_map = by_number.entry(repo.to_ascii_lowercase()).or_default();
        for pr in pull_requests {
            number_map.insert(pr.number, pr.clone());
            let branch_key = pr.head_branch.trim().to_ascii_lowercase();
            if branch_key.is_empty() {
                continue;
            }
            let replace = match branch_map.get(&branch_key) {
                Some(existing) => is_better_branch_pr(&pr, existing),
                None => true,
            };
            if replace {
                branch_map.insert(branch_key, pr);
            }
        }
        log::info!(
            target: "monica_application::github_sync",
            "bulk PR fetch repo={repo} fetched={fetched} branches={} in {}ms",
            branch_map.len(),
            elapsed.as_millis()
        );
    }

    let mut branch_matched = 0u32;
    let mut matched_refs: HashSet<(String, String, i64)> = HashSet::new();
    let mut branch_entries: Vec<(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)> =
        Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let repo_key = candidate.repo.to_ascii_lowercase();
        // Skip candidates whose repo fetch failed — recording them as empty successful syncs
        // would hide a transient error and clear any previously-known PR state.
        if failed_repos.contains(&repo_key) {
            continue;
        }
        let branch_key = candidate.branch.trim().to_ascii_lowercase();
        let matched = by_branch
            .get(&repo_key)
            .and_then(|branches| branches.get(&branch_key))
            .map(|pr| GithubPullRequest {
                repo: repo_key.clone(),
                number: pr.number,
                url: pr.url.clone(),
                status: pr.status,
            });
        let pull_requests = match matched {
            Some(pr) => {
                branch_matched += 1;
                matched_refs.insert((candidate.task_id.clone(), repo_key, pr.number));
                vec![pr]
            }
            None => Vec::new(),
        };
        branch_entries.push((candidate, pull_requests));
    }

    // The branch pass only writes the matched task's own ref row, so exclusion must be per
    // (task, repo, number): the same PR tracked by another task still needs its status refreshed.
    let mut status_entries: Vec<(UnresolvedPullRequestRef, GithubPullRequest)> = Vec::new();
    let mut to_fetch: Vec<&UnresolvedPullRequestRef> = Vec::new();
    for unresolved_ref in &unresolved {
        let repo_key = unresolved_ref.repo.to_ascii_lowercase();
        if failed_repos.contains(&repo_key) {
            continue;
        }
        let ref_key = (
            unresolved_ref.task_id.clone(),
            repo_key.clone(),
            unresolved_ref.number,
        );
        if matched_refs.contains(&ref_key) {
            continue;
        }
        match by_number
            .get(&repo_key)
            .and_then(|numbers| numbers.get(&unresolved_ref.number))
        {
            Some(pr) => status_entries.push((
                unresolved_ref.clone(),
                GithubPullRequest {
                    repo: repo_key,
                    number: pr.number,
                    url: pr.url.clone(),
                    status: pr.status,
                },
            )),
            None => to_fetch.push(unresolved_ref),
        }
    }

    let status_fetch_started = Instant::now();
    let status_fetches = to_fetch.iter().map(|unresolved_ref| async move {
        let result = github
            .fetch_pull_request(&unresolved_ref.repo, unresolved_ref.number)
            .await;
        (*unresolved_ref, result)
    });
    for (unresolved_ref, result) in futures_util::future::join_all(status_fetches).await {
        match result {
            Ok(pr) => status_entries.push((unresolved_ref.clone(), pr)),
            // No retry state to record: the next forced sync simply tries again.
            Err(e) => log::warn!(
                target: "monica_application::github_sync",
                "status refresh fetch failed repo={} pull_request_number={} error={e:#}",
                unresolved_ref.repo,
                unresolved_ref.number
            ),
        }
    }
    let status_fetch_ms = status_fetch_started.elapsed().as_millis();

    let synced_count = branch_matched + status_entries.len() as u32;
    let record_started = Instant::now();
    let changes = repos.bulk_record_pr_sync(&branch_entries, &status_entries)?;
    log::info!(
        target: "monica_application::github_sync",
        "bulk PR sync done: candidates={} repos={} matched={} statuses={} | candidates={}ms fetch={}ms status_fetch={}ms record={}ms total={}ms",
        branch_entries.len(),
        distinct_repos.len(),
        branch_matched,
        status_entries.len(),
        candidates_ms,
        fetch_ms,
        status_fetch_ms,
        record_started.elapsed().as_millis(),
        started.elapsed().as_millis()
    );
    Ok((synced_count, changes))
}

/// The bulk pass keeps the single PR that best represents a branch: active over settled, then
/// most-recently-updated, then highest number. Mirror that when several PRs share a head branch.
fn is_better_branch_pr(candidate: &RepoPullRequest, current: &RepoPullRequest) -> bool {
    (
        candidate.status.branch_rank(),
        candidate.updated_at.as_str(),
        candidate.number,
    ) > (
        current.status.branch_rank(),
        current.updated_at.as_str(),
        current.number,
    )
}
