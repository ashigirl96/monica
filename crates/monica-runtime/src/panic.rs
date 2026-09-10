//! Routes panics into a log file so a release `.app` leaves a trace behind.
//!
//! Release builds run with `panic = "abort"` and are launched from Finder, where stderr goes
//! nowhere — the default hook's message is written to a stream nobody reads and the process is gone
//! a moment later.
//!
//! The record deliberately does **not** go through `log::*`. fern evaluates a record's arguments
//! while holding its writer mutex, so a panic raised inside any logging call would re-enter this
//! hook with that mutex still held on this thread; logging from here would then block on a
//! non-reentrant lock and hang the process instead of aborting it. Writing to an own file keeps
//! the crash path independent of the logging stack — and works before the logger exists at all,
//! which covers panics in the earliest moments of startup.
//!
//! [`DailyLog`] rather than `monica.log` because a crash record has to still be there when someone
//! comes looking: `monica.log` is capped by size and has burned all five of its generations inside
//! a single day, while this rotates daily and keeps a fortnight.

use std::backtrace::{Backtrace, BacktraceStatus};
use std::cell::Cell;

use monica_logfile::DailyLog;

thread_local! {
    static IN_HOOK: Cell<bool> = const { Cell::new(false) };
}

/// Install the panic hook, chaining the one already in place so stderr output survives for `just
/// dev`. Call this as early as possible; it needs nothing else to be initialized first. Panics are
/// recorded to `<MONICA_HOME>/logs/panic_<date>.log`, or only to the chained hook if that file
/// cannot be opened.
pub fn install() {
    let log = monica_paths::logs_dir()
        .ok()
        .and_then(|dir| DailyLog::open(&dir, "panic").ok());
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Only guards against this hook's own writing path panicking and recursing; a first panic
        // from anywhere else always gets recorded.
        let reentrant = IN_HOOK.with(|flag| flag.replace(true));
        if !reentrant {
            if let Some(log) = &log {
                let thread = std::thread::current();
                let location = info.location().map(|l| l.to_string());
                // One append so the record and its backtrace cannot be split by another writer.
                log.append(&panic_record(
                    &now(),
                    thread.name().unwrap_or("unnamed"),
                    location.as_deref(),
                    // `None` only for `panic_any` with a non-string payload, which carries no text
                    // worth guessing at.
                    info.payload_as_str().unwrap_or("<non-string panic payload>"),
                    backtrace().as_deref(),
                ));
            }
            IN_HOOK.with(|flag| flag.set(false));
        }
        previous(info);
    }));
}

/// `None` when the platform captured nothing. Release binaries are stripped, so a captured trace is
/// addresses rather than names; they still resolve against the dSYM with `atos`.
fn backtrace() -> Option<String> {
    let backtrace = Backtrace::force_capture();
    (backtrace.status() == BacktraceStatus::Captured).then(|| backtrace.to_string())
}

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
}

fn panic_record(
    at: &str,
    thread: &str,
    location: Option<&str>,
    message: &str,
    backtrace: Option<&str>,
) -> String {
    let mut record = format!(
        "{at} panic thread={thread} location={} message={message}",
        location.unwrap_or("unknown")
    );
    if let Some(backtrace) = backtrace {
        record.push_str("\nbacktrace:\n");
        record.push_str(backtrace);
    }
    record
}

#[cfg(test)]
mod tests {
    use super::panic_record;

    const AT: &str = "2026-09-10T11:07:00.123";

    #[test]
    fn a_located_panic_carries_its_position() {
        assert_eq!(
            panic_record(AT, "monica-github-sync", Some("src/lib.rs:12:5"), "boom", None),
            "2026-09-10T11:07:00.123 panic thread=monica-github-sync \
             location=src/lib.rs:12:5 message=boom"
        );
    }

    #[test]
    fn a_panic_without_a_location_still_names_the_thread() {
        assert_eq!(
            panic_record(AT, "unnamed", None, "boom", None),
            "2026-09-10T11:07:00.123 panic thread=unnamed location=unknown message=boom"
        );
    }

    /// The backtrace rides along in the same record so a concurrent writer cannot land between the
    /// panic line and its frames.
    #[test]
    fn a_captured_backtrace_joins_the_same_record() {
        let record =
            panic_record(AT, "main", Some("src/lib.rs:1:1"), "boom", Some("frame"));
        assert_eq!(
            record,
            "2026-09-10T11:07:00.123 panic thread=main location=src/lib.rs:1:1 \
             message=boom\nbacktrace:\nframe"
        );
    }
}
