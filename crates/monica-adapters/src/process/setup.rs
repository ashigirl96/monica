use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use monica_application::{SetupEnv, SetupOutcome, SetupRunner};

const SETUP_SCRIPT_REL: &str = ".monica/setup.sh";
const SETUP_POLL_INTERVAL: Duration = Duration::from_millis(50);

static INTERRUPT_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Stop the setup script this process is running, if any: it is killed with its whole process
/// group and reported as failed. Only touches an atomic, so it is safe to call from a signal
/// handler.
pub fn request_setup_interrupt() {
    INTERRUPT_REQUESTED.store(true, Ordering::SeqCst);
}

fn take_interrupt_request() -> bool {
    INTERRUPT_REQUESTED.swap(false, Ordering::SeqCst)
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessSetupRunner;

impl SetupRunner for ProcessSetupRunner {
    fn run_setup_script(
        &self,
        worktree: &Path,
        log_path: &Path,
        env: &SetupEnv,
        timeout: Duration,
    ) -> Result<SetupOutcome> {
        run_setup_script(worktree, log_path, env, timeout)
    }
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
        .env("MONICA_TASK_ID", &env.monica_id)
        .env("MONICA_TASK_RUN_ID", &env.task_run_id)
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
        if take_interrupt_request() {
            return kill_setup(
                &mut child,
                log_path,
                "monica: setup interrupted; killed\n",
                false,
            );
        }
        if start.elapsed() >= timeout {
            return kill_setup(
                &mut child,
                log_path,
                &format!("monica: setup timed out after {timeout:?}; killed\n"),
                true,
            );
        }
        thread::sleep(SETUP_POLL_INTERVAL);
    }
}

fn kill_setup(
    child: &mut Child,
    log_path: &Path,
    note: &str,
    timed_out: bool,
) -> Result<SetupOutcome> {
    terminate_setup_process_tree(child.id())?;
    // The script may have exited on its own between the last `try_wait` and now; if so, honor its
    // real status rather than reporting a spurious kill.
    if let Ok(status) = child.wait() {
        if status.success() {
            return Ok(SetupOutcome::Succeeded);
        }
    }
    append_log(log_path, note)?;
    Ok(SetupOutcome::Failed {
        code: None,
        timed_out,
    })
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn worktree_with_setup(name: &str, script: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monica-setup-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".monica")).unwrap();
        let path = dir.join(SETUP_SCRIPT_REL);
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    fn env() -> SetupEnv {
        SetupEnv {
            monica_id: "MON-1".into(),
            task_run_id: "run-1".into(),
            project_id: "proj".into(),
            branch: "1".into(),
            worktree: "/wt".into(),
        }
    }

    #[test]
    fn an_interrupt_request_kills_the_script_and_reports_a_plain_failure() {
        let worktree = worktree_with_setup("interrupt", "#!/bin/sh\nsleep 30\n");
        let log_path = worktree.join("setup.log");
        thread::spawn(|| {
            thread::sleep(Duration::from_millis(200));
            request_setup_interrupt();
        });

        let started = Instant::now();
        let outcome = run_setup_script(&worktree, &log_path, &env(), Duration::from_secs(30)).unwrap();

        assert_eq!(
            outcome,
            SetupOutcome::Failed {
                code: None,
                timed_out: false
            }
        );
        assert!(started.elapsed() < Duration::from_secs(10), "the script was not killed");
        assert!(fs::read_to_string(&log_path).unwrap().contains("setup interrupted"));
        let _ = fs::remove_dir_all(&worktree);
    }

    #[test]
    fn a_script_that_exits_on_its_own_is_not_interrupted() {
        let worktree = worktree_with_setup("exit-zero", "#!/bin/sh\nexit 0\n");
        let log_path = worktree.join("setup.log");

        let outcome = run_setup_script(&worktree, &log_path, &env(), Duration::from_secs(30)).unwrap();

        assert_eq!(outcome, SetupOutcome::Succeeded);
        let _ = fs::remove_dir_all(&worktree);
    }
}
