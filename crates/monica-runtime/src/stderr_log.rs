//! A logger for the processes that have none. The desktop app gets one from `tauri-plugin-log`;
//! the CLI had nothing at all, so every `log::*` call the adapters make while `monica task run`
//! creates a worktree or runs a setup script was dropped on the floor.
//!
//! Lines go to stderr, never stdout: stdout is the CLI's answer and has to stay machine-readable.
//!
//! `MONICA_LOG` means the same thing here as it does in the desktop app — same parser
//! ([`crate::log_filter`]), and the same `::`-segment target matching fern does, so
//! `MONICA_LOG=monica_adapters=debug` selects the same lines in both.

use std::io::Write;

use log::{LevelFilter, Log, Metadata, Record};

use crate::log_filter::{self, LogFilter};

/// Install the logger, unless this process already has one. `fallback` is the level used when
/// neither `MONICA_LOG` nor `RUST_LOG` says otherwise.
pub fn install(fallback: LevelFilter) {
    let mut filter = log_filter::from_env(fallback);
    // A typo must not keep the command from running, but it cannot be swallowed either — and it
    // cannot be reported through the logger it is misconfiguring: `monica hook` falls back to
    // `Off`, so a spec of `bogus` leaves a ceiling that discards this very warning. It goes
    // straight to stderr, which is where the logger would have put it anyway.
    for line in unknown_filter_notices(&filter.unknown) {
        let _ = writeln!(std::io::stderr(), "{line}");
    }
    filter.unknown.clear();

    let ceiling = ceiling(&filter);
    if log::set_boxed_logger(Box::new(StderrLogger { filter })).is_ok() {
        log::set_max_level(ceiling);
    }
}

fn unknown_filter_notices(unknown: &[String]) -> Vec<String> {
    unknown
        .iter()
        .map(|token| format!("WARN monica_runtime::startup ignoring unparsable log filter {token:?}"))
        .collect()
}

struct StderrLogger {
    filter: LogFilter,
}

impl Log for StderrLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= level_for(&self.filter, metadata.target())
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // A failed write has nowhere left to be reported.
        let _ = writeln!(
            std::io::stderr(),
            "{} {} {}",
            record.level(),
            record.target(),
            record.args()
        );
    }

    fn flush(&self) {
        let _ = std::io::stderr().flush();
    }
}

/// The global gate the `log!` macros check before a record ever reaches [`Log::enabled`]. It has to
/// clear the most verbose override, or a per-target `debug` above a quieter default never arrives.
fn ceiling(filter: &LogFilter) -> LevelFilter {
    filter
        .targets
        .iter()
        .map(|(_, level)| *level)
        .chain(std::iter::once(filter.default))
        .max()
        .unwrap_or(filter.default)
}

/// The most specific override covering `target`, or the default. Longest match wins, so
/// `monica_adapters=warn,monica_adapters::git=debug` leaves git alone at debug.
fn level_for(filter: &LogFilter, target: &str) -> LevelFilter {
    filter
        .targets
        .iter()
        .filter(|(candidate, _)| covers(candidate, target))
        .max_by_key(|(candidate, _)| candidate.len())
        .map_or(filter.default, |(_, level)| *level)
}

/// Targets nest by `::` segment, not by prefix: `monica_adapters` covers `monica_adapters::git`
/// while `monica_adapt` covers nothing.
fn covers(filter_target: &str, target: &str) -> bool {
    target == filter_target
        || (target
            .strip_prefix(filter_target)
            .is_some_and(|rest| rest.starts_with("::")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(spec: &str) -> LogFilter {
        log_filter::parse(spec, LevelFilter::Warn)
    }

    #[test]
    fn a_target_covers_its_own_segments_but_not_a_shared_prefix() {
        assert!(covers("monica_adapters", "monica_adapters"));
        assert!(covers("monica_adapters", "monica_adapters::git"));
        assert!(!covers("monica_adapt", "monica_adapters::git"));
        assert!(!covers("monica_adapters::git", "monica_adapters"));
    }

    #[test]
    fn an_unmatched_target_falls_back_to_the_default() {
        let filter = filter("info,monica_adapters=debug");
        assert_eq!(level_for(&filter, "monica_application"), LevelFilter::Info);
        assert_eq!(level_for(&filter, "monica_adapters::git"), LevelFilter::Debug);
    }

    #[test]
    fn the_most_specific_override_wins_regardless_of_the_order_it_was_written() {
        let filter = filter("monica_adapters::git=debug,monica_adapters=error");
        assert_eq!(level_for(&filter, "monica_adapters::git"), LevelFilter::Debug);
        assert_eq!(level_for(&filter, "monica_adapters::gh"), LevelFilter::Error);
    }

    /// Without this the macros drop a per-target `debug` before the logger is ever consulted.
    #[test]
    fn the_ceiling_clears_the_most_verbose_override() {
        assert_eq!(ceiling(&filter("error,monica_adapters=debug")), LevelFilter::Debug);
        assert_eq!(ceiling(&filter("info")), LevelFilter::Info);
        assert_eq!(ceiling(&filter("")), LevelFilter::Warn);
    }

    /// `monica hook` falls back to `Off`, which would otherwise discard the one warning that says
    /// why nothing is being logged.
    #[test]
    fn an_unparsable_token_is_reported_even_when_the_filter_silences_everything() {
        let filter = log_filter::parse("bogus", LevelFilter::Off);
        assert_eq!(ceiling(&filter), LevelFilter::Off);

        let notices = unknown_filter_notices(&filter.unknown);
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("\"bogus\""));
    }

    #[test]
    fn a_well_formed_filter_produces_no_notices() {
        assert!(unknown_filter_notices(&filter("info,monica_adapters=debug").unknown).is_empty());
    }

    #[test]
    fn off_silences_a_target_without_lowering_the_ceiling_for_the_rest() {
        let filter = filter("debug,monica_adapters=off");
        assert_eq!(level_for(&filter, "monica_adapters::git"), LevelFilter::Off);
        assert_eq!(level_for(&filter, "monica_application"), LevelFilter::Debug);
        assert_eq!(ceiling(&filter), LevelFilter::Debug);
    }
}
