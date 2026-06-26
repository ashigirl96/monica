use anyhow::{anyhow, Result};

use super::ports::ProjectRepository;
use crate::Project;

pub fn list_projects<R>(repos: &R) -> Result<Vec<Project>>
where
    R: ProjectRepository,
{
    repos.list_projects()
}

pub fn get_project<R>(repos: &R, repo: &str) -> Result<Project>
where
    R: ProjectRepository,
{
    repos
        .get_project(repo)?
        .ok_or_else(|| anyhow!("project not found: {repo}"))
}

pub fn set_project_field<R>(repos: &R, repo: &str, key: &str, value: &str) -> Result<()>
where
    R: ProjectRepository,
{
    repos.set_project_field(repo, key, value)
}
