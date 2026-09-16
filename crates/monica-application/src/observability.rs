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
pub(crate) const LIFECYCLE: &str = "monica_application::lifecycle";
/// One agent hook, from the identity it arrived with to the transition it produced.
pub(crate) const HOOK: &str = "monica_application::hook";
/// Notification enqueue failures.
pub(crate) const NOTIFY: &str = "monica_application::notify";
/// Terminal session creation and the daemon calls behind it.
pub(crate) const TERMINAL: &str = "monica_application::terminal";
/// Settling the runs left behind by dead terminal sessions.
pub(crate) const SETTLEMENT: &str = "monica_application::settlement";
/// Single-item GitHub reads.
pub(crate) const GITHUB: &str = "monica_application::github";
/// The batched issue / pull request sync.
pub(crate) const GITHUB_SYNC: &str = "monica_application::github_sync";
/// Moving abandoned worktrees to the trash.
pub(crate) const WORKTREE_TRASH: &str = "monica_application::worktree_trash";

/// Make one free-form value safe to put in a line.
///
/// Ids and event names reach these lines from hook payloads and the environment, so they are
/// arbitrary text. A newline in one would split the record in two and let a payload forge a log
/// entry; a space would make `key=value` ambiguous. Whitespace and control characters become `_`,
/// and nothing else is touched, so a real id still reads back verbatim.
pub fn field(value: &str) -> Cow<'_, str> {
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

fn run_settle_skipped_line(task_run_id: &TaskRunId, task_id: &TaskId, cause: &str) -> String {
    format!(
        "run_settle_skipped task_run_id={} task_id={} cause={} reason=not_live",
        field(task_run_id),
        field(task_id),
        field(cause),
    )
}

/// A dead terminal session left a run that was already past `running`, so there is nothing to
/// settle. Debug: the sweep visiting a run it does not own is the normal case, not a fault.
pub(crate) fn run_settle_skipped(task_run_id: &TaskRunId, task_id: &TaskId, cause: &str) {
    log::debug!(target: LIFECYCLE, "{}", run_settle_skipped_line(task_run_id, task_id, cause));
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

/// A `key=value` line under construction: the event name, then one field per call, in call order.
///
/// Timings go through [`Line::duration_ms`] and [`Line::phase_ms`] rather than `format!`, which is
/// what keeps `rg 'duration_ms='` able to find every elapsed time Monica records.
pub(crate) struct Line(String);

impl Line {
    pub(crate) fn new(event: &str) -> Self {
        Line(event.to_owned())
    }

    fn push(&mut self, key: &str, value: &str) {
        self.0.push(' ');
        self.0.push_str(key);
        self.0.push('=');
        self.0.push_str(value);
    }

    /// A free-form value — an id, a repo name, an agent event name. Escaped by [`field`].
    pub(crate) fn id(mut self, key: &str, value: &str) -> Self {
        self.push(key, &field(value));
        self
    }

    /// A number — a count, an issue number, an exit status. Nothing a `Display` integer writes can
    /// break `key=value`, so it goes in unescaped.
    pub(crate) fn num(mut self, key: &str, value: impl std::fmt::Display) -> Self {
        self.push(key, &value.to_string());
        self
    }

    /// One phase inside the operation the line describes, as `<key>_ms`. Never the whole thing —
    /// that is [`Line::duration_ms`], so every timed line answers `rg 'duration_ms='`.
    pub(crate) fn phase_ms(mut self, key: &str, millis: u128) -> Self {
        self.push(&format!("{key}_ms"), &millis.to_string());
        self
    }

    /// How long the whole operation this line describes took.
    pub(crate) fn duration_ms(mut self, millis: u128) -> Self {
        self.push("duration_ms", &millis.to_string());
        self
    }

    /// `{e:#}` output holds newlines and spaces, so it is escaped like any other free-form value —
    /// one processing has to stay one record.
    pub(crate) fn error(mut self, error: &str) -> Self {
        self.push("error", &field(error));
        self
    }

    pub(crate) fn finish(self) -> String {
        self.0
    }
}

fn failure_line(event: &str, ids: &[(&str, &str)], error: &str) -> String {
    ids.iter()
        .fold(Line::new(event), |line, (key, value)| line.id(key, value))
        .error(error)
        .finish()
}

/// A call this crate recovered from, named by the ids it was working on rather than by prose, so
/// the failure lands in the same `rg 'task_run_id=…'` sweep as the transitions around it.
///
/// `error` carries `{e:#}` output, which holds both newlines and spaces, so it goes through
/// [`field`] like every other free-form value.
pub(crate) fn failed(target: &str, event: &str, ids: &[(&str, &str)], error: &str) {
    log::warn!(target: target, "{}", failure_line(event, ids, error));
}

/// [`failed`] for the failures nothing downstream compensates for, so they stay visible at the
/// default level even when someone has turned this crate's target down.
pub(crate) fn fault(target: &str, event: &str, ids: &[(&str, &str)], error: &str) {
    log::error!(target: target, "{}", failure_line(event, ids, error));
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

    const ALL_TARGETS: &[&str] =
        &[LIFECYCLE, HOOK, NOTIFY, TERMINAL, SETTLEMENT, GITHUB, GITHUB_SYNC, WORKTREE_TRASH];

    /// fern matches a target by `::` segment, so a target that does not name this crate is
    /// unreachable from `MONICA_LOG=<crate>=debug`. Anchoring on the package name (not
    /// `CARGO_CRATE_NAME`, which a `[lib] name` override changes) makes a crate rename fail here.
    #[test]
    fn every_target_is_reachable_from_this_crate_name() {
        let crate_name = env!("CARGO_PKG_NAME").replace('-', "_");
        for target in ALL_TARGETS {
            let rest = target.strip_prefix(&crate_name);
            assert!(
                rest.is_some_and(|rest| rest.is_empty() || rest.starts_with("::")),
                "{target} is unreachable from MONICA_LOG={crate_name}=debug"
            );
        }
    }

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
    fn a_skipped_settlement_names_the_run_it_left_alone() {
        assert_eq!(
            run_settle_skipped_line(&run_id(), &task_id(), "session_exit"),
            "run_settle_skipped task_run_id=run-12 task_id=MON-42 cause=session_exit \
             reason=not_live"
        );
    }

    /// The whole point of the shared builder: no timed line can be written without the one key
    /// `rg 'duration_ms='` looks for, and phase breakdowns never impersonate it.
    #[test]
    fn a_timed_line_ends_in_duration_ms_with_the_phases_beside_it() {
        assert_eq!(
            Line::new("bulk_issue_sync")
                .num("refs", 22)
                .num("repos", 3)
                .phase_ms("fetch", 1131)
                .phase_ms("record", 9)
                .duration_ms(1142)
                .finish(),
            "bulk_issue_sync refs=22 repos=3 fetch_ms=1131 record_ms=9 duration_ms=1142"
        );
    }

    #[test]
    fn a_failed_fetch_carries_both_its_duration_and_its_error() {
        assert_eq!(
            Line::new("bulk_pr_fetch_failed")
                .id("repo", "hello-ai/hello_pay")
                .duration_ms(12)
                .error("HTTP 502\n  caused by: bad gateway")
                .finish(),
            "bulk_pr_fetch_failed repo=hello-ai/hello_pay duration_ms=12 \
             error=HTTP_502___caused_by:_bad_gateway"
        );
    }

    #[test]
    fn a_failure_names_its_ids_before_the_error() {
        assert_eq!(
            failure_line("run_settle_failed", &[("session_id", "ts-1865")], "db is locked"),
            "run_settle_failed session_id=ts-1865 error=db_is_locked"
        );
    }

    /// `{e:#}` output is multi-line, and one processing must stay one record.
    #[test]
    fn a_multiline_error_cannot_split_the_failure_line() {
        let line = failure_line(
            "terminal_start_failed",
            &[("session_id", "ts-1")],
            "spawn failed\n  caused by: no such file",
        );
        assert!(!line.contains('\n'), "{line}");
        assert_eq!(
            line,
            "terminal_start_failed session_id=ts-1 \
             error=spawn_failed___caused_by:_no_such_file"
        );
    }

    #[test]
    fn a_failure_carries_every_id_it_was_given() {
        assert_eq!(
            failure_line(
                "run_settle_orphan_failed",
                &[("task_run_id", "run-12"), ("tab_id", "tab-1")],
                "gone",
            ),
            "run_settle_orphan_failed task_run_id=run-12 tab_id=tab-1 error=gone"
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
