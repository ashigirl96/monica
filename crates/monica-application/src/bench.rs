use monica_domain::{RunspaceId, TaskId, TaskRunId};
use serde::Serialize;

const BENCH_PREFIX: &str = "bench-";

pub fn bench_runspace_id(task_id: &TaskId) -> RunspaceId {
    RunspaceId::from_store(format!("{BENCH_PREFIX}{task_id}"))
}

/// The task whose bench `runspace_id` is, read off the id itself so it survives the bench link
/// being dropped at close. Only an exact `bench_runspace_id` output counts: `TaskId::parse` also
/// accepts a bare number, which no bench id ever carries.
pub(crate) fn bench_task_id(runspace_id: &RunspaceId) -> Option<TaskId> {
    let raw = runspace_id.as_str().strip_prefix(BENCH_PREFIX)?;
    TaskId::parse(raw).ok().filter(|task_id| task_id.as_str() == raw)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskBench {
    pub task_id: TaskId,
    pub runspace_id: RunspaceId,
    pub cwd: String,
    pub created: bool,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrepareTaskResult {
    pub task_id: TaskId,
    pub task_run_id: TaskRunId,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunTaskResult {
    pub task_id: TaskId,
    pub task_run_id: TaskRunId,
    pub runspace_id: RunspaceId,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub initial_command: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runspace(id: &str) -> RunspaceId {
        RunspaceId::from_store(id.to_string())
    }

    #[test]
    fn a_bench_id_reads_back_as_its_task() {
        let task = TaskId::from_store("MON-3".to_string());
        assert_eq!(bench_task_id(&bench_runspace_id(&task)), Some(task));
    }

    #[test]
    fn ids_no_bench_was_minted_with_name_no_task() {
        for id in ["bench-3", "bench-mon-3", "bench-", "MON-3", "3f2c9a4e-0b1d-4c55-9a7e-2f1d6b8c9e01"] {
            assert_eq!(bench_task_id(&runspace(id)), None, "{id}");
        }
    }
}
