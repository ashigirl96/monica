use std::path::Path;

use anyhow::{anyhow, Result};

use crate::interfaces::ProjectRepository;
use crate::{parse_owner_repo, Project};

pub fn register_project<R>(repos: &R, repo_input: &str, path: &Path) -> Result<Project>
where
    R: ProjectRepository,
{
    register_project_with_default_branch(repos, repo_input, path, None)
}

pub fn register_project_with_default_branch<R>(
    repos: &R,
    repo_input: &str,
    path: &Path,
    default_branch: Option<&str>,
) -> Result<Project>
where
    R: ProjectRepository,
{
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
    repos.upsert_project(&project)
}
