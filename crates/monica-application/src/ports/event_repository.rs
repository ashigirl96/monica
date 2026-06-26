use anyhow::Result;
use serde_json::Value;

use crate::Event;

pub trait EventRepository {
    fn insert_event(
        &self,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        kind: &str,
        payload: &Value,
    ) -> Result<Event>;
    fn list_events(&self, task_id: Option<&str>) -> Result<Vec<Event>>;
}
