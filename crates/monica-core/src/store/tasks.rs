use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::db::Db;
use crate::model::{
    DisplayStatus, ExternalRef, NewTask, Task, TaskRunStatus, TaskRunWaitReason, TaskStatus,
    TaskSummaryRow,
};

use super::{SET_NOW, TASK_COLUMNS};

impl Db {
    pub fn insert_task(&mut self, new: NewTask) -> Result<Task> {
        self.insert_task_inner(new, None)
    }

    /// Insert a task and its external ref in one transaction, so a failure to record the
    /// external link can never leave an orphan task behind. The ref's `task_id` is
    /// replaced with the freshly allocated `MON-<n>` id.
    pub fn insert_task_with_ref(&mut self, new: NewTask, external: ExternalRef) -> Result<Task> {
        self.insert_task_inner(new, Some(external))
    }

    fn insert_task_inner(&mut self, new: NewTask, external: Option<ExternalRef>) -> Result<Task> {
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
            "INSERT INTO tasks
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
                "INSERT INTO external_refs (task_id, ref_type, repo, number, url)
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
            let mut stmt =
                tx.prepare(&format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => Task::from_row(row)?,
                None => return Err(anyhow!("inserted task {id} not found")),
            }
        };
        tx.commit()?;
        Ok(item)
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1 AND deleted_at IS NULL"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Task::from_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn delete_task(&mut self, id: &str) -> Result<Task> {
        self.mark_task_deleted(id)
    }

    pub(crate) fn mark_task_deleted(&mut self, id: &str) -> Result<Task> {
        let tx = self.conn_mut().transaction()?;
        let item = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1 AND deleted_at IS NULL"
            ))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => Task::from_row(row)?,
                None => return Err(anyhow!("task not found: {id}")),
            }
        };

        tx.execute(
            &format!(
                "UPDATE tasks
                    SET deleted_at = {SET_NOW},
                        updated_at = {SET_NOW}
                  WHERE id = ?1 AND deleted_at IS NULL"
            ),
            params![id],
        )?;
        tx.commit()?;
        Ok(item)
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks
             WHERE deleted_at IS NULL
             ORDER BY created_at, id"
        ))?;
        let mut rows = stmt.query([])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push(Task::from_row(row)?);
        }
        Ok(items)
    }

    pub fn list_task_summaries(
        &self,
        status: Option<DisplayStatus>,
        project: Option<&str>,
    ) -> Result<Vec<TaskSummaryRow>> {
        let mut stmt = self.conn().prepare(
            "SELECT
               t.id AS task_id,
               coalesce(project.repo, issue_ref.repo, t.project_id) AS project,
               issue_ref.number AS github_issue_number,
	               t.status AS task_status,
	               latest_run.status AS task_run_status,
	               latest_run.wait_reason AS task_run_wait_reason,
	               latest_run.branch AS branch
	             FROM tasks t
             LEFT JOIN projects project
               ON project.id = t.project_id
             LEFT JOIN external_refs issue_ref
               ON issue_ref.id = (
                 SELECT er.id
                 FROM external_refs er
                 WHERE er.task_id = t.id AND er.ref_type = 'github_issue'
                 ORDER BY er.id DESC
                 LIMIT 1
               )
            LEFT JOIN task_runs latest_run
               ON latest_run.id = (
                 SELECT r.id
                 FROM task_runs r
                 WHERE r.task_id = t.id
                 ORDER BY r.created_at DESC,
                          CAST(SUBSTR(r.id, 5) AS INTEGER) DESC
                 LIMIT 1
               )
	             WHERE t.deleted_at IS NULL
	               AND (?1 IS NULL OR coalesce(project.repo, issue_ref.repo, t.project_id) = ?1)
	             ORDER BY t.created_at, t.id",
        )?;
        let mut rows = stmt.query(params![project])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            let task_status: TaskStatus = row.get::<_, String>("task_status")?.parse()?;
            let task_run_status: Option<TaskRunStatus> = row
                .get::<_, Option<String>>("task_run_status")?
                .map(|s| s.parse())
                .transpose()?;
            let task_run_wait_reason: Option<TaskRunWaitReason> = row
                .get::<_, Option<String>>("task_run_wait_reason")?
                .map(|s| s.parse())
                .transpose()?;
            let display_status = DisplayStatus::from_task_and_run(task_status, task_run_status);
            let item = TaskSummaryRow {
                id: row.get("task_id")?,
                project: row.get("project")?,
                github_issue_number: row.get("github_issue_number")?,
                github_pull_requests: Vec::new(),
                task_status,
                task_run_status,
                task_run_wait_reason,
                status: display_status,
                branch: row.get("branch")?,
            };
            if status.is_none_or(|status| status == item.status) {
                items.push(item);
            }
        }
        for item in &mut items {
            item.github_pull_requests = self.list_github_pull_request_refs(&item.id)?;
        }
        Ok(items)
    }

    pub fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<()> {
        let affected = self.conn().execute(
            "UPDATE tasks
	               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	             WHERE id = ?2 AND deleted_at IS NULL",
            params![status.as_str(), id],
        )?;
        if affected == 0 {
            return Err(anyhow!("task not found: {id}"));
        }
        Ok(())
    }

    pub fn mark_task(&mut self, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()> {
        let status_str = status.as_str();
        let payload = serde_json::to_string(&serde_json::json!({
            "status": status_str,
            "note": note,
        }))?;

        let tx = self.conn_mut().transaction()?;
        let affected = tx.execute(
            &format!(
                "UPDATE tasks
	                   SET status = ?1, phase = COALESCE(?2, phase), updated_at = {SET_NOW}
	                 WHERE id = ?3 AND deleted_at IS NULL"
            ),
            params![status_str, note, id],
        )?;
        if affected == 0 {
            return Err(anyhow!("task not found: {id}"));
        }
        tx.execute(
            "INSERT INTO events (task_id, kind, payload_json) VALUES (?1, 'mark', ?2)",
            params![id, payload],
        )?;
        tx.commit()?;
        Ok(())
    }
}
