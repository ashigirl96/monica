use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::db::Db;
use crate::model::{ExternalRef, NewWorkItem, Status, WorkItem};

const WORK_ITEM_COLUMNS: &str = "id, kind, status, phase, title, body, project_id, \
     labels, details_json, source_json, created_at, updated_at";

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{RefType, WorkItemKind};
    use serde_json::json;

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
        assert_eq!(version, 1);

        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table'
                 AND name IN ('mon_counter','work_items','runs','events','external_refs')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 5);
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
