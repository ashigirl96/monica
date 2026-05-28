use anyhow::Result;
use rusqlite::params;

use crate::db::Db;
use crate::model::ExternalRef;

impl Db {
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
