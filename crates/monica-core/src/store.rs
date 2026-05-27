use anyhow::{anyhow, Context, Result};
use rusqlite::params;

use crate::db::Db;
use crate::model::{
    Agent, ExternalRef, NewWorkItem, PermissionMode, Project, Provider, Status, WorkItem,
};

const WORK_ITEM_COLUMNS: &str = "id, kind, status, phase, title, body, project_id, \
     labels, details_json, source_json, created_at, updated_at";

const PROJECT_COLUMNS: &str = "id, name, provider, repo, path, default_branch, worktree_root, \
     branch_template, setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude, \
     created_at, updated_at";

const SET_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

impl Db {
    pub fn insert_work_item(&mut self, new: NewWorkItem) -> Result<WorkItem> {
        let labels = serde_json::to_string(&new.labels)?;
        let details = serde_json::to_string(&new.details)?;
        let source = match &new.source {
            Some(v) => Some(serde_json::to_string(v)?),
            None => None,
        };

        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO mon_counter DEFAULT VALUES", [])?;
        let id = format!("MON-{}", tx.last_insert_rowid());
        tx.execute(
            "INSERT INTO work_items
               (id, kind, status, phase, title, body, project_id, labels, details_json, source_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                new.kind.as_str(),
                new.status.as_str(),
                new.phase,
                new.title,
                new.body,
                new.project_id,
                labels,
                details,
                source,
            ],
        )?;

        let item = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {WORK_ITEM_COLUMNS} FROM work_items WHERE id = ?1"
            ))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => WorkItem::from_row(row)?,
                None => return Err(anyhow!("inserted work item {id} not found")),
            }
        };
        tx.commit()?;
        Ok(item)
    }

    pub fn get_work_item(&self, id: &str) -> Result<Option<WorkItem>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {WORK_ITEM_COLUMNS} FROM work_items WHERE id = ?1"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(WorkItem::from_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_work_items(&self) -> Result<Vec<WorkItem>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {WORK_ITEM_COLUMNS} FROM work_items ORDER BY created_at, id"
        ))?;
        let mut rows = stmt.query([])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push(WorkItem::from_row(row)?);
        }
        Ok(items)
    }

    pub fn update_status(&self, id: &str, status: Status) -> Result<()> {
        let affected = self.conn().execute(
            "UPDATE work_items
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![status.as_str(), id],
        )?;
        if affected == 0 {
            return Err(anyhow!("work item not found: {id}"));
        }
        Ok(())
    }

    pub fn save_external_ref(&self, r: &ExternalRef) -> Result<i64> {
        self.conn().execute(
            "INSERT INTO external_refs (work_item_id, ref_type, repo, number, url)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![r.work_item_id, r.ref_type.as_str(), r.repo, r.number, r.url],
        )?;
        Ok(self.conn().last_insert_rowid())
    }

    pub fn list_external_refs(&self, work_item_id: &str) -> Result<Vec<ExternalRef>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, work_item_id, ref_type, repo, number, url, created_at
             FROM external_refs WHERE work_item_id = ?1 ORDER BY id",
        )?;
        let mut rows = stmt.query(params![work_item_id])?;
        let mut refs = Vec::new();
        while let Some(row) = rows.next()? {
            refs.push(ExternalRef::from_row(row)?);
        }
        Ok(refs)
    }

    /// Insert a project, or update an existing one keyed by `id`. On conflict only `path` is
    /// refreshed (so re-running `init` tracks the current checkout) plus `updated_at`; every other
    /// field is preserved, including ones tweaked via [`Db::set_project_field`] such as `name`,
    /// timeout, branch template, worktree root, or agent.
    pub fn upsert_project(&self, p: &Project) -> Result<Project> {
        self.conn().execute(
            "INSERT INTO projects
               (id, name, provider, repo, path, default_branch, worktree_root, branch_template,
                setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
               path = excluded.path,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![
                p.id,
                p.name,
                p.provider.as_str(),
                p.repo,
                p.path,
                p.default_branch,
                p.worktree_root,
                p.branch_template,
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
        let mut stmt = self
            .conn()
            .prepare(&format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1"))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Project::from_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let mut stmt = self
            .conn()
            .prepare(&format!("SELECT {PROJECT_COLUMNS} FROM projects ORDER BY id"))?;
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
        let text_value = |value: &str| -> Result<()> {
            self.update_project_column(id, key, value)
        };
        match key {
            "name" | "repo" | "default_branch" | "branch_template" => text_value(value)?,
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
                let n: i64 = value
                    .parse()
                    .with_context(|| format!("setup_timeout_sec must be an integer, got {value:?}"))?;
                if n <= 0 {
                    return Err(anyhow!("setup_timeout_sec must be a positive integer, got {n}"));
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

fn parse_bool(value: &str) -> Result<bool> {
    match value {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        other => Err(anyhow!("expected a boolean (true/false/1/0), got {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{RefType, WorkItemKind};
    use serde_json::json;

    fn sample_project() -> Project {
        Project::from_repo("ashigirl96/monica")
    }

    fn dev_item(title: &str) -> NewWorkItem {
        NewWorkItem::new(WorkItemKind::Development, title)
    }

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::migrate(&mut conn).unwrap();
        crate::migrations::migrate(&mut conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2);

        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table'
                 AND name IN ('mon_counter','work_items','runs','events','external_refs','projects')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 6);
    }

    #[test]
    fn work_item_round_trip() {
        let mut db = Db::open_in_memory().unwrap();

        let mut new = dev_item("first task");
        new.status = Status::Ready;
        new.body = "do the thing".to_string();
        new.project_id = Some("ashigirl96/monica".to_string());
        new.labels = vec!["m0".to_string(), "core".to_string()];
        new.details = json!({ "priority": "high" });
        new.source = Some(json!({ "via": "manual" }));

        let created = db.insert_work_item(new).unwrap();
        assert_eq!(created.id, "MON-1");
        assert_eq!(created.status, Status::Ready);

        let fetched = db.get_work_item("MON-1").unwrap().unwrap();
        assert_eq!(fetched, created);
        assert_eq!(fetched.labels, vec!["m0".to_string(), "core".to_string()]);
        assert_eq!(fetched.details, json!({ "priority": "high" }));
        assert_eq!(fetched.source, Some(json!({ "via": "manual" })));

        let listed = db.list_work_items().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], created);

        std::thread::sleep(std::time::Duration::from_millis(5));
        db.update_status("MON-1", Status::Running).unwrap();
        let updated = db.get_work_item("MON-1").unwrap().unwrap();
        assert_eq!(updated.status, Status::Running);
        assert!(updated.updated_at > created.updated_at);
        assert_eq!(updated.created_at, created.created_at);
    }

    #[test]
    fn update_status_unknown_id_errors() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.update_status("MON-999", Status::Done).is_err());
    }

    #[test]
    fn get_missing_work_item_is_none() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.get_work_item("MON-1").unwrap().is_none());
    }

    #[test]
    fn mon_ids_increase_monotonically() {
        let mut db = Db::open_in_memory().unwrap();
        let a = db.insert_work_item(dev_item("a")).unwrap();
        let b = db.insert_work_item(dev_item("b")).unwrap();
        let c = db.insert_work_item(dev_item("c")).unwrap();
        assert_eq!((a.id.as_str(), b.id.as_str(), c.id.as_str()), ("MON-1", "MON-2", "MON-3"));
    }

    #[test]
    fn mon_ids_are_not_reused_after_deletion() {
        let mut db = Db::open_in_memory().unwrap();
        db.insert_work_item(dev_item("a")).unwrap();
        db.insert_work_item(dev_item("b")).unwrap();
        db.conn()
            .execute("DELETE FROM work_items WHERE id = 'MON-2'", [])
            .unwrap();

        let next = db.insert_work_item(dev_item("c")).unwrap();
        assert_eq!(next.id, "MON-3");
    }

    #[test]
    fn external_ref_round_trip() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db.insert_work_item(dev_item("tracked")).unwrap();

        let r = ExternalRef::new(
            item.id.clone(),
            RefType::GithubIssue,
            Some("ashigirl96/monica".to_string()),
            Some(9),
            Some("https://github.com/ashigirl96/monica/issues/9".to_string()),
        );
        let row_id = db.save_external_ref(&r).unwrap();
        assert!(row_id > 0);

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
    fn project_round_trip() {
        let db = Db::open_in_memory().unwrap();

        let mut p = sample_project();
        p.path = Some("/Users/dev/monica".to_string());

        let created = db.upsert_project(&p).unwrap();
        assert_eq!(created.id, "ashigirl96/monica");
        assert_eq!(created.name, "monica");
        assert_eq!(created.provider, Provider::Github);
        assert_eq!(created.agent_default, Agent::Claude);
        assert_eq!(created.agent_permission_mode, PermissionMode::Plan);
        assert_eq!(created.setup_timeout_sec, 600);
        assert!(created.hooks_claude);
        assert_eq!(created.path.as_deref(), Some("/Users/dev/monica"));
        assert!(!created.created_at.is_empty(), "created_at should be filled by the DB default");
        assert!(!created.updated_at.is_empty(), "updated_at should be filled by the DB default");

        let fetched = db.get_project("ashigirl96/monica").unwrap().unwrap();
        assert_eq!(fetched, created);

        let listed = db.list_projects().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], created);
    }

    #[test]
    fn list_projects_empty_is_ok() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.list_projects().unwrap().is_empty());
        assert!(db.get_project("nobody/nothing").unwrap().is_none());
    }

    #[test]
    fn set_project_field_coerces_and_validates() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_project(&sample_project()).unwrap();
        let id = "ashigirl96/monica";

        db.set_project_field(id, "branch_template", "monica/{slug}").unwrap();
        db.set_project_field(id, "agent_permission_mode", "acceptEdits").unwrap();
        db.set_project_field(id, "setup_timeout_sec", "900").unwrap();
        db.set_project_field(id, "hooks_claude", "false").unwrap();
        db.set_project_field(id, "worktree_root", "/Users/dev/.worktrees/monica").unwrap();

        let p = db.get_project(id).unwrap().unwrap();
        assert_eq!(p.branch_template, "monica/{slug}");
        assert_eq!(p.agent_permission_mode, PermissionMode::AcceptEdits);
        assert_eq!(p.setup_timeout_sec, 900);
        assert!(!p.hooks_claude);
        assert_eq!(p.worktree_root.as_deref(), Some("/Users/dev/.worktrees/monica"));

        assert!(db.set_project_field(id, "agent_permission_mode", "bogus").is_err());
        assert!(db.set_project_field(id, "setup_timeout_sec", "abc").is_err());
        assert!(db.set_project_field(id, "setup_timeout_sec", "-5").is_err());
        assert!(db.set_project_field(id, "setup_timeout_sec", "0").is_err());
        assert!(db.set_project_field(id, "hooks_claude", "maybe").is_err());
        assert!(db.set_project_field(id, "path", "").is_err());
        assert!(db.set_project_field(id, "worktree_root", "").is_err());
        assert!(db.set_project_field(id, "id", "other/repo").is_err());
        assert!(db.set_project_field(id, "nonexistent", "x").is_err());
        assert!(db.set_project_field("missing/repo", "name", "x").is_err());
    }

    #[test]
    fn reinit_preserves_tweaked_config_and_tracks_path() {
        let db = Db::open_in_memory().unwrap();
        let mut p = sample_project();
        p.path = Some("/Users/dev/monica".to_string());
        db.upsert_project(&p).unwrap();

        db.set_project_field("ashigirl96/monica", "name", "Custom").unwrap();
        db.set_project_field("ashigirl96/monica", "setup_timeout_sec", "900").unwrap();
        db.set_project_field("ashigirl96/monica", "branch_template", "monica/{slug}").unwrap();

        let mut reinit = Project::from_repo("ashigirl96/monica");
        reinit.path = Some("/Users/dev/monica-moved".to_string());
        let after = db.upsert_project(&reinit).unwrap();

        assert_eq!(after.name, "Custom", "set value must survive re-init");
        assert_eq!(after.setup_timeout_sec, 900, "set value must survive re-init");
        assert_eq!(after.branch_template, "monica/{slug}", "set value must survive re-init");
        assert_eq!(after.path.as_deref(), Some("/Users/dev/monica-moved"), "path tracks the new checkout");
    }

    #[test]
    fn permission_mode_as_str_matches_serde() {
        for mode in [
            PermissionMode::Default,
            PermissionMode::Plan,
            PermissionMode::AcceptEdits,
            PermissionMode::BypassPermissions,
        ] {
            assert_eq!(mode.as_str().parse::<PermissionMode>().unwrap(), mode);
            let json = serde_json::to_string(&mode).unwrap();
            assert_eq!(json, format!("\"{}\"", mode.as_str()));
        }
        assert!("dontAsk".parse::<PermissionMode>().is_err());
    }

    #[test]
    fn from_repo_derives_name_from_last_segment() {
        assert_eq!(Project::from_repo("ashigirl96/monica").name, "monica");
        // A trailing slash must not produce an empty name.
        assert_eq!(Project::from_repo("ashigirl96/monica/").name, "monica");
    }

    #[test]
    fn provider_and_agent_round_trip() {
        assert_eq!(Provider::Github.as_str().parse::<Provider>().unwrap(), Provider::Github);
        assert!("gitlab".parse::<Provider>().is_err());
        assert_eq!(Agent::Claude.as_str().parse::<Agent>().unwrap(), Agent::Claude);
        assert!("codex".parse::<Agent>().is_err());
    }

    #[test]
    fn status_string_conversion_round_trips() {
        let all = [
            Status::Inbox,
            Status::Ready,
            Status::SettingUp,
            Status::Running,
            Status::NeedApproval,
            Status::Stopped,
            Status::Failed,
            Status::PrOpen,
            Status::Done,
            Status::Archived,
        ];
        for s in all {
            assert_eq!(s.as_str().parse::<Status>().unwrap(), s);
        }
        assert!("bogus".parse::<Status>().is_err());
        assert_eq!(WorkItemKind::Development.as_str().parse::<WorkItemKind>().unwrap(), WorkItemKind::Development);
        assert!("nope".parse::<WorkItemKind>().is_err());
        assert_eq!(RefType::GithubIssue.as_str().parse::<RefType>().unwrap(), RefType::GithubIssue);
        assert!("nope".parse::<RefType>().is_err());
    }

    #[test]
    fn db_path_respects_monica_home() {
        std::env::remove_var("MONICA_HOME");
        std::env::set_var("HOME", "/tmp/monica-home-test");
        assert_eq!(
            crate::paths::db_path().unwrap(),
            std::path::Path::new("/tmp/monica-home-test/monica/db/monica.db")
        );

        std::env::set_var("MONICA_HOME", "/tmp/monica-override");
        assert_eq!(
            crate::paths::db_path().unwrap(),
            std::path::Path::new("/tmp/monica-override/db/monica.db")
        );
        std::env::remove_var("MONICA_HOME");
    }
}
