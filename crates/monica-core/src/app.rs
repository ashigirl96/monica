use std::path::Path;

use anyhow::{anyhow, Context, Result};

use crate::{
    parse_owner_repo, Db, ExternalRef, NewTask, Project, RefType, Task, TaskKind, TaskRun,
    TaskStatus,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubIssue {
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
}

pub fn register_project(db: &Db, repo_input: &str, path: &Path) -> Result<Project> {
    register_project_with_default_branch(db, repo_input, path, None)
}

pub fn register_project_with_default_branch(
    db: &Db,
    repo_input: &str,
    path: &Path,
    default_branch: Option<&str>,
) -> Result<Project> {
    let repo = parse_owner_repo(repo_input)?;
    let path = path.to_str().ok_or_else(|| {
        anyhow!(
            "current directory path is not valid UTF-8: {}",
            path.display()
        )
    })?;

    let mut project = Project::from_repo(repo);
    project.path = Some(path.to_string());
    if let Some(default_branch) = default_branch {
        project.default_branch = default_branch.to_string();
    }
    db.upsert_project(&project)
}

pub fn track_github_issue(db: &mut Db, repo_input: &str, issue: &GithubIssue) -> Result<Task> {
    let repo = parse_owner_repo(repo_input)?;
    let project_id = db.get_project(&repo)?.map(|p| p.id);

    let mut new = NewTask::new(TaskKind::Development, &issue.title);
    new.status = TaskStatus::Ready;
    new.body = issue.body.clone().unwrap_or_default();
    new.project_id = project_id;

    let external = ExternalRef::new(
        String::new(),
        RefType::GithubIssue,
        Some(repo),
        Some(issue.number),
        Some(issue.url.clone()),
    );
    db.insert_task_with_ref(new, external)
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeleteIssueReport {
    pub item: Task,
    pub removed_task_runs: Vec<String>,
    pub removed_branches: Vec<String>,
}

pub fn delete_issue(db: &mut Db, id: &str) -> Result<DeleteIssueReport> {
    let item = db
        .get_task(id)?
        .ok_or_else(|| anyhow!("task not found: {id}"))?;
    let runs = db.list_task_runs_for_task(id)?;
    let removed_branches = cleanup_runs(db, &item, &runs)?;
    let item = db.delete_task_cascade(id)?;
    Ok(DeleteIssueReport {
        item,
        removed_task_runs: runs.into_iter().map(|run| run.id).collect(),
        removed_branches,
    })
}

fn cleanup_runs(db: &Db, item: &Task, runs: &[TaskRun]) -> Result<Vec<String>> {
    if runs.is_empty() {
        return Ok(Vec::new());
    }

    let project_id = item.project_id.as_deref().ok_or_else(|| {
        anyhow!(
            "{} has run records but is not linked to a project; refusing to delete so run cleanup \
             metadata is preserved",
            item.id
        )
    })?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("project not found: {project_id}"))?;
    let repo_path = project.path.as_deref().ok_or_else(|| {
        anyhow!(
            "project {project_id} has no checkout path; refusing to delete {} so run cleanup \
             metadata is preserved",
            item.id
        )
    })?;
    let repo = Path::new(repo_path);
    let mut removed_branches = Vec::new();

    for run in runs {
        if let Some(worktree_path) = run.worktree_path.as_deref() {
            let worktree = Path::new(worktree_path);
            if worktree.exists() {
                git(repo, ["worktree", "remove"].as_slice(), Some(worktree)).with_context(
                    || {
                        format!(
                            "failed to remove worktree for {} at {}",
                            run.id,
                            worktree.display()
                        )
                    },
                )?;
            } else if worktree_registered(repo, worktree)? {
                git(
                    repo,
                    ["worktree", "remove", "--force"].as_slice(),
                    Some(worktree),
                )
                .with_context(|| {
                    format!(
                        "failed to remove stale worktree metadata for {} at {}",
                        run.id,
                        worktree.display()
                    )
                })?;
            }
        }
        if let Some(branch) = run.branch.as_deref() {
            if !removed_branches.iter().any(|b| b == branch) && branch_exists(repo, branch)? {
                git(repo, ["branch", "-D", branch].as_slice(), None)
                    .with_context(|| format!("failed to delete branch {branch} for {}", run.id))?;
                removed_branches.push(branch.to_string());
            }
        }
    }
    Ok(removed_branches)
}

fn branch_exists(repo: &Path, branch: &str) -> Result<bool> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .output()
        .context("failed to run git; install git or check the project path")?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(anyhow!(
            "git show-ref failed: {}",
            command_stderr(&output.stderr)
        )),
    }
}

fn worktree_registered(repo: &Path, worktree: &Path) -> Result<bool> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .context("failed to run git; install git or check the project path")?;
    if !output.status.success() {
        return Err(anyhow!(
            "git worktree list failed: {}",
            command_stderr(&output.stderr)
        ));
    }

    let path = worktree.display().to_string();
    let mut needles = vec![format!("worktree {path}")];
    if let Some(rest) = path.strip_prefix("/var/") {
        needles.push(format!("worktree /private/var/{rest}"));
    } else if let Some(rest) = path.strip_prefix("/private/var/") {
        needles.push(format!("worktree /var/{rest}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| needles.iter().any(|needle| line == needle)))
}

fn git(repo: &Path, args: &[&str], path_arg: Option<&Path>) -> Result<()> {
    let mut command = std::process::Command::new("git");
    command.arg("-C").arg(repo).args(args);
    if let Some(path) = path_arg {
        command.arg(path);
    }
    let output = command
        .output()
        .context("failed to run git; install git or check the project path")?;
    if !output.status.success() {
        return Err(anyhow!(
            "git {} failed: {}",
            args.join(" "),
            command_stderr(&output.stderr)
        ));
    }
    Ok(())
}

fn command_stderr(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        "no error output".to_string()
    } else {
        stderr.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gh_issue() -> GithubIssue {
        GithubIssue {
            number: 9,
            title: "tracked issue".to_string(),
            body: Some("issue body".to_string()),
            url: "https://github.com/ashigirl96/monica/issues/9".to_string(),
        }
    }

    #[test]
    fn register_project_normalizes_repo_and_sets_path() {
        let db = Db::open_in_memory().unwrap();
        let project = register_project(&db, "AshiGirl96/Monica", Path::new("/tmp/monica")).unwrap();
        assert_eq!(project.id, "ashigirl96/monica");
        assert_eq!(project.path.as_deref(), Some("/tmp/monica"));
    }

    #[test]
    fn register_project_can_take_detected_default_branch() {
        let db = Db::open_in_memory().unwrap();
        let project = register_project_with_default_branch(
            &db,
            "AshiGirl96/Monica",
            Path::new("/tmp/monica"),
            Some("master"),
        )
        .unwrap();
        assert_eq!(project.default_branch, "master");
    }

    #[test]
    fn track_without_project_creates_unlinked_task() {
        let mut db = Db::open_in_memory().unwrap();
        let item = track_github_issue(&mut db, "ashigirl96/monica", &gh_issue()).unwrap();

        assert_eq!(item.id, "MON-1");
        assert_eq!(item.kind, TaskKind::Development);
        assert_eq!(item.status, TaskStatus::Ready);
        assert_eq!(item.title, "tracked issue");
        assert_eq!(item.body, "issue body");
        assert_eq!(item.project_id, None);

        let refs = db.list_external_refs(&item.id).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].ref_type, RefType::GithubIssue);
        assert_eq!(refs[0].repo.as_deref(), Some("ashigirl96/monica"));
        assert_eq!(refs[0].number, Some(9));
        assert_eq!(
            refs[0].url.as_deref(),
            Some("https://github.com/ashigirl96/monica/issues/9")
        );
    }

    #[test]
    fn track_links_registered_project() {
        let mut db = Db::open_in_memory().unwrap();
        db.upsert_project(&Project::from_repo("ashigirl96/monica"))
            .unwrap();

        let item = track_github_issue(&mut db, "ashigirl96/monica", &gh_issue()).unwrap();
        assert_eq!(item.project_id.as_deref(), Some("ashigirl96/monica"));
    }

    #[test]
    fn track_empty_body_becomes_empty_string() {
        let mut db = Db::open_in_memory().unwrap();
        let mut issue = gh_issue();
        issue.body = None;
        let item = track_github_issue(&mut db, "ashigirl96/monica", &issue).unwrap();
        assert_eq!(item.body, "");
    }

    #[test]
    fn track_normalizes_repo_before_linking() {
        let mut db = Db::open_in_memory().unwrap();
        db.upsert_project(&Project::from_repo("ashigirl96/monica"))
            .unwrap();

        let item = track_github_issue(&mut db, "AshiGirl96/Monica", &gh_issue()).unwrap();
        assert_eq!(item.project_id.as_deref(), Some("ashigirl96/monica"));
    }
}
