//! The lines this crate writes about its own decisions.
//!
//! Every line is `key=value` throughout, so one processing can be pulled back out with
//! `rg 'task_run_id=…'` across the whole log directory. Building each line in a pure function keeps
//! the format in one place (there is no logger capture to test against, so the line itself is what
//! gets asserted) and keeps the `format!` out of the dozen call sites.
//!
//! Two correlation ids look alike and are deliberately not: `session_id` is the terminal session
//! (what `monica hook` already logs under that name), `agent_session_id` is the agent's own.

use std::borrow::Cow;

use crate::prelude::{TaskId, TaskRunId, TaskRunStatus, TaskStatus};
use crate::ApplicationError;

/// Run and task lifecycle: transitions that landed, and the gates that refused one.
const LIFECYCLE: &str = "monica_application::lifecycle";

/// Make one free-form value safe to put in a line.
///
/// Ids and event names reach these lines from hook payloads and the environment, so they are
/// arbitrary text. A newline in one would split the record in two and let a payload forge a log
/// entry; a space would make `key=value` ambiguous. Whitespace and control characters become `_`,
/// and nothing else is touched, so a real id still reads back verbatim.
pub(crate) fn field(value: &str) -> Cow<'_, str> {
    fn unsafe_char(c: char) -> bool {
        c.is_whitespace() || c.is_control()
    }
    if value.contains(unsafe_char) {
        Cow::Owned(
            value
                .chars()
                .map(|c| if unsafe_char(c) { '_' } else { c })
                .collect(),
        )
    } else {
        Cow::Borrowed(value)
    }
}

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
        "run_status task_run_id={} task_id={} from={} to={} cause={}",
        field(task_run_id),
        field(task_id),
        status_or_unknown(from),
        to.as_str(),
        field(cause),
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
        "task_status task_id={} from={} to={} cause={}",
        field(task_id),
        from.as_str(),
        to.as_str(),
        field(cause),
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
    let run = task_run_id.map_or(Cow::Borrowed("none"), |id| field(id));
    format!(
        "run_rejected gate={gate} task_id={} task_run_id={run} reason={reason}",
        field(task_id),
    )
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
    fn a_payload_supplied_cause_cannot_split_the_line() {
        assert_eq!(
            run_status_line(
                &run_id(),
                &task_id(),
                Some(TaskRunStatus::Running),
                TaskRunStatus::Stopped,
                "hook:Stop\nrun_status task_run_id=run-99 forged=true",
            ),
            "run_status task_run_id=run-12 task_id=MON-42 from=running to=stopped \
             cause=hook:Stop_run_status_task_run_id=run-99_forged=true"
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
