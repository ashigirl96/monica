use std::path::Path;

use anyhow::{anyhow, Result};

use crate::{
    parse_owner_repo, Db, ExternalRef, NewWorkItem, Project, RefType, Status, WorkItem,
    WorkItemKind,
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

pub fn track_github_issue(db: &mut Db, repo_input: &str, issue: &GithubIssue) -> Result<WorkItem> {
    let repo = parse_owner_repo(repo_input)?;
    let project_id = db.get_project(&repo)?.map(|p| p.id);

    let mut new = NewWorkItem::new(WorkItemKind::Development, &issue.title);
    new.status = Status::Ready;
    new.body = issue.body.clone().unwrap_or_default();
    new.project_id = project_id;

    let external = ExternalRef::new(
        String::new(),
        RefType::GithubIssue,
        Some(repo),
        Some(issue.number),
        Some(issue.url.clone()),
    );
    db.insert_work_item_with_ref(new, external)
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
    fn track_without_project_creates_unlinked_work_item() {
        let mut db = Db::open_in_memory().unwrap();
        let item = track_github_issue(&mut db, "ashigirl96/monica", &gh_issue()).unwrap();

        assert_eq!(item.id, "MON-1");
        assert_eq!(item.kind, WorkItemKind::Development);
        assert_eq!(item.status, Status::Ready);
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
