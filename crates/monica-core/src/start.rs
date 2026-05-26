use crate::cmd;
use crate::manifest::{self, SessionManifest, Status};
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub struct StartOutcome {
    pub manifest: SessionManifest,
    pub manifest_path: PathBuf,
    pub prompt_path: PathBuf,
    pub prompt: String,
}

#[derive(Deserialize)]
struct Issue {
    title: String,
    body: String,
    url: String,
}

/// Turn `owner/repo#123` (or `#123` / `123` in the current repo) into a worktree,
/// branch, session manifest and a Claude Code prompt. See `docs/workflow-contract.md` §8.1.
pub fn start(target: &str) -> crate::Result<StartOutcome> {
    let (owner, repo, issue_number) = parse_target(target)?;
    let repo_full = format!("{owner}/{repo}");
    let id = SessionManifest::id_for(&owner, &repo, issue_number);

    if manifest::exists(&id)? {
        let existing = manifest::manifest_path(&id)?;
        return Err(format!("session {id} already exists ({})", existing.display()).into());
    }

    let issue = fetch_issue(&repo_full, issue_number)?;
    let repo_root = git_toplevel()?;

    let slug = slugify(&issue.title);
    let branch = format!("monica/{issue_number}-{slug}");
    let worktree_path = repo_root
        .join(".worktrees")
        .join(format!("{issue_number}-{slug}"));
    let worktree = worktree_path
        .to_str()
        .ok_or("worktree path is not valid UTF-8")?;

    let base = pick_base(&repo_root)?;
    cmd::run(
        "git",
        &["worktree", "add", "-b", &branch, worktree, &base],
        Some(&repo_root),
    )?;

    let now = now_iso8601()?;
    let manifest = SessionManifest {
        id,
        repo: repo_full.clone(),
        issue_number,
        issue_url: issue.url,
        status: Status::Running,
        branch: branch.clone(),
        worktree_path: worktree.to_string(),
        agent: "claude-code".to_string(),
        agent_session_id: None,
        pr_number: None,
        created_at: now.clone(),
        updated_at: now,
    };
    let manifest_path = manifest::save(&manifest)?;

    let prompt = build_prompt(
        &repo_full,
        issue_number,
        &issue.title,
        &issue.body,
        &branch,
        worktree,
    );
    let prompt_path = manifest::sessions_dir()?.join(format!("{}.prompt.md", manifest.id));
    std::fs::write(&prompt_path, &prompt)?;

    Ok(StartOutcome {
        manifest,
        manifest_path,
        prompt_path,
        prompt,
    })
}

fn parse_target(target: &str) -> crate::Result<(String, String, u64)> {
    let (repo_spec, num_str) = target.split_once('#').unwrap_or(("", target));
    let issue_number: u64 = num_str.trim().parse().map_err(|_| {
        format!("invalid issue number in {target:?} (expected owner/repo#123, #123 or 123)")
    })?;

    let (current_owner, current_repo) = current_repo()?;
    if repo_spec.is_empty() {
        return Ok((current_owner, current_repo, issue_number));
    }

    let (owner, repo) = repo_spec
        .split_once('/')
        .ok_or_else(|| format!("invalid repo {repo_spec:?} (expected owner/repo)"))?;
    if owner != current_owner || repo != current_repo {
        return Err(format!(
            "target repo {owner}/{repo} does not match the current repo {current_owner}/{current_repo}. \
             M0 では対象 repo の中で実行してください（repo registry は未対応）。"
        )
        .into());
    }
    Ok((owner.to_string(), repo.to_string(), issue_number))
}

fn current_repo() -> crate::Result<(String, String)> {
    let name = cmd::run(
        "gh",
        &[
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ],
        None,
    )?;
    let (owner, repo) = name
        .split_once('/')
        .ok_or_else(|| format!("unexpected repo identifier from gh: {name:?}"))?;
    Ok((owner.to_string(), repo.to_string()))
}

fn fetch_issue(repo_full: &str, issue_number: u64) -> crate::Result<Issue> {
    let json = cmd::run(
        "gh",
        &[
            "issue",
            "view",
            &issue_number.to_string(),
            "--repo",
            repo_full,
            "--json",
            "title,body,url",
        ],
        None,
    )
    .map_err(|e| format!("could not fetch {repo_full}#{issue_number}: {e}"))?;
    Ok(serde_json::from_str(&json)?)
}

fn git_toplevel() -> crate::Result<PathBuf> {
    Ok(PathBuf::from(cmd::run(
        "git",
        &["rev-parse", "--show-toplevel"],
        None,
    )?))
}

/// Prefer `origin/<default>`, then the local default branch, then `HEAD`.
fn pick_base(repo_root: &Path) -> crate::Result<String> {
    let default = cmd::run(
        "gh",
        &[
            "repo",
            "view",
            "--json",
            "defaultBranchRef",
            "-q",
            ".defaultBranchRef.name",
        ],
        None,
    )
    .unwrap_or_default();

    let mut candidates = Vec::new();
    if !default.is_empty() {
        candidates.push(format!("origin/{default}"));
        candidates.push(default);
    }
    candidates.push("HEAD".to_string());

    for candidate in candidates {
        if cmd::ok(
            "git",
            &["rev-parse", "--verify", "--quiet", &candidate],
            Some(repo_root),
        ) {
            return Ok(candidate);
        }
    }
    Err("could not resolve a base branch".into())
}

fn now_iso8601() -> crate::Result<String> {
    cmd::run("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"], None)
}

/// Lowercase ASCII alphanumerics, everything else collapses to `-`, trimmed and capped at 40 chars.
fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let capped: String = out.trim_matches('-').chars().take(40).collect();
    capped.trim_matches('-').to_string()
}

fn build_prompt(
    repo: &str,
    issue: u64,
    title: &str,
    body: &str,
    branch: &str,
    worktree: &str,
) -> String {
    format!(
        "You are implementing {repo}#{issue}: {title}\n\n\
         Worktree: {worktree}\n\
         Branch: {branch}\n\n\
         Implement the issue below. Stay strictly within scope — respect the \"Out of Scope\" \
         section and do not refactor unrelated code. Summarize the changed files before finishing.\n\n\
         --- ISSUE ---\n\n{body}\n"
    )
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn slugify_collapses_and_trims() {
        assert_eq!(slugify("Add search"), "add-search");
        assert_eq!(slugify("  --weird-- "), "weird");
        assert_eq!(
            slugify("[M0] Implement monica start <repo>#<issue>"),
            "m0-implement-monica-start-repo-issue"
        );
    }
}
