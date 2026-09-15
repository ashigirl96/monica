use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};
use monica_logfile::DailyLog;
use monica_terminal_daemon::daemon::{run_daemon, DaemonConfig};

/// Mirrors `monica-paths`'s `base_dir()`. Deliberately not a dependency: the daemon must stay a
/// standalone binary that an old build can keep serving sessions across app upgrades, never coupled
/// to the rest of the workspace's lifecycle.
fn base_dir() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("MONICA_HOME") {
        return Ok(PathBuf::from(home));
    }
    let home =
        std::env::var_os("HOME").ok_or_else(|| anyhow!("neither MONICA_HOME nor HOME is set"))?;
    Ok(PathBuf::from(home).join("monica"))
}

enum Sink {
    Stderr,
    Daily(DailyLog),
}

impl Sink {
    /// `line` carries no trailing newline: [`DailyLog::append`] adds its own, and writing one line
    /// per call is what keeps concurrent appends from interleaving mid-line.
    fn write_line(&self, line: &str) {
        match self {
            Self::Stderr => {
                let _ = writeln!(std::io::stderr().lock(), "{line}");
            }
            Self::Daily(log) => log.append(line),
        }
    }
}

struct WriterLogger {
    sink: Sink,
}

impl log::Log for WriterLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        self.sink
            .write_line(&format_line(elapsed, record.level(), record.args()));
    }

    fn flush(&self) {}
}

fn format_line(elapsed: Duration, level: log::Level, args: &std::fmt::Arguments) -> String {
    format!(
        "[{}.{:03}] {level} {args}",
        elapsed.as_secs(),
        elapsed.subsec_millis(),
    )
}

fn init_logging(base: &std::path::Path, foreground: bool) -> Result<()> {
    let sink = if foreground {
        Sink::Stderr
    } else {
        Sink::Daily(DailyLog::open(&base.join("logs"), "ptyd")?)
    };
    log::set_boxed_logger(Box::new(WriterLogger { sink }))
        .map_err(|e| anyhow!("failed to install logger: {e}"))?;
    log::set_max_level(log::LevelFilter::Info);
    Ok(())
}

fn main() -> Result<()> {
    let mut base: Option<PathBuf> = None;
    let mut foreground = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--monica-home" => {
                let path = args
                    .next()
                    .ok_or_else(|| anyhow!("--monica-home requires a path"))?;
                base = Some(PathBuf::from(path));
            }
            "--foreground" => foreground = true,
            other => bail!("unknown argument: {other}"),
        }
    }
    let base = match base {
        Some(base) => base,
        None => base_dir()?,
    };
    std::fs::create_dir_all(&base)?;
    init_logging(&base, foreground)?;

    if !foreground {
        // Detach from the launching app's session so quitting Monica (or the shell that
        // spawned us) never HUPs the daemon. setsid fails iff we're already a group
        // leader, in which case ignoring SIGHUP is the part that matters.
        unsafe {
            libc::setsid();
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
        }
    }

    run_daemon(DaemonConfig {
        socket_path: base.join("ptyd.sock"),
        pid_path: base.join("ptyd.pid"),
        sessions_dir: base.join("terminal-sessions"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_line_keeps_the_established_shape() {
        assert_eq!(
            format_line(
                Duration::from_millis(12_007),
                log::Level::Info,
                &format_args!("listening on {}", "/tmp/ptyd.sock"),
            ),
            "[12.007] INFO listening on /tmp/ptyd.sock",
        );
    }

    /// Both sinks add their own line terminator, so one here would double it in the file.
    #[test]
    fn format_line_carries_no_trailing_newline() {
        let line = format_line(Duration::ZERO, log::Level::Warn, &format_args!("busy"));
        assert_eq!(line, "[0.000] WARN busy");
    }
}
