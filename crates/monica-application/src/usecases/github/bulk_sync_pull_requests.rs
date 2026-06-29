use std::collections::{HashMap, HashSet};
use std::time::Instant;

use super::ports::{GithubGateway, PullRequestSyncStore};
use crate::{
    ApplicationResult, GithubPullRequest, PullRequestBranchSyncCandidate, RepoPullRequest,
};

/// Forced PR refresh. Instead of draining one stale branch per request (the periodic path), fetch
/// every tracked repo's recent PRs once — in parallel — and match them to branches in memory, then
/// persist all matches in a single transaction. Returns the number of candidates that matched at
/// least one PR.
pub async fn bulk_sync_pull_requests<R, G>(repos: &mut R, github: &G) -> ApplicationResult<u32>
where
    R: PullRequestSyncStore,
    G: GithubGateway,
{
    let started = Instant::now();
    let candidates = repos.all_branch_sync_candidates()?;
    let candidates_ms = started.elapsed().as_millis();
    if candidates.is_empty() {
        return Ok(0);
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

    let mut by_repo: HashMap<String, HashMap<String, RepoPullRequest>> = HashMap::new();
    let mut failed_repos: HashSet<String> = HashSet::new();
    for (repo, (elapsed, result)) in distinct_repos.iter().zip(results) {
        let pull_requests = match result {
            Ok(pull_requests) => pull_requests,
            Err(e) => {
                log::warn!(
                    target: "monica_application::pr_sync",
                    "bulk PR fetch failed repo={repo} after {}ms error={e:#}",
                    elapsed.as_millis()
                );
                failed_repos.insert(repo.to_ascii_lowercase());
                continue;
            }
        };
        let fetched = pull_requests.len();
        let branch_map = by_repo.entry(repo.to_ascii_lowercase()).or_default();
        for pr in pull_requests {
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
            target: "monica_application::pr_sync",
            "bulk PR fetch repo={repo} fetched={fetched} branches={} in {}ms",
            branch_map.len(),
            elapsed.as_millis()
        );
    }

    let mut synced_count = 0u32;
    let mut entries: Vec<(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)> =
        Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let repo_key = candidate.repo.to_ascii_lowercase();
        // Skip candidates whose repo fetch failed — recording them as empty successful syncs
        // would hide a transient error and clear any previously-known PR state.
        if failed_repos.contains(&repo_key) {
            continue;
        }
        let branch_key = candidate.branch.trim().to_ascii_lowercase();
        let matched = by_repo
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
                synced_count += 1;
                vec![pr]
            }
            None => Vec::new(),
        };
        entries.push((candidate, pull_requests));
    }

    let record_started = Instant::now();
    repos.bulk_record_branch_sync_success(&entries)?;
    log::info!(
        target: "monica_application::pr_sync",
        "bulk PR sync done: candidates={} repos={} matched={} | candidates={}ms fetch={}ms record={}ms total={}ms",
        entries.len(),
        distinct_repos.len(),
        synced_count,
        candidates_ms,
        fetch_ms,
        record_started.elapsed().as_millis(),
        started.elapsed().as_millis()
    );
    Ok(synced_count)
}

/// The per-branch path keeps the single PR that best represents a branch: active over settled, then
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
