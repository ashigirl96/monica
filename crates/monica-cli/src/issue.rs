use std::collections::HashMap;
use std::process::Command;
use std::str::FromStr;

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_core::{
    parse_issue_ref, parse_owner_repo, track_github_issue, Agent, Db, GithubIssue, IssueStatusRow,
    SetupOutcome, Status,
};
use serde::Deserialize;

#[derive(Subcommand)]
pub enum IssueCommand {
    /// Track an existing GitHub issue (owner/repo#123) as a Monica work item
    Track {
        /// owner/repo#123
        target: String,
    },
    /// Show tracked work items and their latest run state
    Status {
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        project: Option<String>,
    },
    /// Create a worktree and run .monica/setup.sh for a work item (MON-<id>)
    Run {
        /// MON-<id>
        id: String,
        /// Launch Claude Code after setup (shorthand for --agent claude)
        #[arg(long, conflicts_with = "agent")]
        claude: bool,
        /// Launch a specific agent after setup (e.g. claude)
        #[arg(long, value_name = "AGENT")]
        agent: Option<String>,
    },
}

pub fn run(cmd: IssueCommand) -> Result<()> {
    let mut db = Db::open()?;
    match cmd {
        IssueCommand::Track { target } => track_command(&mut db, &target),
        IssueCommand::Status { status, project } => status_command(&db, status, project),
        IssueCommand::Run { id, claude, agent } => {
            run_command(&mut db, &id, claude, agent.as_deref())
        }
    }
}

/// `body` arrives as JSON `null` or an absent key for an empty issue, hence `Option` + default.
#[derive(Debug, Deserialize)]
struct GhIssue {
    number: i64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct GhPullRequest {
    number: i64,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    state: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

fn track_command(db: &mut Db, target: &str) -> Result<()> {
    let (repo, number) = parse_issue_ref(target)?;
    let issue = fetch_issue(&repo, number)?;
    let item = track_github_issue(db, &repo, &issue.to_core())?;
    println!("Created {} from {}#{}", item.id, repo, issue.number);
    println!("Status: {}", item.status.as_str());
    println!("Title: {}", item.title);
    Ok(())
}

fn status_command(db: &Db, status: Option<String>, project: Option<String>) -> Result<()> {
    let status = parse_status_filter(status.as_deref())?;
    let project = normalize_project_filter(project.as_deref())?;
    let rows = db.list_issue_statuses(status, project.as_deref())?;
    let pr_by_branch = fetch_pull_request_numbers(&rows)?;
    print!("{}", render_status_table(&rows, &pr_by_branch));
    Ok(())
}

fn run_command(db: &mut Db, id: &str, claude: bool, agent: Option<&str>) -> Result<()> {
    let agent = resolve_agent(claude, agent)?;
    let report = monica_core::run_issue(db, id, agent)?;
    println!("Run {} for {}", report.run_id, report.work_item_id);
    println!("Branch:   {}", report.branch);
    println!("Worktree: {}", report.worktree_path);
    println!("Setup:    {}", describe_setup(&report.setup));
    println!("Log:      {}", report.log_path);
    println!("Status:   {}", report.status.as_str());
    if let Some(path) = report.settings_path.as_deref() {
        println!("Settings: {path}");
    }
    if report.status == Status::Failed {
        anyhow::bail!("run {} failed; see {}", report.run_id, report.log_path);
    }
    // Hand the terminal to the agent. `launch_agent` is a no-op when no agent was requested, so
    // this call is unconditional. Spawn failure settles the run to failed inside core, so we just
    // propagate.
    monica_core::launch_agent(db, &report)
}

/// Map the two CLI flags (`--claude` shorthand and `--agent <name>`) to an `Option<Agent>`.
/// `conflicts_with` on the clap side guarantees they are never both set, so this only handles the
/// remaining three combinations.
fn resolve_agent(claude: bool, agent: Option<&str>) -> Result<Option<Agent>> {
    match (claude, agent) {
        (false, None) => Ok(None),
        (true, _) => Ok(Some(Agent::Claude)),
        (false, Some(name)) => Ok(Some(Agent::from_str(name)?)),
    }
}

fn describe_setup(outcome: &SetupOutcome) -> String {
    match outcome {
        SetupOutcome::Skipped => "skipped (no .monica/setup.sh)".to_string(),
        SetupOutcome::Succeeded => "ok".to_string(),
        SetupOutcome::Failed {
            timed_out: true, ..
        } => "failed (timed out)".to_string(),
        SetupOutcome::Failed {
            code: Some(code), ..
        } => format!("failed (exit {code})"),
        SetupOutcome::Failed { code: None, .. } => "failed".to_string(),
    }
}

fn fetch_issue(repo: &str, number: i64) -> Result<GhIssue> {
    let output = Command::new("gh")
        .args([
            "issue",
            "view",
            &number.to_string(),
            "--repo",
            repo,
            "--json",
            "number,title,body,url",
        ])
        .output()
        .context("failed to run gh; install the GitHub CLI (https://cli.github.com)")?;
    build_issue(
        number,
        output.status.success(),
        &output.stdout,
        &output.stderr,
    )
}

fn build_issue(requested: i64, success: bool, stdout: &[u8], stderr: &[u8]) -> Result<GhIssue> {
    if !success {
        let detail = String::from_utf8_lossy(stderr);
        let detail = detail.trim();
        let detail = if detail.is_empty() {
            "no error output"
        } else {
            detail
        };
        return Err(anyhow!(
            "gh issue view failed: {detail}; is `gh` authenticated? try `gh auth login`"
        ));
    }
    let issue: GhIssue =
        serde_json::from_slice(stdout).context("could not parse gh issue view JSON output")?;
    if issue.number != requested {
        return Err(anyhow!(
            "gh returned issue #{} but #{requested} was requested",
            issue.number
        ));
    }
    Ok(issue)
}

fn fetch_pull_request_numbers(
    rows: &[IssueStatusRow],
) -> Result<HashMap<(String, String), String>> {
    let mut by_repo: HashMap<&str, Vec<&str>> = HashMap::new();
    for row in rows {
        if let (Some(project), Some(branch)) = (row.project.as_deref(), row.branch.as_deref()) {
            by_repo.entry(project).or_default().push(branch);
        }
    }

    let mut out = HashMap::new();
    for repo in by_repo.into_keys() {
        let prs = fetch_pull_requests(repo)?;
        for (branch, pr_number) in select_pull_requests(prs) {
            out.insert((repo.to_string(), branch), pr_number);
        }
    }
    Ok(out)
}

fn fetch_pull_requests(repo: &str) -> Result<Vec<GhPullRequest>> {
    let output = Command::new("gh")
        .args([
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "all",
            "--limit",
            "1000",
            "--json",
            "number,headRefName,state,updatedAt",
        ])
        .output()
        .context("failed to run gh; install the GitHub CLI (https://cli.github.com)")?;
    build_pull_requests(
        repo,
        output.status.success(),
        &output.stdout,
        &output.stderr,
    )
}

fn build_pull_requests(
    repo: &str,
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<Vec<GhPullRequest>> {
    if !success {
        let detail = String::from_utf8_lossy(stderr);
        let detail = detail.trim();
        let detail = if detail.is_empty() {
            "no error output"
        } else {
            detail
        };
        return Err(anyhow!(
            "gh pr list failed for {repo}: {detail}; is `gh` authenticated? try `gh auth login`"
        ));
    }
    serde_json::from_slice(stdout).context("could not parse gh pr list JSON output")
}

fn select_pull_requests(prs: Vec<GhPullRequest>) -> HashMap<String, String> {
    let mut best_by_branch: HashMap<String, GhPullRequest> = HashMap::new();
    for pr in prs {
        match best_by_branch.get_mut(&pr.head_ref_name) {
            Some(current) => {
                if should_replace_pr(current, &pr) {
                    *current = pr;
                }
            }
            None => {
                best_by_branch.insert(pr.head_ref_name.clone(), pr);
            }
        }
    }
    best_by_branch
        .into_iter()
        .map(|(branch, pr)| (branch, format!("#{}", pr.number)))
        .collect()
}

fn should_replace_pr(current: &GhPullRequest, candidate: &GhPullRequest) -> bool {
    let current_open = current.state.eq_ignore_ascii_case("open");
    let candidate_open = candidate.state.eq_ignore_ascii_case("open");
    match (current_open, candidate_open) {
        (false, true) => true,
        (true, false) => false,
        _ => {
            candidate.updated_at > current.updated_at
                || (candidate.updated_at == current.updated_at && candidate.number > current.number)
        }
    }
}

fn parse_status_filter(status: Option<&str>) -> Result<Option<Status>> {
    status.map(Status::from_str).transpose()
}

fn normalize_project_filter(project: Option<&str>) -> Result<Option<String>> {
    project.map(parse_owner_repo).transpose()
}

fn render_status_table(
    rows: &[IssueStatusRow],
    pr_by_branch: &HashMap<(String, String), String>,
) -> String {
    if rows.is_empty() {
        return "No tracked issues found.\n".to_string();
    }

    let mut table = vec![vec![
        "ID".to_string(),
        "PROJECT".to_string(),
        "GH ISSUE".to_string(),
        "STATUS".to_string(),
        "BRANCH".to_string(),
        "PR".to_string(),
    ]];
    for row in rows {
        let pr = row
            .project
            .as_deref()
            .zip(row.branch.as_deref())
            .and_then(|(project, branch)| {
                pr_by_branch.get(&(project.to_string(), branch.to_string()))
            })
            .cloned()
            .unwrap_or_else(|| "-".to_string());
        table.push(vec![
            row.id.clone(),
            display_opt(row.project.as_deref()),
            row.github_issue_number
                .map(|n| format!("#{n}"))
                .unwrap_or_else(|| "-".to_string()),
            row.status.as_str().to_string(),
            display_opt(row.branch.as_deref()),
            pr,
        ]);
    }
    render_table(&table)
}

fn render_table(rows: &[Vec<String>]) -> String {
    let cols = rows.iter().map(|row| row.len()).max().unwrap_or(0);
    if cols == 0 {
        return String::new();
    }
    let mut widths = vec![0usize; cols];
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }

    let mut out = String::new();
    for row in rows {
        let line = row
            .iter()
            .enumerate()
            .map(|(i, cell)| format!("{cell:<width$}", width = widths[i]))
            .collect::<Vec<_>>()
            .join("  ");
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

fn display_opt(value: Option<&str>) -> String {
    value.unwrap_or("-").to_string()
}

impl GhIssue {
    fn to_core(&self) -> GithubIssue {
        GithubIssue {
            number: self.number,
            title: self.title.clone(),
            body: self.body.clone(),
            url: self.url.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_core::Status;

    #[test]
    fn build_issue_parses_valid_json() {
        let json = br#"{"number":9,"title":"hello","body":"world","url":"https://example.com/9"}"#;
        let issue = build_issue(9, true, json, b"").unwrap();
        assert_eq!(issue.number, 9);
        assert_eq!(issue.title, "hello");
        assert_eq!(issue.body.as_deref(), Some("world"));
        assert_eq!(issue.url, "https://example.com/9");
    }

    #[test]
    fn build_issue_tolerates_missing_and_null_body() {
        let missing = br#"{"number":1,"title":"t","url":"u"}"#;
        assert_eq!(build_issue(1, true, missing, b"").unwrap().body, None);
        let null = br#"{"number":1,"title":"t","body":null,"url":"u"}"#;
        assert_eq!(build_issue(1, true, null, b"").unwrap().body, None);
    }

    #[test]
    fn build_issue_surfaces_stderr_on_failure() {
        let err = build_issue(999, false, b"", b"gh: could not find issue #999");
        let msg = format!("{:#}", err.unwrap_err());
        assert!(msg.contains("gh: could not find issue #999"), "{msg}");
    }

    #[test]
    fn build_issue_rejects_bad_json() {
        assert!(build_issue(1, true, b"not json", b"").is_err());
    }

    #[test]
    fn build_issue_rejects_number_mismatch() {
        let json = br#"{"number":9,"title":"t","body":"b","url":"u"}"#;
        assert!(build_issue(5, true, json, b"").is_err());
    }

    #[test]
    fn build_pull_requests_parses_valid_json() {
        let json = br#"[{"number":95,"headRefName":"monica/gh-17","state":"OPEN","updatedAt":"2026-05-28T03:00:00Z"}]"#;
        let prs = build_pull_requests("ashigirl96/monica", true, json, b"").unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 95);
        assert_eq!(prs[0].head_ref_name, "monica/gh-17");
    }

    #[test]
    fn build_pull_requests_surfaces_stderr_on_failure() {
        let err = build_pull_requests("ashigirl96/monica", false, b"", b"gh auth failed");
        let msg = format!("{:#}", err.unwrap_err());
        assert!(msg.contains("gh auth failed"), "{msg}");
    }

    #[test]
    fn select_pull_requests_prefers_open_then_latest_update() {
        let map = select_pull_requests(vec![
            GhPullRequest {
                number: 12,
                head_ref_name: "monica/branch-a".to_string(),
                state: "CLOSED".to_string(),
                updated_at: "2026-05-28T01:00:00Z".to_string(),
            },
            GhPullRequest {
                number: 13,
                head_ref_name: "monica/branch-a".to_string(),
                state: "OPEN".to_string(),
                updated_at: "2026-05-28T00:00:00Z".to_string(),
            },
            GhPullRequest {
                number: 14,
                head_ref_name: "monica/branch-b".to_string(),
                state: "CLOSED".to_string(),
                updated_at: "2026-05-28T02:00:00Z".to_string(),
            },
            GhPullRequest {
                number: 15,
                head_ref_name: "monica/branch-b".to_string(),
                state: "MERGED".to_string(),
                updated_at: "2026-05-28T03:00:00Z".to_string(),
            },
        ]);

        assert_eq!(map.get("monica/branch-a").map(String::as_str), Some("#13"));
        assert_eq!(map.get("monica/branch-b").map(String::as_str), Some("#15"));
    }

    #[test]
    fn render_status_table_scopes_pr_lookup_by_repo_and_branch() {
        let rows = vec![
            IssueStatusRow {
                id: "MON-1".to_string(),
                project: Some("ashigirl96/monica".to_string()),
                github_issue_number: Some(17),
                status: Status::Ready,
                branch: Some("monica/gh-17".to_string()),
            },
            IssueStatusRow {
                id: "MON-2".to_string(),
                project: Some("ashigirl96/other".to_string()),
                github_issue_number: Some(18),
                status: Status::Ready,
                branch: Some("monica/gh-17".to_string()),
            },
        ];
        let mut pr_by_branch = HashMap::new();
        pr_by_branch.insert(
            ("ashigirl96/monica".to_string(), "monica/gh-17".to_string()),
            "#95".to_string(),
        );
        pr_by_branch.insert(
            ("ashigirl96/other".to_string(), "monica/gh-17".to_string()),
            "#96".to_string(),
        );

        let rendered = render_status_table(&rows, &pr_by_branch);
        assert!(rendered.lines().any(|line| line.contains("MON-1")
            && line.contains("ashigirl96/monica")
            && line.contains("#95")));
        assert!(rendered.lines().any(|line| line.contains("MON-2")
            && line.contains("ashigirl96/other")
            && line.contains("#96")));
    }

    #[test]
    fn describe_setup_covers_outcomes() {
        assert_eq!(
            describe_setup(&SetupOutcome::Skipped),
            "skipped (no .monica/setup.sh)"
        );
        assert_eq!(describe_setup(&SetupOutcome::Succeeded), "ok");
        assert_eq!(
            describe_setup(&SetupOutcome::Failed {
                code: Some(2),
                timed_out: false
            }),
            "failed (exit 2)"
        );
        assert_eq!(
            describe_setup(&SetupOutcome::Failed {
                code: None,
                timed_out: true
            }),
            "failed (timed out)"
        );
        assert_eq!(
            describe_setup(&SetupOutcome::Failed {
                code: None,
                timed_out: false
            }),
            "failed"
        );
    }

    #[test]
    fn parse_status_filter_validates_enum() {
        assert_eq!(
            parse_status_filter(Some("ready")).unwrap(),
            Some(Status::Ready)
        );
        assert!(parse_status_filter(Some("bogus")).is_err());
        assert_eq!(parse_status_filter(None).unwrap(), None);
    }

    #[test]
    fn normalize_project_filter_uses_owner_repo_parser() {
        assert_eq!(
            normalize_project_filter(Some("AshiGirl96/Monica")).unwrap(),
            Some("ashigirl96/monica".to_string())
        );
        assert!(normalize_project_filter(Some("bad")).is_err());
    }

    #[test]
    fn resolve_agent_maps_flags_to_optional_agent() {
        assert_eq!(resolve_agent(false, None).unwrap(), None);
        assert_eq!(resolve_agent(true, None).unwrap(), Some(Agent::Claude));
        assert_eq!(
            resolve_agent(false, Some("claude")).unwrap(),
            Some(Agent::Claude)
        );
        assert!(resolve_agent(false, Some("bogus")).is_err());
    }

    #[test]
    fn render_status_table_formats_rows_and_empty_state() {
        let rows = vec![IssueStatusRow {
            id: "MON-1".to_string(),
            project: Some("ashigirl96/monica".to_string()),
            github_issue_number: Some(17),
            status: Status::Ready,
            branch: Some("monica/gh-17".to_string()),
        }];
        let mut pr_by_branch = HashMap::new();
        pr_by_branch.insert(
            ("ashigirl96/monica".to_string(), "monica/gh-17".to_string()),
            "#95".to_string(),
        );

        let rendered = render_status_table(&rows, &pr_by_branch);
        assert!(rendered.contains("ID"));
        assert!(rendered.contains("ashigirl96/monica"));
        assert!(rendered.contains("#17"));
        assert!(rendered.contains("#95"));

        assert_eq!(
            render_status_table(&[], &HashMap::new()),
            "No tracked issues found.\n"
        );
    }
}
