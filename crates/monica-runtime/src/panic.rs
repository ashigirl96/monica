//! Routes panics into the log so a release `.app` leaves a trace behind.
//!
//! Release builds run with `panic = "abort"` and are launched from Finder, where stderr goes
//! nowhere — the default hook's message is written to a stream nobody reads and the process is
//! gone a moment later. The hook still runs before the abort, and the file logger flushes every
//! record as it is written, so routing the same information through `log::error!` puts it on disk.

use std::backtrace::{Backtrace, BacktraceStatus};
use std::cell::Cell;

thread_local! {
    static IN_HOOK: Cell<bool> = const { Cell::new(false) };
}

/// Install the panic hook, chaining the one already in place so stderr output survives for `just
/// dev`. Call this as early as possible: the logger does not have to exist yet, because the hook
/// only runs when something panics, and `log::error!` is a no-op until one is installed.
pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A panic raised from inside the logging path would re-enter here while the writer's mutex
        // is still held by this thread, and a second lock on it hangs the process instead of
        // aborting it. Leave the logging to the outer invocation and just chain through.
        let reentrant = IN_HOOK.with(|flag| flag.replace(true));
        if !reentrant {
            let thread = std::thread::current();
            let location = info.location().map(|l| l.to_string());
            log::error!(
                target: "monica_runtime::panic",
                "{}",
                panic_line(
                    thread.name().unwrap_or("unnamed"),
                    location.as_deref(),
                    // `None` only for `panic_any` with a non-string payload, which carries no
                    // text worth guessing at.
                    info.payload_as_str().unwrap_or("<non-string panic payload>"),
                )
            );
            let backtrace = Backtrace::force_capture();
            if backtrace.status() == BacktraceStatus::Captured {
                // Release binaries are stripped, so these are addresses rather than names; they
                // still resolve against the dSYM with `atos`.
                log::error!(target: "monica_runtime::panic", "backtrace:\n{backtrace}");
            }
            IN_HOOK.with(|flag| flag.set(false));
        }
        previous(info);
    }));
}

fn panic_line(thread: &str, location: Option<&str>, message: &str) -> String {
    format!(
        "panic thread={thread} location={} message={message}",
        location.unwrap_or("unknown")
    )
}

#[cfg(test)]
mod tests {
    use super::panic_line;

    #[test]
    fn a_located_panic_carries_its_position() {
        assert_eq!(
            panic_line("monica-github-sync", Some("src/lib.rs:12:5"), "boom"),
            "panic thread=monica-github-sync location=src/lib.rs:12:5 message=boom"
        );
    }

    #[test]
    fn a_panic_without_a_location_still_names_the_thread() {
        assert_eq!(
            panic_line("unnamed", None, "boom"),
            "panic thread=unnamed location=unknown message=boom"
        );
    }
}
