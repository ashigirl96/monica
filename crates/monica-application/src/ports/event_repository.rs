use anyhow::Result;

use crate::Event;

pub trait EventRepository {
    /// Record an event row. `payload_json` is opaque JSON text stored verbatim (the caller has
    /// already serialized it); the repository does not interpret it.
    fn insert_event(
        &self,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        kind: &str,
        payload_json: &str,
    ) -> Result<Event>;
    fn list_events(&self, task_id: Option<&str>) -> Result<Vec<Event>>;
}
