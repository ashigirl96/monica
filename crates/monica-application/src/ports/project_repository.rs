use anyhow::Result;

use crate::prelude::Project;
use crate::ExecutionProfile;

pub trait ProjectRepository {
    fn upsert_project(&self, project: &Project, initial_profile: &ExecutionProfile) -> Result<Project>;
    fn get_project(&self, id: &str) -> Result<Option<Project>>;
    fn get_execution_profile(&self, id: &str) -> Result<Option<ExecutionProfile>>;
    fn list_projects(&self) -> Result<Vec<Project>>;
    fn set_project_field(&self, id: &str, key: &str, value: &str) -> Result<()>;
}
