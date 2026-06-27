use std::path::Path;

use super::{Backend, Monica};
use crate::ports::{GitGateway, ProjectRepository, Workspace};
use crate::usecases::github::ports::GithubGateway;
use crate::{ApplicationResult, ExecutionProfile, Project};

/// Outcome of `init_project`: the registered project plus the per-file scaffold result.
pub struct ProjectInit {
    pub project: Project,
    pub scaffold: Vec<(String, bool)>,
}

/// Project registration and project read/write.
pub struct ProjectService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
}

impl<B: Backend> ProjectService<'_, B> {
    /// Register the repo (detected from the git remote when `repo_arg` is absent), resolve its
    /// default branch (git, then GitHub), and scaffold `.monica/`.
    pub async fn init_project(
        &self,
        repo_arg: Option<String>,
        cwd: &Path,
    ) -> ApplicationResult<ProjectInit> {
        let repo = match repo_arg {
            Some(repo) => repo,
            None => self.m.git.detect_repo()?,
        };
        let default_branch = self.detect_default_branch(&repo).await;
        let project = crate::usecases::projects::register_project_with_default_branch(
            &self.m.repos,
            &repo,
            cwd,
            default_branch.as_deref(),
        )?;
        let scaffold = self.m.workspace.scaffold_monica(cwd)?;
        Ok(ProjectInit { project, scaffold })
    }

    async fn detect_default_branch(&self, repo: &str) -> Option<String> {
        if let Some(branch) = self.m.git.detect_default_branch(repo) {
            return Some(branch);
        }
        self.m.github.fetch_default_branch(repo).await.ok().flatten()
    }

    pub fn register_project(&self, repo_input: &str, path: &Path) -> ApplicationResult<Project> {
        crate::usecases::projects::register_project(&self.m.repos, repo_input, path)
    }

    pub fn register_project_with_default_branch(
        &self,
        repo_input: &str,
        path: &Path,
        default_branch: Option<&str>,
    ) -> ApplicationResult<Project> {
        crate::usecases::projects::register_project_with_default_branch(
            &self.m.repos,
            repo_input,
            path,
            default_branch,
        )
    }

    pub fn list_projects(&self) -> ApplicationResult<Vec<Project>> {
        crate::usecases::query::list_projects(&self.m.repos)
    }

    pub fn get_project(&self, repo: &str) -> ApplicationResult<Project> {
        crate::usecases::query::get_project(&self.m.repos, repo)
    }

    pub fn get_execution_profile(&self, repo: &str) -> ApplicationResult<ExecutionProfile> {
        let repo = crate::parse_owner_repo(repo)?;
        Ok(self.m.repos.get_execution_profile(&repo)?
            .unwrap_or_default())
    }

    pub fn set_project_field(&self, repo: &str, key: &str, value: &str) -> ApplicationResult<()> {
        crate::usecases::query::set_project_field(&self.m.repos, repo, key, value)
    }
}
