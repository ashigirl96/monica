use anyhow::{anyhow, Context, Result};
use rusqlite::params;
use serde_json::Value;

use crate::db::Db;
use crate::model::{
    Agent, Event, ExternalRef, IssueStatusRow, NewRun, NewWorkItem, PermissionMode, Project,
    Provider, RefType, Run, Status, WorkItem,
};

const WORK_ITEM_COLUMNS: &str = "id, kind, status, phase, title, body, project_id, \
     labels, details_json, source_json, created_at, updated_at";

const RUN_COLUMNS: &str = "id, work_item_id, agent, branch, worktree_path, status, \
     settings_path, created_at, updated_at";

const PROJECT_COLUMNS: &str = "id, name, provider, repo, path, default_branch, worktree_root, \
     setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude, \
     created_at, updated_at";

const EVENT_COLUMNS: &str = "id, work_item_id, run_id, kind, payload_json, created_at";

const SET_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

impl Db {
    pub fn insert_work_item(&mut self, new: NewWorkItem) -> Result<WorkItem> {
        self.insert_work_item_inner(new, None)
    }

    /// Insert a work item and its external ref in one transaction, so a failure to record the
    /// external link can never leave an orphan work item behind. The ref's `work_item_id` is
    /// replaced with the freshly allocated `MON-<n>` id.
    pub fn insert_work_item_with_ref(
        &mut self,
        new: NewWorkItem,
        external: ExternalRef,
    ) -> Result<WorkItem> {
        self.insert_work_item_inner(new, Some(external))
    }

    fn insert_work_item_inner(
        &mut self,
        new: NewWorkItem,
        external: Option<ExternalRef>,
    ) -> Result<WorkItem> {
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

        if let Some(external) = external {
            tx.execute(
                "INSERT INTO external_refs (work_item_id, ref_type, repo, number, url)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    external.ref_type.as_str(),
                    external.repo,
                    external.number,
                    external.url
                ],
            )?;
        }

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

    pub fn list_issue_statuses(
        &self,
        status: Option<Status>,
        project: Option<&str>,
    ) -> Result<Vec<IssueStatusRow>> {
        let status = status.map(Status::as_str);
        let mut stmt = self.conn().prepare(
            "SELECT
               wi.id AS work_item_id,
               coalesce(project.repo, issue_ref.repo, wi.project_id) AS project,
               issue_ref.number AS github_issue_number,
               wi.status AS work_item_status,
               latest_run.branch AS branch
             FROM work_items wi
             LEFT JOIN projects project
               ON project.id = wi.project_id
             LEFT JOIN external_refs issue_ref
               ON issue_ref.id = (
                 SELECT er.id
                 FROM external_refs er
                 WHERE er.work_item_id = wi.id AND er.ref_type = 'github_issue'
                 ORDER BY er.id DESC
                 LIMIT 1
               )
            LEFT JOIN runs latest_run
               ON latest_run.id = (
                 SELECT r.id
                 FROM runs r
                 WHERE r.work_item_id = wi.id
                 ORDER BY r.created_at DESC,
                          CAST(SUBSTR(r.id, 5) AS INTEGER) DESC
                 LIMIT 1
               )
             WHERE (?1 IS NULL OR wi.status = ?1)
               AND (?2 IS NULL OR coalesce(project.repo, issue_ref.repo, wi.project_id) = ?2)
             ORDER BY wi.created_at, wi.id",
        )?;
        let mut rows = stmt.query(params![status, project])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            let status: String = row.get("work_item_status")?;
            items.push(IssueStatusRow {
                id: row.get("work_item_id")?,
                project: row.get("project")?,
                github_issue_number: row.get("github_issue_number")?,
                status: status.parse()?,
                branch: row.get("branch")?,
            });
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

    /// Record an event row. The `events` schema foreign-keys both `work_item_id` and `run_id`, so
    /// callers must pass only ids they have verified to exist (and `None` otherwise) — the columns
    /// stay NULL rather than violating the constraint. Returns the inserted [`Event`] with its
    /// DB-assigned id and timestamp.
    pub fn insert_event(
        &self,
        work_item_id: Option<&str>,
        run_id: Option<&str>,
        kind: &str,
        payload: &Value,
    ) -> Result<Event> {
        let payload = serde_json::to_string(payload)?;
        self.conn().execute(
            "INSERT INTO events (work_item_id, run_id, kind, payload_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![work_item_id, run_id, kind, payload],
        )?;
        let id = self.conn().last_insert_rowid();
        let mut stmt = self
            .conn()
            .prepare(&format!("SELECT {EVENT_COLUMNS} FROM events WHERE id = ?1"))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Event::from_row(row),
            None => Err(anyhow!("inserted event {id} not found")),
        }
    }

    /// List events, optionally filtered to one work item. Ordered by insertion (`id`).
    pub fn list_events(&self, work_item_id: Option<&str>) -> Result<Vec<Event>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {EVENT_COLUMNS} FROM events
             WHERE (?1 IS NULL OR work_item_id = ?1)
             ORDER BY id"
        ))?;
        let mut rows = stmt.query(params![work_item_id])?;
        let mut events = Vec::new();
        while let Some(row) = rows.next()? {
            events.push(Event::from_row(row)?);
        }
        Ok(events)
    }

    /// Apply a hook-driven status to a work item, and — when `run_id` is given — to its run, in one
    /// transaction. The run update is additionally scoped by `work_item_id`, so a run that does not
    /// belong to this work item (e.g. a mismatched env var) is never touched even if the id exists.
    pub fn apply_hook_status(
        &mut self,
        work_item_id: &str,
        run_id: Option<&str>,
        status: Status,
    ) -> Result<()> {
        let status = status.as_str();
        let tx = self.conn_mut().transaction()?;
        let affected = tx.execute(
            &format!("UPDATE work_items SET status = ?1, updated_at = {SET_NOW} WHERE id = ?2"),
            params![status, work_item_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("work item not found: {work_item_id}"));
        }
        if let Some(run_id) = run_id {
            tx.execute(
                &format!(
                    "UPDATE runs SET status = ?1, updated_at = {SET_NOW} \
                     WHERE id = ?2 AND work_item_id = ?3"
                ),
                params![status, run_id, work_item_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Set a work item's status, overwrite its phase with `note` when given (otherwise keep it),
    /// record a PR reference when `pr_url` is given, and log a `mark` event — all in one
    /// transaction so the four effects can never partially land.
    pub fn mark_work_item(
        &mut self,
        id: &str,
        status: Status,
        note: Option<&str>,
        pr_url: Option<&str>,
    ) -> Result<()> {
        let status_str = status.as_str();
        let pr_number = pr_url.and_then(parse_pr_number);
        let payload = serde_json::to_string(&serde_json::json!({
            "status": status_str,
            "note": note,
            "pr_url": pr_url,
        }))?;

        let tx = self.conn_mut().transaction()?;
        let affected = tx.execute(
            &format!(
                "UPDATE work_items
                   SET status = ?1, phase = COALESCE(?2, phase), updated_at = {SET_NOW}
                 WHERE id = ?3"
            ),
            params![status_str, note, id],
        )?;
        if affected == 0 {
            return Err(anyhow!("work item not found: {id}"));
        }
        if let Some(pr_url) = pr_url {
            tx.execute(
                "INSERT INTO external_refs (work_item_id, ref_type, repo, number, url)
                 VALUES (?1, ?2, NULL, ?3, ?4)",
                params![id, RefType::GithubPullRequest.as_str(), pr_number, pr_url],
            )?;
        }
        tx.execute(
            "INSERT INTO events (work_item_id, kind, payload_json) VALUES (?1, 'mark', ?2)",
            params![id, payload],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Current UTC timestamp in the same ISO-8601 form the schema's column defaults use. Lets
    /// non-DB artifacts (e.g. `hook-events.jsonl`) share one timestamp format without pulling in a
    /// date/time crate.
    pub(crate) fn now_iso(&self) -> Result<String> {
        let ts: String = self
            .conn()
            .query_row(&format!("SELECT {SET_NOW}"), [], |r| r.get(0))?;
        Ok(ts)
    }

    /// Begin a run attempt: allocate a `run-<n>` id, insert the run at [`Status::SettingUp`], and
    /// move its work item to `setting_up` — all in one transaction, so `issue status` never sees a
    /// run whose work item disagrees with it.
    pub fn start_run(&mut self, new: NewRun) -> Result<Run> {
        let agent = new.agent.map(|a| a.as_str());
        let setting_up = Status::SettingUp.as_str();

        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO run_counter DEFAULT VALUES", [])?;
        let id = format!("run-{}", tx.last_insert_rowid());
        tx.execute(
            "INSERT INTO runs (id, work_item_id, agent, branch, worktree_path, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                new.work_item_id,
                agent,
                new.branch,
                new.worktree_path,
                setting_up,
            ],
        )?;
        let affected = tx.execute(
            "UPDATE work_items
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![setting_up, new.work_item_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("work item not found: {}", new.work_item_id));
        }

        let run = {
            let mut stmt = tx.prepare(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => Run::from_row(row)?,
                None => return Err(anyhow!("inserted run {id} not found")),
            }
        };
        tx.commit()?;
        Ok(run)
    }

    /// Settle a run attempt to a terminal status (`running` / `failed`), updating both the run and
    /// its work item in one transaction so the pair can never drift.
    pub fn finish_run(&mut self, run_id: &str, work_item_id: &str, status: Status) -> Result<()> {
        let status = status.as_str();
        let tx = self.conn_mut().transaction()?;
        let run_affected = tx.execute(
            "UPDATE runs
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![status, run_id],
        )?;
        if run_affected == 0 {
            return Err(anyhow!("run not found: {run_id}"));
        }
        let item_affected = tx.execute(
            "UPDATE work_items
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![status, work_item_id],
        )?;
        if item_affected == 0 {
            return Err(anyhow!("work item not found: {work_item_id}"));
        }
        tx.commit()?;
        Ok(())
    }

    /// Recording `settings_path` is not a status transition, so it stays out of `finish_run` and
    /// runs as a single UPDATE on its own.
    pub fn set_run_settings_path(&self, run_id: &str, settings_path: &str) -> Result<()> {
        let affected = self.conn().execute(
            "UPDATE runs
               SET settings_path = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![settings_path, run_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("run not found: {run_id}"));
        }
        Ok(())
    }

    pub fn get_run(&self, id: &str) -> Result<Option<Run>> {
        let mut stmt = self
            .conn()
            .prepare(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Run::from_row(row)?)),
            None => Ok(None),
        }
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
    /// timeout, worktree root, or agent.
    pub fn upsert_project(&self, p: &Project) -> Result<Project> {
        self.conn().execute(
            "INSERT INTO projects
               (id, name, provider, repo, path, default_branch, worktree_root,
                setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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

fn parse_bool(value: &str) -> Result<bool> {
    match value {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        other => Err(anyhow!(
            "expected a boolean (true/false/1/0), got {other:?}"
        )),
    }
}

/// Best-effort PR number from a GitHub PR URL: the positive integer segment right after `pull`
/// (or `pulls`), so `.../pull/99` and `.../pull/99/files` both yield 99. The URL is always stored
/// regardless; a miss just means the ref has no numeric handle.
fn parse_pr_number(url: &str) -> Option<i64> {
    let segs: Vec<&str> = url.split('/').filter(|s| !s.is_empty()).collect();
    let idx = segs.iter().position(|s| *s == "pull" || *s == "pulls")?;
    segs.get(idx + 1)?.parse::<i64>().ok().filter(|n| *n > 0)
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

    fn new_run(work_item_id: &str) -> NewRun {
        NewRun {
            work_item_id: work_item_id.to_string(),
            agent: Some(Agent::Claude),
            branch: Some("mon-1".to_string()),
            worktree_path: Some("/tmp/wt".to_string()),
        }
    }

    fn insert_run_at(
        db: &Db,
        id: &str,
        work_item_id: &str,
        branch: Option<&str>,
        created_at: &str,
    ) {
        db.conn()
            .execute(
                "INSERT INTO runs
                   (id, work_item_id, branch, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![
                    id,
                    work_item_id,
                    branch,
                    Status::Running.as_str(),
                    created_at
                ],
            )
            .unwrap();
    }

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::migrate(&mut conn).unwrap();
        crate::migrations::migrate(&mut conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);

        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table'
                 AND name IN ('mon_counter','run_counter','work_items','runs','events','external_refs','projects')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 7);
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
    fn start_run_sets_run_and_work_item_to_setting_up() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db
            .insert_work_item({
                let mut i = dev_item("runnable");
                i.status = Status::Ready;
                i
            })
            .unwrap();

        let run = db.start_run(new_run(&item.id)).unwrap();
        assert_eq!(run.id, "run-1");
        assert_eq!(run.status, Status::SettingUp);
        assert_eq!(run.agent.as_deref(), Some("claude"));
        assert_eq!(run.branch.as_deref(), Some("mon-1"));
        assert_eq!(run.worktree_path.as_deref(), Some("/tmp/wt"));

        assert_eq!(db.get_run("run-1").unwrap().unwrap(), run);
        assert_eq!(
            db.get_work_item(&item.id).unwrap().unwrap().status,
            Status::SettingUp,
            "start_run must move the work item to setting_up in the same transaction"
        );
    }

    #[test]
    fn run_ids_increase_monotonically() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db.insert_work_item(dev_item("a")).unwrap();
        let r1 = db.start_run(new_run(&item.id)).unwrap();
        let r2 = db.start_run(new_run(&item.id)).unwrap();
        assert_eq!((r1.id.as_str(), r2.id.as_str()), ("run-1", "run-2"));
    }

    #[test]
    fn finish_run_updates_run_and_work_item_together() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db.insert_work_item(dev_item("a")).unwrap();
        let run = db.start_run(new_run(&item.id)).unwrap();

        db.finish_run(&run.id, &item.id, Status::Running).unwrap();
        assert_eq!(
            db.get_run(&run.id).unwrap().unwrap().status,
            Status::Running
        );
        assert_eq!(
            db.get_work_item(&item.id).unwrap().unwrap().status,
            Status::Running
        );

        assert!(db.finish_run("run-999", &item.id, Status::Failed).is_err());
    }

    #[test]
    fn finish_run_unknown_work_item_rolls_back() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db.insert_work_item(dev_item("a")).unwrap();
        let run = db.start_run(new_run(&item.id)).unwrap();

        // Valid run id, wrong work item: the work item update finds nothing and the whole tx must
        // roll back, so the run must not drift to `running` on its own.
        assert!(db.finish_run(&run.id, "MON-999", Status::Running).is_err());
        assert_eq!(
            db.get_run(&run.id).unwrap().unwrap().status,
            Status::SettingUp
        );
        assert_eq!(
            db.get_work_item(&item.id).unwrap().unwrap().status,
            Status::SettingUp
        );
    }

    #[test]
    fn set_run_settings_path_records_and_bumps_updated_at() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db.insert_work_item(dev_item("settings target")).unwrap();
        let run = db.start_run(new_run(&item.id)).unwrap();

        // Force a measurable gap so updated_at must move past start_run's timestamp.
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.set_run_settings_path(&run.id, "/abs/runs/run-1/claude-settings.json")
            .unwrap();

        let fetched = db.get_run(&run.id).unwrap().unwrap();
        assert_eq!(
            fetched.settings_path.as_deref(),
            Some("/abs/runs/run-1/claude-settings.json")
        );
        assert!(
            fetched.updated_at > run.updated_at,
            "settings_path update must bump updated_at"
        );
        assert_eq!(
            fetched.status, run.status,
            "set_run_settings_path is not a status transition"
        );
    }

    #[test]
    fn set_run_settings_path_errors_on_unknown_run() {
        let db = Db::open_in_memory().unwrap();
        let err = db.set_run_settings_path("run-999", "/x").unwrap_err();
        assert!(format!("{err:#}").contains("run not found"), "{err:#}");
    }

    #[test]
    fn start_run_unknown_work_item_leaves_no_phantom_run() {
        let mut db = Db::open_in_memory().unwrap();
        assert!(db.start_run(new_run("MON-999")).is_err());
        assert!(
            db.get_run("run-1").unwrap().is_none(),
            "a rolled-back start_run must not leak a run row"
        );
    }

    #[test]
    fn get_missing_work_item_is_none() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.get_work_item("MON-1").unwrap().is_none());
    }

    #[test]
    fn list_issue_statuses_uses_effective_repo_and_filters() {
        let mut db = Db::open_in_memory().unwrap();
        let mut project = sample_project();
        project.repo = "ashigirl96/monica-renamed".to_string();
        db.upsert_project(&project).unwrap();

        let linked = db
            .insert_work_item_with_ref(
                {
                    let mut item = dev_item("linked");
                    item.status = Status::Ready;
                    item.project_id = Some("ashigirl96/monica".to_string());
                    item
                },
                ExternalRef::new(
                    String::new(),
                    RefType::GithubIssue,
                    Some("ashigirl96/monica-stale".to_string()),
                    Some(17),
                    None,
                ),
            )
            .unwrap();
        let unlinked = db
            .insert_work_item_with_ref(
                {
                    let mut item = dev_item("unlinked");
                    item.status = Status::NeedApproval;
                    item
                },
                ExternalRef::new(
                    String::new(),
                    RefType::GithubIssue,
                    Some("ashigirl96/other".to_string()),
                    Some(18),
                    None,
                ),
            )
            .unwrap();

        let all = db.list_issue_statuses(None, None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, linked.id);
        assert_eq!(all[0].project.as_deref(), Some("ashigirl96/monica-renamed"));
        assert_eq!(all[0].github_issue_number, Some(17));
        assert_eq!(all[1].id, unlinked.id);
        assert_eq!(all[1].project.as_deref(), Some("ashigirl96/other"));

        let ready = db.list_issue_statuses(Some(Status::Ready), None).unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, linked.id);

        let filtered = db
            .list_issue_statuses(None, Some("ashigirl96/monica-renamed"))
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, linked.id);
        assert!(db
            .list_issue_statuses(None, Some("ashigirl96/monica-stale"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn list_issue_statuses_picks_latest_run_deterministically() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db
            .insert_work_item_with_ref(
                dev_item("tracked"),
                ExternalRef::new(
                    String::new(),
                    RefType::GithubIssue,
                    Some("ashigirl96/monica".to_string()),
                    Some(17),
                    None,
                ),
            )
            .unwrap();

        insert_run_at(
            &db,
            "run-9",
            &item.id,
            Some("monica/old"),
            "2026-05-28T01:00:00.000Z",
        );
        insert_run_at(
            &db,
            "run-10",
            &item.id,
            Some("monica/newer"),
            "2026-05-28T02:00:00.000Z",
        );
        insert_run_at(
            &db,
            "run-11",
            &item.id,
            Some("monica/tiebreak"),
            "2026-05-28T02:00:00.000Z",
        );

        let rows = db.list_issue_statuses(None, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].branch.as_deref(), Some("monica/tiebreak"));
    }

    #[test]
    fn list_issue_statuses_handles_missing_ref_and_run() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db.insert_work_item(dev_item("plain")).unwrap();

        let rows = db.list_issue_statuses(None, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, item.id);
        assert_eq!(rows[0].project, None);
        assert_eq!(rows[0].github_issue_number, None);
        assert_eq!(rows[0].branch, None);
    }

    #[test]
    fn list_issue_statuses_uses_latest_issue_ref() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db.insert_work_item(dev_item("tracked")).unwrap();
        db.save_external_ref(&ExternalRef::new(
            item.id.clone(),
            RefType::GithubIssue,
            Some("ashigirl96/first".to_string()),
            Some(17),
            None,
        ))
        .unwrap();
        db.save_external_ref(&ExternalRef::new(
            item.id.clone(),
            RefType::GithubIssue,
            Some("ashigirl96/second".to_string()),
            Some(18),
            None,
        ))
        .unwrap();

        let rows = db.list_issue_statuses(None, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].project.as_deref(), Some("ashigirl96/second"));
        assert_eq!(rows[0].github_issue_number, Some(18));
    }

    #[test]
    fn mon_ids_increase_monotonically() {
        let mut db = Db::open_in_memory().unwrap();
        let a = db.insert_work_item(dev_item("a")).unwrap();
        let b = db.insert_work_item(dev_item("b")).unwrap();
        let c = db.insert_work_item(dev_item("c")).unwrap();
        assert_eq!(
            (a.id.as_str(), b.id.as_str(), c.id.as_str()),
            ("MON-1", "MON-2", "MON-3")
        );
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
    fn insert_work_item_with_ref_links_atomically() {
        let mut db = Db::open_in_memory().unwrap();
        let external = ExternalRef::new(
            String::new(),
            RefType::GithubIssue,
            Some("ashigirl96/monica".to_string()),
            Some(9),
            Some("https://github.com/ashigirl96/monica/issues/9".to_string()),
        );
        let item = db
            .insert_work_item_with_ref(dev_item("tracked"), external)
            .unwrap();
        assert_eq!(item.id, "MON-1");

        let refs = db.list_external_refs("MON-1").unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(
            refs[0].work_item_id, "MON-1",
            "ref must adopt the allocated id"
        );
        assert_eq!(refs[0].ref_type, RefType::GithubIssue);
        assert_eq!(refs[0].repo.as_deref(), Some("ashigirl96/monica"));
        assert_eq!(refs[0].number, Some(9));
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
        assert!(
            !created.created_at.is_empty(),
            "created_at should be filled by the DB default"
        );
        assert!(
            !created.updated_at.is_empty(),
            "updated_at should be filled by the DB default"
        );

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

        db.set_project_field(id, "default_branch", "develop")
            .unwrap();
        db.set_project_field(id, "agent_permission_mode", "acceptEdits")
            .unwrap();
        db.set_project_field(id, "setup_timeout_sec", "900")
            .unwrap();
        db.set_project_field(id, "hooks_claude", "false").unwrap();
        db.set_project_field(id, "worktree_root", "/Users/dev/.worktrees/monica")
            .unwrap();

        let p = db.get_project(id).unwrap().unwrap();
        assert_eq!(p.default_branch, "develop");
        assert_eq!(p.agent_permission_mode, PermissionMode::AcceptEdits);
        assert_eq!(p.setup_timeout_sec, 900);
        assert!(!p.hooks_claude);
        assert_eq!(
            p.worktree_root.as_deref(),
            Some("/Users/dev/.worktrees/monica")
        );

        assert!(db
            .set_project_field(id, "agent_permission_mode", "bogus")
            .is_err());
        assert!(db
            .set_project_field(id, "setup_timeout_sec", "abc")
            .is_err());
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

        db.set_project_field("ashigirl96/monica", "name", "Custom")
            .unwrap();
        db.set_project_field("ashigirl96/monica", "setup_timeout_sec", "900")
            .unwrap();
        db.set_project_field("ashigirl96/monica", "default_branch", "develop")
            .unwrap();

        let mut reinit = Project::from_repo("ashigirl96/monica");
        reinit.path = Some("/Users/dev/monica-moved".to_string());
        let after = db.upsert_project(&reinit).unwrap();

        assert_eq!(after.name, "Custom", "set value must survive re-init");
        assert_eq!(
            after.setup_timeout_sec, 900,
            "set value must survive re-init"
        );
        assert_eq!(
            after.default_branch, "develop",
            "set value must survive re-init"
        );
        assert_eq!(
            after.path.as_deref(),
            Some("/Users/dev/monica-moved"),
            "path tracks the new checkout"
        );
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
        assert_eq!(
            Provider::Github.as_str().parse::<Provider>().unwrap(),
            Provider::Github
        );
        assert!("gitlab".parse::<Provider>().is_err());
        assert_eq!(
            Agent::Claude.as_str().parse::<Agent>().unwrap(),
            Agent::Claude
        );
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
        assert_eq!(
            WorkItemKind::Development
                .as_str()
                .parse::<WorkItemKind>()
                .unwrap(),
            WorkItemKind::Development
        );
        assert!("nope".parse::<WorkItemKind>().is_err());
        assert_eq!(
            RefType::GithubIssue.as_str().parse::<RefType>().unwrap(),
            RefType::GithubIssue
        );
        assert!("nope".parse::<RefType>().is_err());
    }

    #[test]
    fn status_parse_token_accepts_dashes_and_underscores() {
        assert_eq!(
            Status::parse_token("need-approval").unwrap(),
            Status::NeedApproval
        );
        assert_eq!(
            Status::parse_token("need_approval").unwrap(),
            Status::NeedApproval
        );
        assert_eq!(Status::parse_token("pr-open").unwrap(), Status::PrOpen);
        assert_eq!(Status::parse_token("running").unwrap(), Status::Running);
        assert!(Status::parse_token("bogus").is_err());
    }

    #[test]
    fn ref_type_pull_request_round_trips() {
        assert_eq!(RefType::GithubPullRequest.as_str(), "github_pull_request");
        assert_eq!(
            "github_pull_request".parse::<RefType>().unwrap(),
            RefType::GithubPullRequest
        );
    }

    #[test]
    fn parse_pr_number_extracts_after_pull_segment() {
        assert_eq!(parse_pr_number("https://github.com/o/r/pull/99"), Some(99));
        assert_eq!(
            parse_pr_number("https://github.com/o/r/pull/99/files"),
            Some(99)
        );
        assert_eq!(parse_pr_number("https://github.com/o/r/pulls/12"), Some(12));
        assert_eq!(parse_pr_number("https://github.com/o/r/issues/99"), None);
        assert_eq!(parse_pr_number("not a url"), None);
        assert_eq!(parse_pr_number("https://github.com/o/r/pull/abc"), None);
        assert_eq!(parse_pr_number("https://github.com/o/r/pull/0"), None);
    }

    #[test]
    fn insert_event_round_trips_and_filters_by_work_item() {
        let mut db = Db::open_in_memory().unwrap();
        let a = db.insert_work_item(dev_item("a")).unwrap();
        let b = db.insert_work_item(dev_item("b")).unwrap();

        let ev = db
            .insert_event(
                Some(&a.id),
                None,
                "claude_hook",
                &json!({ "hook_event_name": "Stop" }),
            )
            .unwrap();
        assert!(ev.id > 0);
        assert_eq!(ev.work_item_id.as_deref(), Some(a.id.as_str()));
        assert_eq!(ev.run_id, None);
        assert_eq!(ev.kind, "claude_hook");
        assert_eq!(ev.payload, json!({ "hook_event_name": "Stop" }));
        assert!(!ev.created_at.is_empty());

        db.insert_event(Some(&b.id), None, "mark", &json!({ "x": 1 }))
            .unwrap();

        assert_eq!(db.list_events(None).unwrap().len(), 2);
        let a_events = db.list_events(Some(&a.id)).unwrap();
        assert_eq!(a_events.len(), 1);
        assert_eq!(a_events[0].kind, "claude_hook");
    }

    #[test]
    fn insert_event_allows_null_work_item_and_run() {
        let db = Db::open_in_memory().unwrap();
        let ev = db
            .insert_event(None, None, "claude_hook", &json!({ "raw": "x" }))
            .unwrap();
        assert_eq!(ev.work_item_id, None);
        assert_eq!(ev.run_id, None);
    }

    #[test]
    fn apply_hook_status_updates_work_item_and_matching_run() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db
            .insert_work_item({
                let mut i = dev_item("a");
                i.status = Status::Ready;
                i
            })
            .unwrap();
        let run = db.start_run(new_run(&item.id)).unwrap();

        db.apply_hook_status(&item.id, Some(&run.id), Status::Running)
            .unwrap();
        assert_eq!(
            db.get_work_item(&item.id).unwrap().unwrap().status,
            Status::Running
        );
        assert_eq!(db.get_run(&run.id).unwrap().unwrap().status, Status::Running);
    }

    #[test]
    fn apply_hook_status_ignores_run_of_another_work_item() {
        let mut db = Db::open_in_memory().unwrap();
        let a = db
            .insert_work_item({
                let mut i = dev_item("a");
                i.status = Status::Ready;
                i
            })
            .unwrap();
        let run_a = db.start_run(new_run(&a.id)).unwrap();
        let b = db
            .insert_work_item({
                let mut i = dev_item("b");
                i.status = Status::Ready;
                i
            })
            .unwrap();

        // Mark b but pass run_a: the `AND work_item_id` guard must leave run_a (and a) untouched.
        db.apply_hook_status(&b.id, Some(&run_a.id), Status::Stopped)
            .unwrap();
        assert_eq!(
            db.get_work_item(&b.id).unwrap().unwrap().status,
            Status::Stopped
        );
        assert_eq!(
            db.get_run(&run_a.id).unwrap().unwrap().status,
            Status::SettingUp
        );
        assert_eq!(
            db.get_work_item(&a.id).unwrap().unwrap().status,
            Status::SettingUp
        );
    }

    #[test]
    fn apply_hook_status_unknown_work_item_errors_but_unknown_run_is_harmless() {
        let mut db = Db::open_in_memory().unwrap();
        assert!(db
            .apply_hook_status("MON-999", None, Status::Stopped)
            .is_err());

        let item = db.insert_work_item(dev_item("a")).unwrap();
        db.apply_hook_status(&item.id, Some("run-nope"), Status::Stopped)
            .unwrap();
        assert_eq!(
            db.get_work_item(&item.id).unwrap().unwrap().status,
            Status::Stopped
        );
    }

    #[test]
    fn mark_work_item_sets_status_phase_pr_ref_and_event() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db.insert_work_item(dev_item("a")).unwrap();

        db.mark_work_item(&item.id, Status::NeedApproval, Some("Plan ready"), None)
            .unwrap();
        let after = db.get_work_item(&item.id).unwrap().unwrap();
        assert_eq!(after.status, Status::NeedApproval);
        assert_eq!(after.phase.as_deref(), Some("Plan ready"));

        db.mark_work_item(
            &item.id,
            Status::PrOpen,
            None,
            Some("https://github.com/o/r/pull/99"),
        )
        .unwrap();
        let after = db.get_work_item(&item.id).unwrap().unwrap();
        assert_eq!(after.status, Status::PrOpen);
        assert_eq!(
            after.phase.as_deref(),
            Some("Plan ready"),
            "note=None keeps the prior phase"
        );

        let refs = db.list_external_refs(&item.id).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].ref_type, RefType::GithubPullRequest);
        assert_eq!(refs[0].number, Some(99));
        assert_eq!(
            refs[0].url.as_deref(),
            Some("https://github.com/o/r/pull/99")
        );

        let events = db.list_events(Some(&item.id)).unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.kind == "mark"));
    }

    #[test]
    fn mark_work_item_pr_ref_does_not_pollute_issue_status_query() {
        let mut db = Db::open_in_memory().unwrap();
        let item = db
            .insert_work_item_with_ref(
                dev_item("tracked"),
                ExternalRef::new(
                    String::new(),
                    RefType::GithubIssue,
                    Some("o/r".to_string()),
                    Some(7),
                    None,
                ),
            )
            .unwrap();
        db.mark_work_item(
            &item.id,
            Status::PrOpen,
            None,
            Some("https://github.com/o/r/pull/99"),
        )
        .unwrap();

        let rows = db.list_issue_statuses(None, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].github_issue_number,
            Some(7),
            "the PR ref must not shadow the github_issue number"
        );
        assert_eq!(rows[0].status, Status::PrOpen);
    }

    #[test]
    fn mark_work_item_unknown_id_errors() {
        let mut db = Db::open_in_memory().unwrap();
        assert!(db
            .mark_work_item("MON-999", Status::PrOpen, None, None)
            .is_err());
    }

    #[test]
    fn now_iso_returns_utc_millisecond_timestamp() {
        let db = Db::open_in_memory().unwrap();
        let ts = db.now_iso().unwrap();
        // Same shape as the schema column defaults: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
        assert!(ts.ends_with('Z'), "must end in Z: {ts}");
        assert_eq!(ts.len(), 24, "must be 24 chars: {ts}");
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }

    #[test]
    fn db_path_respects_monica_home() {
        let _env = crate::paths::test_env_guard();
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
