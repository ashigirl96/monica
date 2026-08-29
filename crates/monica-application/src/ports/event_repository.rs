use anyhow::Result;

use monica_domain::{TaskId, TaskRunId};

use crate::prelude::Event;

pub trait EventRepository {
    /// Record an event row. `payload_json` is opaque JSON text stored verbatim (the caller has
    /// already serialized it); the repository does not interpret it.
    fn insert_event(
        &self,
        task_id: Option<&TaskId>,
        task_run_id: Option<&TaskRunId>,
        kind: &str,
        payload_json: &str,
    ) -> Result<Event>;
    fn list_events(&self, task_id: Option<&TaskId>) -> Result<Vec<Event>>;
}
