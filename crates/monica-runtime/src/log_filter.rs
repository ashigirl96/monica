//! `MONICA_LOG` / `RUST_LOG` parsing, so a build that is already installed can be made to talk
//! without being rebuilt.
//!
//! The spec is a comma-separated list where a bare level sets the default and `target=level` sets
//! one override, matching the shape people already expect from `RUST_LOG`. Targets are matched
//! against `log::Record::target()` by the logger, and Monica names those explicitly
//! (`monica_application::github_sync`), so `MONICA_LOG=info,monica_application=debug` selects a
//! whole crate's worth of lines.

use log::LevelFilter;

pub struct LogFilter {
    pub default: LevelFilter,
    pub targets: Vec<(String, LevelFilter)>,
    /// Tokens that parsed as neither a level nor a `target=level` pair. A typo must not keep the
    /// app from starting, but it must not be swallowed either — the caller warns once the logger
    /// is up, which is the earliest anything can be said at all.
    pub unknown: Vec<String>,
}

/// Read the spec from `MONICA_LOG`, falling back to `RUST_LOG` and then to `fallback`. An empty or
/// whitespace-only value counts as unset so `MONICA_LOG= ` does not silence the app.
pub fn from_env(fallback: LevelFilter) -> LogFilter {
    let spec = ["MONICA_LOG", "RUST_LOG"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.trim().is_empty()));
    parse(spec.as_deref().unwrap_or(""), fallback)
}

pub fn parse(spec: &str, fallback: LevelFilter) -> LogFilter {
    let mut filter = LogFilter { default: fallback, targets: Vec::new(), unknown: Vec::new() };
    for token in spec.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        let (target, level) = match token.split_once('=') {
            Some((target, level)) => (Some(target.trim()), level),
            None => (None, token),
        };
        match (target, level.trim().parse::<LevelFilter>().ok()) {
            (Some(""), _) | (_, None) => filter.unknown.push(token.to_string()),
            (Some(target), Some(level)) => filter.targets.push((target.to_string(), level)),
            (None, Some(level)) => filter.default = level,
        }
    }
    filter
}

#[cfg(test)]
mod tests {
    use super::{parse, LevelFilter};

    #[test]
    fn an_empty_spec_keeps_the_fallback() {
        let f = parse("", LevelFilter::Info);
        assert_eq!(f.default, LevelFilter::Info);
        assert!(f.targets.is_empty());
        assert!(f.unknown.is_empty());
    }

    #[test]
    fn a_bare_level_replaces_the_default() {
        assert_eq!(parse("debug", LevelFilter::Info).default, LevelFilter::Debug);
    }

    #[test]
    fn levels_are_case_insensitive() {
        assert_eq!(parse("WARN", LevelFilter::Info).default, LevelFilter::Warn);
        assert_eq!(parse("TrAcE", LevelFilter::Info).default, LevelFilter::Trace);
    }

    #[test]
    fn a_target_pair_becomes_an_override() {
        let f = parse("monica_runtime::panic=trace", LevelFilter::Info);
        assert_eq!(f.default, LevelFilter::Info);
        assert_eq!(f.targets, vec![("monica_runtime::panic".to_string(), LevelFilter::Trace)]);
    }

    #[test]
    fn a_default_and_overrides_mix() {
        let f = parse("warn,monica_application=debug,monica_web=trace", LevelFilter::Info);
        assert_eq!(f.default, LevelFilter::Warn);
        assert_eq!(
            f.targets,
            vec![
                ("monica_application".to_string(), LevelFilter::Debug),
                ("monica_web".to_string(), LevelFilter::Trace),
            ]
        );
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        let f = parse("  info , monica_web = debug ", LevelFilter::Warn);
        assert_eq!(f.default, LevelFilter::Info);
        assert_eq!(f.targets, vec![("monica_web".to_string(), LevelFilter::Debug)]);
    }

    #[test]
    fn empty_segments_are_skipped() {
        let f = parse(",,debug,,", LevelFilter::Info);
        assert_eq!(f.default, LevelFilter::Debug);
        assert!(f.unknown.is_empty());
    }

    /// A typo must cost the user only that one token, never the rest of the spec and never startup.
    #[test]
    fn unknown_tokens_are_collected_without_breaking_the_rest() {
        let f = parse("debug,monica_web=lowd,nonsense,monica_api=warn", LevelFilter::Info);
        assert_eq!(f.default, LevelFilter::Debug);
        assert_eq!(f.targets, vec![("monica_api".to_string(), LevelFilter::Warn)]);
        assert_eq!(f.unknown, vec!["monica_web=lowd".to_string(), "nonsense".to_string()]);
    }

    #[test]
    fn a_pair_without_a_target_is_unknown() {
        let f = parse("=debug", LevelFilter::Info);
        assert_eq!(f.default, LevelFilter::Info);
        assert!(f.targets.is_empty());
        assert_eq!(f.unknown, vec!["=debug".to_string()]);
    }

    #[test]
    fn the_last_bare_level_wins() {
        assert_eq!(parse("debug,warn", LevelFilter::Info).default, LevelFilter::Warn);
    }

    #[test]
    fn off_is_a_level() {
        assert_eq!(parse("off", LevelFilter::Info).default, LevelFilter::Off);
    }
}
