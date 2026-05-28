use std::fs::{self, OpenOptions};
use std::io::Write;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::{paths, Db, Status};

const HOOK_EVENTS_FILE: &str = "hook-events.jsonl";

/// Map a Claude Code hook event name to the work-item status it implies:
/// `SessionStart`→running, `Stop`→stopped, `StopFailure`→failed, `SessionEnd`→stopped. Events
/// Monica does not act on return `None` (they are still recorded, never an error).
pub fn status_for_claude_event(event_name: &str) -> Option<Status> {
    match event_name {
        "SessionStart" => Some(Status::Running),
        "Stop" => Some(Status::Stopped),
        "StopFailure" => Some(Status::Failed),
        "SessionEnd" => Some(Status::Stopped),
        _ => None,
    }
}

/// Statuses that carry an explicit `monica issue mark` signal (or a terminal state) which a generic
/// lifecycle hook must never overwrite: explicit signals win over hook inference, so a
/// `Stop`/`SessionEnd` firing after Claude marked `need_approval` or `pr_open` leaves it intact.
fn explicit_status_wins(current: Status) -> bool {
    matches!(
        current,
        Status::NeedApproval | Status::PrOpen | Status::Done | Status::Archived
    )
}

/// Whether `run_id` is safe to use as a path component under `runs/`. Run ids are minted as
/// `run-<n>`; anything outside `[A-Za-z0-9_.-]`, or `.`/`..`, is rejected so a hostile env var
/// (e.g. `../../etc`) cannot escape the runs directory via [`paths::run_dir`]'s plain join.
pub fn is_safe_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id != "."
        && run_id != ".."
        && !run_id.starts_with('-')
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// What [`record_claude_hook`] did, for the caller to log. Never written to the hook's stdout:
/// Claude Code feeds a `SessionStart` hook's stdout back into its own context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookReport {
    pub event_name: Option<String>,
    pub status: Option<Status>,
    pub work_item_found: bool,
    pub run_linked: bool,
    pub event_recorded: bool,
    pub jsonl_written: bool,
    pub unsafe_run_id: bool,
}

/// Receive a Claude Code hook callback: parse the stdin JSON, append it to the run's
/// `hook-events.jsonl`, record an `events` row, and move the work item (and its run) to the status
/// the event implies. Tolerant by contract — invalid JSON and unknown events are recorded without
/// erroring, so the caller can always exit 0 and never disrupt the Claude session.
///
/// `work_item_id` and `run_id` come from `MONICA_*` env vars and are treated as untrusted input:
/// - `run_id` becomes a path component only when [`is_safe_run_id`]; an id that resolves to a run
///   owned by a *different* work item is a mismatch and is excluded from every run artifact (its
///   jsonl, its status, the `events.run_id` link), so one session cannot pollute another run.
/// - a status implied by the event is applied only when it would not overwrite an explicit
///   `monica issue mark` signal ([`explicit_status_wins`]) — explicit signals win over inference.
pub fn record_claude_hook(
    db: &mut Db,
    work_item_id: Option<&str>,
    run_id: Option<&str>,
    raw_stdin: &str,
) -> Result<HookReport> {
    let parsed: Option<Value> = serde_json::from_str(raw_stdin.trim()).ok();
    let event_name = parsed
        .as_ref()
        .and_then(|v| v.get("hook_event_name"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let safe_run_id = run_id.filter(|&r| is_safe_run_id(r));
    let unsafe_run_id = run_id.is_some() && safe_run_id.is_none();

    let current_status = match work_item_id {
        Some(id) => db.get_work_item(id)?.map(|w| w.status),
        None => None,
    };
    let work_item_found = current_status.is_some();

    // Resolve the run once. It is "linked" only when it exists and belongs to this work item; a
    // path-safe id that resolves to a *different* work item's run is a mismatch and is kept out of
    // every run artifact below.
    let run_row = match safe_run_id {
        Some(r) => db.get_run(r)?,
        None => None,
    };
    let run_linked = match (run_row.as_ref(), work_item_id) {
        (Some(run), Some(wid)) => run.work_item_id == wid,
        _ => false,
    };
    let run_mismatch = run_row.is_some() && !run_linked;
    let linked_run_id = if run_linked { safe_run_id } else { None };

    // jsonl is FK-free and records even a run with no DB row yet, but never a mismatched run's log.
    let mut jsonl_written = false;
    if let Some(run_id) = safe_run_id {
        if !run_mismatch {
            append_jsonl(db, run_id, event_name.as_deref(), &parsed, raw_stdin)?;
            jsonl_written = true;
        }
    }

    let event_recorded = if work_item_found || run_linked {
        let payload = parsed
            .clone()
            .unwrap_or_else(|| json!({ "raw": raw_stdin }));
        db.insert_event(
            work_item_id.filter(|_| work_item_found),
            linked_run_id,
            "claude_hook",
            &payload,
        )?;
        true
    } else {
        false
    };

    // Apply the implied status only when the work item exists and its current status is not an
    // explicit signal a lifecycle hook must preserve.
    let status = match (
        event_name.as_deref().and_then(status_for_claude_event),
        current_status,
    ) {
        (Some(implied), Some(current)) if !explicit_status_wins(current) => Some(implied),
        _ => None,
    };
    if let (Some(status), Some(work_item_id)) = (status, work_item_id) {
        db.apply_hook_status(work_item_id, linked_run_id, status)?;
    }

    Ok(HookReport {
        event_name,
        status,
        work_item_found,
        run_linked,
        event_recorded,
        jsonl_written,
        unsafe_run_id,
    })
}

/// Append one self-describing line `{at, hook_event_name, payload}` to the run's hook-event log.
/// `payload` is the parsed JSON, or `{"raw": <stdin>}` when the input was not valid JSON.
fn append_jsonl(
    db: &Db,
    run_id: &str,
    event_name: Option<&str>,
    parsed: &Option<Value>,
    raw_stdin: &str,
) -> Result<()> {
    let dir = paths::run_dir(run_id)?;
    fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let path = dir.join(HOOK_EVENTS_FILE);

    let payload = parsed
        .clone()
        .unwrap_or_else(|| json!({ "raw": raw_stdin }));
    let mut line = serde_json::to_string(&json!({
        "at": db.now_iso()?,
        "hook_event_name": event_name,
        "payload": payload,
    }))?;
    line.push('\n');

    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .with_context(|| format!("failed to append to {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NewRun, NewWorkItem, WorkItemKind};
    use std::path::PathBuf;

    fn dev_item(db: &mut Db, status: Status) -> String {
        let mut i = NewWorkItem::new(WorkItemKind::Development, "hooked");
        i.status = status;
        db.insert_work_item(i).unwrap().id
    }

    fn new_run(work_item_id: &str) -> NewRun {
        NewRun {
            work_item_id: work_item_id.to_string(),
            agent: None,
            branch: None,
            worktree_path: None,
        }
    }

    /// Each filesystem-touching test points `MONICA_HOME` at a fresh temp dir; the returned guard
    /// serializes against the other `MONICA_HOME` tests (mirrors `run.rs`).
    fn temp_home(tag: &str) -> (std::sync::MutexGuard<'static, ()>, PathBuf) {
        let guard = crate::paths::test_env_guard();
        let dir = std::env::temp_dir().join(format!(
            "monica-hook-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("MONICA_HOME", &dir);
        (guard, dir)
    }

    fn jsonl_for(run_id: &str) -> String {
        fs::read_to_string(paths::run_dir(run_id).unwrap().join(HOOK_EVENTS_FILE)).unwrap()
    }

    // ---- pure helpers ----

    #[test]
    fn status_mapping_covers_the_four_lifecycle_events() {
        assert_eq!(
            status_for_claude_event("SessionStart"),
            Some(Status::Running)
        );
        assert_eq!(status_for_claude_event("Stop"), Some(Status::Stopped));
        assert_eq!(status_for_claude_event("StopFailure"), Some(Status::Failed));
        assert_eq!(status_for_claude_event("SessionEnd"), Some(Status::Stopped));
        assert_eq!(status_for_claude_event("PreToolUse"), None);
        assert_eq!(status_for_claude_event(""), None);
    }

    #[test]
    fn safe_run_id_accepts_run_ids_and_rejects_traversal() {
        assert!(is_safe_run_id("run-1"));
        assert!(is_safe_run_id("run_x"));
        assert!(is_safe_run_id("RUN.1-2_3"));
        assert!(!is_safe_run_id(""));
        assert!(!is_safe_run_id("."));
        assert!(!is_safe_run_id(".."));
        assert!(!is_safe_run_id("../x"));
        assert!(!is_safe_run_id("a/b"));
        assert!(!is_safe_run_id("/abs"));
        assert!(!is_safe_run_id("a b"));
        assert!(!is_safe_run_id("-"));
        assert!(!is_safe_run_id("-rf"));
    }

    // ---- record_claude_hook ----

    /// A `run_id` with no DB row (`run_x`): the work item still moves to stopped, the event records
    /// with a NULL run_id (the FK would otherwise reject it), and the raw event is appended to
    /// `runs/run_x/hook-events.jsonl`.
    #[test]
    fn stop_with_unknown_run_marks_stopped_and_writes_jsonl() {
        let (_g, _home) = temp_home("stop");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_item(&mut db, Status::Running);

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some("run_x"),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert_eq!(report.status, Some(Status::Stopped));
        assert!(report.work_item_found);
        assert!(!report.run_linked, "run_x has no DB row");
        assert!(report.event_recorded);
        assert!(report.jsonl_written);
        assert!(!report.unsafe_run_id);

        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Stopped
        );
        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "claude_hook");
        assert_eq!(events[0].run_id, None, "unknown run must not be FK-linked");

        let jsonl = jsonl_for("run_x");
        assert_eq!(jsonl.lines().count(), 1);
        assert!(jsonl.contains(r#""hook_event_name":"Stop""#), "{jsonl}");

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn session_start_links_matching_run_and_sets_both_running() {
        let (_g, _home) = temp_home("link");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_item(&mut db, Status::Ready);
        let run = db.start_run(new_run(&id)).unwrap(); // both -> setting_up

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some(&run.id),
            r#"{"hook_event_name":"SessionStart"}"#,
        )
        .unwrap();

        assert!(report.run_linked);
        assert_eq!(report.status, Some(Status::Running));
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Running
        );
        assert_eq!(db.get_run(&run.id).unwrap().unwrap().status, Status::Running);

        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(events.last().unwrap().run_id.as_deref(), Some(run.id.as_str()));

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn run_id_of_another_work_item_is_not_linked_or_mutated() {
        let (_g, _home) = temp_home("mismatch");
        let mut db = Db::open_in_memory().unwrap();
        let a = dev_item(&mut db, Status::Ready);
        let run_a = db.start_run(new_run(&a)).unwrap(); // a + run_a -> setting_up
        let b = dev_item(&mut db, Status::Ready);

        let report = record_claude_hook(
            &mut db,
            Some(&b),
            Some(&run_a.id),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert!(!report.run_linked, "run_a belongs to a, not b");
        assert_eq!(db.get_work_item(&b).unwrap().unwrap().status, Status::Stopped);
        assert_eq!(
            db.get_run(&run_a.id).unwrap().unwrap().status,
            Status::SettingUp,
            "another work item's run must be untouched"
        );
        assert_eq!(
            db.get_work_item(&a).unwrap().unwrap().status,
            Status::SettingUp
        );

        assert!(
            !report.jsonl_written,
            "a mismatched run's event log must not be written"
        );
        assert!(
            !paths::run_dir(&run_a.id)
                .unwrap()
                .join(HOOK_EVENTS_FILE)
                .exists(),
            "another work item's run log must stay untouched"
        );

        let events = db.list_events(Some(&b)).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].run_id, None, "mismatched run must not be linked");

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn unsafe_run_id_skips_jsonl_but_still_updates_work_item() {
        let (_g, home) = temp_home("unsafe");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_item(&mut db, Status::Running);

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some("../evil"),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert!(report.unsafe_run_id);
        assert!(!report.jsonl_written);
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Stopped
        );
        // `runs/../evil` would resolve to `<home>/evil`; it must not have been created.
        assert!(
            !home.join("evil").exists(),
            "traversal must not escape the runs dir"
        );

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn invalid_json_is_recorded_without_status_change() {
        let (_g, _home) = temp_home("badjson");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_item(&mut db, Status::Running);

        let report = record_claude_hook(&mut db, Some(&id), Some("run_x"), "not json at all").unwrap();

        assert_eq!(report.event_name, None);
        assert_eq!(report.status, None);
        assert!(report.event_recorded);
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Running,
            "an unparseable hook must not change status"
        );
        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(events[0].payload["raw"], json!("not json at all"));
        assert!(jsonl_for("run_x").contains(r#""raw""#));

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn unknown_event_records_but_leaves_status_and_needs_no_run() {
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_item(&mut db, Status::Running);

        // No run_id at all -> no jsonl, no MONICA_HOME needed.
        let report = record_claude_hook(
            &mut db,
            Some(&id),
            None,
            r#"{"hook_event_name":"PreToolUse"}"#,
        )
        .unwrap();

        assert_eq!(report.event_name.as_deref(), Some("PreToolUse"));
        assert_eq!(report.status, None);
        assert!(report.event_recorded);
        assert!(!report.jsonl_written);
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Running
        );
    }

    #[test]
    fn unknown_work_item_is_graceful() {
        let (_g, _home) = temp_home("nowork");
        let mut db = Db::open_in_memory().unwrap();

        let report = record_claude_hook(
            &mut db,
            Some("MON-999"),
            Some("run_x"),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert!(!report.work_item_found);
        assert!(!report.event_recorded, "no work item & no linked run -> no event row");
        assert!(report.jsonl_written, "jsonl still records the raw event");
        assert_eq!(report.status, None);
        assert!(db.list_events(None).unwrap().is_empty());

        std::env::remove_var("MONICA_HOME");
    }

    /// A hook firing in a session Monica did not start (no `MONICA_*` env) must be a complete
    /// no-op: nothing written, nothing recorded, no error.
    #[test]
    fn no_env_vars_is_fully_silent() {
        let mut db = Db::open_in_memory().unwrap();
        let report =
            record_claude_hook(&mut db, None, None, r#"{"hook_event_name":"Stop"}"#).unwrap();
        assert!(!report.work_item_found);
        assert!(!report.run_linked);
        assert!(!report.event_recorded);
        assert!(!report.jsonl_written);
        assert!(!report.unsafe_run_id);
        assert_eq!(report.status, None);
        assert!(db.list_events(None).unwrap().is_empty());
    }

    /// Valid JSON missing the `hook_event_name` key (e.g. `{}`) is recorded verbatim but implies no
    /// status — distinct from unparseable input, where the payload is wrapped as `{"raw": ...}`.
    #[test]
    fn valid_json_without_event_name_records_and_leaves_status() {
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_item(&mut db, Status::Running);
        let report =
            record_claude_hook(&mut db, Some(&id), None, r#"{"some_other_key":1}"#).unwrap();
        assert_eq!(report.event_name, None);
        assert_eq!(report.status, None);
        assert!(report.event_recorded);
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::Running
        );
        let events = db.list_events(Some(&id)).unwrap();
        assert_eq!(events[0].payload, json!({ "some_other_key": 1 }));
    }

    #[test]
    fn explicit_and_terminal_statuses_resist_hook_overwrite() {
        for s in [
            Status::NeedApproval,
            Status::PrOpen,
            Status::Done,
            Status::Archived,
        ] {
            assert!(explicit_status_wins(s), "{s:?} must be protected");
        }
        for s in [
            Status::Inbox,
            Status::Ready,
            Status::SettingUp,
            Status::Running,
            Status::Stopped,
            Status::Failed,
        ] {
            assert!(!explicit_status_wins(s), "{s:?} must stay hook-writable");
        }
    }

    /// The core of the explicit-signal contract: a `Stop` firing after Claude marked `need_approval`
    /// must record the event but leave the status at `need_approval`, not downgrade it to stopped.
    #[test]
    fn stop_does_not_overwrite_an_explicit_mark() {
        let (_g, _home) = temp_home("explicit");
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_item(&mut db, Status::NeedApproval);

        let report = record_claude_hook(
            &mut db,
            Some(&id),
            Some("run_x"),
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();

        assert_eq!(report.status, None, "the hook must not apply a status here");
        assert!(report.event_recorded, "the event is still recorded");
        assert!(report.jsonl_written);
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::NeedApproval,
            "an explicit mark must survive the Stop hook"
        );

        std::env::remove_var("MONICA_HOME");
    }

    #[test]
    fn session_end_does_not_overwrite_pr_open() {
        let mut db = Db::open_in_memory().unwrap();
        let id = dev_item(&mut db, Status::PrOpen);

        // No run_id, so no jsonl/path access and no MONICA_HOME needed.
        let report = record_claude_hook(
            &mut db,
            Some(&id),
            None,
            r#"{"hook_event_name":"SessionEnd"}"#,
        )
        .unwrap();

        assert_eq!(report.status, None);
        assert!(report.event_recorded);
        assert_eq!(
            db.get_work_item(&id).unwrap().unwrap().status,
            Status::PrOpen
        );
    }
}
