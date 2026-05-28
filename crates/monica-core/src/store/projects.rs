use anyhow::{anyhow, Context, Result};
use rusqlite::params;

use crate::db::Db;
use crate::model::{Agent, PermissionMode, Project, Provider};

use super::{PROJECT_COLUMNS, SET_NOW};

impl Db {
    pub fn upsert_project(&self, p: &Project) -> Result<Project> {
        self.conn().execute(
            "INSERT INTO projects
               (id, name, provider, repo, path, default_branch, worktree_root,
                setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               path = excluded.path,
               default_branch = CASE
                 WHEN projects.default_branch = 'main' AND excluded.default_branch != 'main'
                 THEN excluded.default_branch
                 ELSE projects.default_branch
               END,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![
                p.id,
                p.name,
                p.provider.as_str(),
                p.repo,
                p.path,
                p.default_branch,
                p.worktree_root,
                p.setup_timeout_sec,
                p.agent_default.as_str(),
                p.agent_permission_mode.as_str(),
                p.hooks_claude as i64,
            ],
        )?;
        self.get_project(&p.id)?
            .ok_or_else(|| anyhow!("project {} not found after upsert", p.id))
    }

    pub fn get_project(&self, id: &str) -> Result<Option<Project>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Project::from_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {PROJECT_COLUMNS} FROM projects ORDER BY id"
        ))?;
        let mut rows = stmt.query([])?;
        let mut projects = Vec::new();
        while let Some(row) = rows.next()? {
            projects.push(Project::from_row(row)?);
        }
        Ok(projects)
    }

    /// Update a single project field. `key` is matched against a whitelist; the column name fed to
    /// `format!` is therefore always a static literal from a match arm, and the user-supplied
    /// `value` is always bound as `?1` — so this cannot be an injection vector. Enum and numeric
    /// fields are validated/coerced before being written.
    pub fn set_project_field(&self, id: &str, key: &str, value: &str) -> Result<()> {
        let key = normalize_project_field_key(key);
        let text_value = |value: &str| -> Result<()> { self.update_project_column(id, key, value) };
        match key {
            "name" | "repo" | "default_branch" => text_value(value)?,
            "path" | "worktree_root" => {
                if value.is_empty() {
                    return Err(anyhow!("{key} cannot be set to an empty string"));
                }
                text_value(value)?;
            }
            "provider" => {
                let v: Provider = value.parse()?;
                self.update_project_column(id, "provider", v.as_str())?;
            }
            "agent_default" => {
                let v: Agent = value.parse()?;
                self.update_project_column(id, "agent_default", v.as_str())?;
            }
            "agent_permission_mode" => {
                let v: PermissionMode = value.parse()?;
                self.update_project_column(id, "agent_permission_mode", v.as_str())?;
            }
            "setup_timeout_sec" => {
                let n: i64 = value.parse().with_context(|| {
                    format!("setup_timeout_sec must be an integer, got {value:?}")
                })?;
                if n <= 0 {
                    return Err(anyhow!(
                        "setup_timeout_sec must be a positive integer, got {n}"
                    ));
                }
                self.update_project_column(id, "setup_timeout_sec", n)?;
            }
            "hooks_claude" => {
                let b = parse_bool(value)?;
                self.update_project_column(id, "hooks_claude", b as i64)?;
            }
            "id" => return Err(anyhow!("id is the project key and cannot be changed")),
            other => return Err(anyhow!("unknown project field: {other}")),
        }
        Ok(())
    }

    /// Run `UPDATE projects SET <column> = ?1 ...`. `column` must be a static literal supplied by
    /// [`Db::set_project_field`]; callers never pass user input here.
    fn update_project_column(
        &self,
        id: &str,
        column: &str,
        value: impl rusqlite::ToSql,
    ) -> Result<()> {
        let affected = self.conn().execute(
            &format!("UPDATE projects SET {column} = ?1, updated_at = {SET_NOW} WHERE id = ?2"),
            params![value, id],
        )?;
        if affected == 0 {
            return Err(anyhow!("project not found: {id}"));
        }
        Ok(())
    }
}

fn normalize_project_field_key(key: &str) -> &str {
    match key {
        "branch" => "default_branch",
        other => other,
    }
}

fn parse_bool(value: &str) -> Result<bool> {
    match value {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        other => Err(anyhow!(
            "expected a boolean (true/false/1/0), got {other:?}"
        )),
    }
}
