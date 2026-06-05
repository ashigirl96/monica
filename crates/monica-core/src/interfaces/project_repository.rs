use anyhow::Result;

use crate::Project;

pub trait ProjectRepository {
    fn upsert_project(&self, project: &Project) -> Result<Project>;
    fn get_project(&self, id: &str) -> Result<Option<Project>>;
    fn list_projects(&self) -> Result<Vec<Project>>;
    fn set_project_field(&self, id: &str, key: &str, value: &str) -> Result<()>;
}
