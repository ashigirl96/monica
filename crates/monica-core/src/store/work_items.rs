use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::db::Db;
use crate::model::{ExternalRef, IssueStatusRow, NewWorkItem, RefType, Status, WorkItem};

use super::{SET_NOW, WORK_ITEM_COLUMNS};

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

    pub fn delete_work_item(&mut self, id: &str) -> Result<WorkItem> {
        let run_count: i64 = self.conn().query_row(
            "SELECT count(*) FROM runs WHERE work_item_id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        if run_count > 0 {
            return Err(anyhow!(
                "work item {id} has {run_count} run(s); use the cleanup-aware issue delete path"
            ));
        }
        self.delete_work_item_cascade(id)
    }

    pub(crate) fn delete_work_item_cascade(&mut self, id: &str) -> Result<WorkItem> {
        let tx = self.conn_mut().transaction()?;
        let item = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {WORK_ITEM_COLUMNS} FROM work_items WHERE id = ?1"
            ))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => WorkItem::from_row(row)?,
                None => return Err(anyhow!("work item not found: {id}")),
            }
        };

        tx.execute(
            "DELETE FROM events WHERE work_item_id = ?1
               OR run_id IN (SELECT id FROM runs WHERE work_item_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM external_refs WHERE work_item_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM runs WHERE work_item_id = ?1", params![id])?;
        tx.execute("DELETE FROM work_items WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(item)
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
}

pub(super) fn parse_pr_number(url: &str) -> Option<i64> {
    let segs: Vec<&str> = url.split('/').filter(|s| !s.is_empty()).collect();
    let idx = segs.iter().position(|s| *s == "pull" || *s == "pulls")?;
    segs.get(idx + 1)?.parse::<i64>().ok().filter(|n| *n > 0)
}
