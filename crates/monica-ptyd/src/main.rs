use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};
use monica_pty::daemon::{run_daemon, DaemonConfig};

/// Mirrors monica-infra's `paths::base_dir()`. Deliberately not a dependency: the daemon
/// must stay decoupled from the app's SQLite schema lifecycle so an old daemon binary can
/// keep serving sessions across app upgrades without ever running migrations.
fn base_dir() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("MONICA_HOME") {
        return Ok(PathBuf::from(home));
    }
    let home =
        std::env::var_os("HOME").ok_or_else(|| anyhow!("neither MONICA_HOME nor HOME is set"))?;
    Ok(PathBuf::from(home).join("monica"))
}

struct WriterLogger {
    writer: Mutex<Box<dyn Write + Send>>,
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
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writeln!(
                writer,
                "[{}.{:03}] {} {}",
                elapsed.as_secs(),
                elapsed.subsec_millis(),
                record.level(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

fn init_logging(base: &std::path::Path, foreground: bool) -> Result<()> {
    let writer: Box<dyn Write + Send> = if foreground {
        Box::new(std::io::stderr())
    } else {
        let logs_dir = base.join("logs");
        std::fs::create_dir_all(&logs_dir)?;
        Box::new(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(logs_dir.join("ptyd.log"))?,
        )
    };
    log::set_boxed_logger(Box::new(WriterLogger {
        writer: Mutex::new(writer),
    }))
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
