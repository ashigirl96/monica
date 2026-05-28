use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

const SETUP_SCRIPT_REL: &str = ".monica/setup.sh";
const SETUP_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupOutcome {
    /// No `.monica/setup.sh` in the worktree; setup was skipped.
    Skipped,
    Succeeded,
    Failed {
        code: Option<i32>,
        timed_out: bool,
    },
}

impl SetupOutcome {
    pub fn is_failure(&self) -> bool {
        matches!(self, SetupOutcome::Failed { .. })
    }
}

/// Environment handed to `.monica/setup.sh`.
pub struct SetupEnv {
    pub monica_id: String,
    pub run_id: String,
    pub project_id: String,
    pub branch: String,
    pub worktree: String,
}

/// Run the worktree's `.monica/setup.sh` (if present), streaming stdout+stderr to `log_path` and
/// enforcing `timeout`. Absent script → [`SetupOutcome::Skipped`]. The script is executed directly
/// so its shebang and executable bit (committed by convention) are honored.
pub fn run_setup_script(
    worktree: &Path,
    log_path: &Path,
    env: &SetupEnv,
    timeout: Duration,
) -> Result<SetupOutcome> {
    let script = worktree.join(SETUP_SCRIPT_REL);
    if !script.is_file() {
        write_log(
            log_path,
            &format!("monica: no {SETUP_SCRIPT_REL}; setup skipped\n"),
        )?;
        return Ok(SetupOutcome::Skipped);
    }

    let log = File::create(log_path)
        .with_context(|| format!("failed to create {}", log_path.display()))?;
    let log_err = log.try_clone()?;

    let mut command = Command::new(&script);
    #[cfg(unix)]
    command.process_group(0);

    let spawned = command
        .current_dir(worktree)
        .env("MONICA_ID", &env.monica_id)
        .env("MONICA_RUN_ID", &env.run_id)
        .env("MONICA_PROJECT_ID", &env.project_id)
        .env("MONICA_BRANCH", &env.branch)
        .env("MONICA_WORKTREE", &env.worktree)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            append_log(
                log_path,
                &format!("monica: failed to spawn {SETUP_SCRIPT_REL}: {e}\n"),
            )?;
            return Ok(SetupOutcome::Failed {
                code: None,
                timed_out: false,
            });
        }
    };

    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(if status.success() {
                SetupOutcome::Succeeded
            } else {
                SetupOutcome::Failed {
                    code: status.code(),
                    timed_out: false,
                }
            });
        }
        if start.elapsed() >= timeout {
            terminate_setup_process_tree(child.id())?;
            // The script may have exited on its own between the `try_wait` above and now; if so,
            // honor its real status rather than reporting a spurious timeout.
            if let Ok(status) = child.wait() {
                if status.success() {
                    return Ok(SetupOutcome::Succeeded);
                }
            }
            append_log(
                log_path,
                &format!("monica: setup timed out after {timeout:?}; killed\n"),
            )?;
            return Ok(SetupOutcome::Failed {
                code: None,
                timed_out: true,
            });
        }
        thread::sleep(SETUP_POLL_INTERVAL);
    }
}

pub(super) fn terminate_setup_process_tree(pid: u32) -> Result<()> {
    #[cfg(unix)]
    {
        let pgid = format!("-{pid}");
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(&pgid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(&pgid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        Ok(())
    }

    #[cfg(not(unix))]
    {
        let pid = pid.to_string();
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID"])
            .arg(&pid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        Ok(())
    }
}

fn write_log(log_path: &Path, note: &str) -> Result<()> {
    fs::write(log_path, note).with_context(|| format!("failed to write {}", log_path.display()))
}

fn append_log(log_path: &Path, note: &str) -> Result<()> {
    OpenOptions::new()
        .append(true)
        .open(log_path)
        .and_then(|mut f| f.write_all(note.as_bytes()))
        .with_context(|| format!("failed to append to {}", log_path.display()))
}
