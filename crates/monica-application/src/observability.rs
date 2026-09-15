//! The lines this crate writes about its own decisions.
//!
//! Every line is `key=value` throughout, so one processing can be pulled back out with
//! `rg 'task_run_id=…'` across the whole log directory. Building each line in a pure function keeps
//! the format in one place (there is no logger capture to test against, so the line itself is what
//! gets asserted) and keeps the `format!` out of the dozen call sites.
//!
//! Two correlation ids look alike and are deliberately not: `session_id` is the terminal session
//! (what `monica hook` already logs under that name), `agent_session_id` is the agent's own.

use crate::prelude::{TaskId, TaskRunId, TaskRunStatus, TaskStatus};
use crate::ApplicationError;

/// Run and task lifecycle: transitions that landed, and the gates that refused one.
const LIFECYCLE: &str = "monica_application::lifecycle";

fn status_or_unknown(status: Option<TaskRunStatus>) -> &'static str {
    status.map_or("unknown", TaskRunStatus::as_str)
}

fn run_status_line(
    task_run_id: &TaskRunId,
    task_id: &TaskId,
    from: Option<TaskRunStatus>,
    to: TaskRunStatus,
    cause: &str,
) -> String {
    format!(
        "run_status task_run_id={task_run_id} task_id={task_id} from={} to={} cause={cause}",
        status_or_unknown(from),
        to.as_str(),
    )
}

/// A TaskRun reached `to`. Only called once the write landed, so the line never claims a transition
/// the store refused.
pub(crate) fn run_status(
    task_run_id: &TaskRunId,
    task_id: &TaskId,
    from: Option<TaskRunStatus>,
    to: TaskRunStatus,
    cause: &str,
) {
    log::info!(target: LIFECYCLE, "{}", run_status_line(task_run_id, task_id, from, to, cause));
}

fn task_status_line(task_id: &TaskId, from: TaskStatus, to: TaskStatus, cause: &str) -> String {
    format!(
        "task_status task_id={task_id} from={} to={} cause={cause}",
        from.as_str(),
        to.as_str(),
    )
}

pub(crate) fn task_status(task_id: &TaskId, from: TaskStatus, to: TaskStatus, cause: &str) {
    log::info!(target: LIFECYCLE, "{}", task_status_line(task_id, from, to, cause));
}

fn rejection_line(
    gate: &str,
    task_id: &TaskId,
    task_run_id: Option<&TaskRunId>,
    reason: &str,
) -> String {
    let run = task_run_id.map_or_else(|| "none".to_string(), TaskRunId::to_string);
    format!("run_rejected gate={gate} task_id={task_id} task_run_id={run} reason={reason}")
}

/// Report why a gate turned a user action down, and hand the error straight back for `return
/// Err(reject(…))`. Debug, not warn: a refused Prepare is the system working, not degrading. The
/// error itself carries the human sentence and is logged (or not) by whichever boundary receives it.
pub(crate) fn reject(
    gate: &str,
    task_id: &TaskId,
    task_run_id: Option<&TaskRunId>,
    reason: &str,
    err: ApplicationError,
) -> ApplicationError {
    log::debug!(target: LIFECYCLE, "{}", rejection_line(gate, task_id, task_run_id, reason));
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_id() -> TaskRunId {
        TaskRunId::from_store("run-12".to_string())
    }

    fn task_id() -> TaskId {
        TaskId::from_store("MON-42".to_string())
    }

    #[test]
    fn a_run_transition_names_both_ends_and_its_cause() {
        assert_eq!(
            run_status_line(
                &run_id(),
                &task_id(),
                Some(TaskRunStatus::SettingUp),
                TaskRunStatus::Prepared,
                "setup_ok",
            ),
            "run_status task_run_id=run-12 task_id=MON-42 from=setting_up to=prepared \
             cause=setup_ok"
        );
    }

    #[test]
    fn a_transition_whose_origin_was_not_read_says_unknown() {
        assert_eq!(
            run_status_line(&run_id(), &task_id(), None, TaskRunStatus::Failed, "execute_error"),
            "run_status task_run_id=run-12 task_id=MON-42 from=unknown to=failed \
             cause=execute_error"
        );
    }

    #[test]
    fn a_task_transition_carries_no_run() {
        assert_eq!(
            task_status_line(&task_id(), TaskStatus::InProgress, TaskStatus::Closed, "close_task"),
            "task_status task_id=MON-42 from=in_progress to=closed cause=close_task"
        );
    }

    #[test]
    fn a_rejection_names_the_gate_and_stays_greppable_without_a_run() {
        assert_eq!(
            rejection_line("accepts_new_run", &task_id(), Some(&run_id()), "active_run"),
            "run_rejected gate=accepts_new_run task_id=MON-42 task_run_id=run-12 \
             reason=active_run"
        );
        assert_eq!(
            rejection_line("start_gate", &task_id(), None, "blocked_by"),
            "run_rejected gate=start_gate task_id=MON-42 task_run_id=none reason=blocked_by"
        );
    }
}
