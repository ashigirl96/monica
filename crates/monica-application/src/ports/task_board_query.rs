use anyhow::Result;

use crate::prelude::DisplayStatus;
use crate::queries::TaskSummaryRow;

/// How [`TaskBoardQuery::list_task_summaries`] scopes which tasks come back. This is the query's
/// parameter, not a domain concept, so it lives beside the port rather than in `monica-domain`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSummaryFilter {
    /// Every task, including the Closed archive.
    All,
    /// Everything except the Closed archive.
    Active,
    /// Exactly one display status; Closed is reachable only when named here.
    Status(DisplayStatus),
}

impl TaskSummaryFilter {
    pub fn matches(self, status: DisplayStatus) -> bool {
        match self {
            TaskSummaryFilter::All => true,
            TaskSummaryFilter::Active => status != DisplayStatus::Closed,
            TaskSummaryFilter::Status(s) => s == status,
        }
    }
}

/// Read-only board projection. Kept apart from [`TaskStore`](super::TaskStore) because the summary
/// is a denormalized CQRS view (task + run + project join), not a task-aggregate operation.
pub trait TaskBoardQuery {
    fn list_task_summaries(
        &self,
        filter: TaskSummaryFilter,
        project: Option<&str>,
    ) -> Result<Vec<TaskSummaryRow>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_summary_filter_matches_by_intent() {
        assert!(TaskSummaryFilter::All.matches(DisplayStatus::Closed));
        assert!(TaskSummaryFilter::All.matches(DisplayStatus::Ready));

        assert!(!TaskSummaryFilter::Active.matches(DisplayStatus::Closed));
        assert!(TaskSummaryFilter::Active.matches(DisplayStatus::Ready));
        assert!(TaskSummaryFilter::Active.matches(DisplayStatus::Running));

        let closed = TaskSummaryFilter::Status(DisplayStatus::Closed);
        assert!(closed.matches(DisplayStatus::Closed));
        assert!(!closed.matches(DisplayStatus::Ready));
    }
}
