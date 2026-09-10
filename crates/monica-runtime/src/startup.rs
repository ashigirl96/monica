//! The one line that says which build wrote the rest of the file.
//!
//! Dev and release binaries share `~/monica/logs/monica.log` layout but not their data directory,
//! so a log read after the fact is ambiguous about which build produced it and which `MONICA_HOME`
//! it was pointed at. Emitting the whole set once per process start resolves that.

use std::path::Path;

struct StartupFacts<'a> {
    version: &'a str,
    git_sha: &'a str,
    profile: &'a str,
    monica_home: &'a Path,
    db: &'a Path,
    ptyd_sock: &'a Path,
}

/// `key=value` throughout, so one field can be pulled back out with `rg 'monica_home=…'`. The web
/// port is deliberately absent: `monica_web` logs it on binding, and waiting for it here would push
/// the banner behind that bind's timeout and off the head of the file.
fn banner_line(facts: &StartupFacts) -> String {
    format!(
        "startup version={} git_sha={} profile={} monica_home={} db={} ptyd_sock={}",
        facts.version,
        facts.git_sha,
        facts.profile,
        facts.monica_home.display(),
        facts.db.display(),
        facts.ptyd_sock.display(),
    )
}

/// Resolve the paths and log the banner. A path that cannot be resolved is reported as `unknown`
/// rather than skipping the line — a startup whose `MONICA_HOME` is unreadable is exactly when the
/// banner is worth the most.
pub fn log_startup_banner(version: &str, git_sha: &str) {
    let unknown = || std::path::PathBuf::from("unknown");
    let monica_home = monica_paths::base_dir().unwrap_or_else(|_| unknown());
    let db = monica_paths::db_path().unwrap_or_else(|_| unknown());
    let ptyd_sock = monica_paths::ptyd_socket_path().unwrap_or_else(|_| unknown());
    log::info!(
        target: "monica_runtime::startup",
        "{}",
        banner_line(&StartupFacts {
            version,
            git_sha,
            profile: if cfg!(debug_assertions) { "dev" } else { "release" },
            monica_home: &monica_home,
            db: &db,
            ptyd_sock: &ptyd_sock,
        })
    );
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{banner_line, StartupFacts};

    #[test]
    fn every_fact_lands_as_a_key_value_pair() {
        let facts = StartupFacts {
            version: "0.1.0",
            git_sha: "abc1234",
            profile: "release",
            monica_home: Path::new("/Users/x/monica"),
            db: Path::new("/Users/x/monica/db/monica.db"),
            ptyd_sock: Path::new("/Users/x/monica/ptyd.sock"),
        };
        assert_eq!(
            banner_line(&facts),
            "startup version=0.1.0 git_sha=abc1234 profile=release \
             monica_home=/Users/x/monica db=/Users/x/monica/db/monica.db \
             ptyd_sock=/Users/x/monica/ptyd.sock"
        );
    }
}
