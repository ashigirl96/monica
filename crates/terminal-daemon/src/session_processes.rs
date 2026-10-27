//! Terminal Session Process (ADR-0040): a process whose session id is its Terminal Session's
//! shell pid. The shell leads its session, so its jobs and nohup children stay in it even after
//! the shell is gone; a setsid child leaves it.

use std::collections::HashSet;
use std::time::Duration;

use anyhow::{bail, Context};
use libc::pid_t;
use monica_terminal_protocol::ProcessInfo;

/// Long enough for a claude that got SIGHUP with its shell to finish its SessionEnd hook.
const TERM_AFTER: Duration = Duration::from_secs(2);
/// Time for a process that heeds SIGTERM to clean up.
const KILL_AFTER: Duration = Duration::from_secs(5);

/// Blocks for the whole grace period; call it from the thread that reaped the shell.
pub(crate) fn end_terminal_session_processes(shell: pid_t) {
    std::thread::sleep(TERM_AFTER);
    signal_terminal_session_processes(shell, libc::SIGTERM);
    std::thread::sleep(KILL_AFTER);
    signal_terminal_session_processes(shell, libc::SIGKILL);
}

fn terminal_session_processes(
    shell: pid_t,
    shell_running: bool,
    table: &[ProcessInfo],
) -> HashSet<pid_t> {
    // A live process at the reaped shell's pid that leads its own session means the pid was
    // reused, and the session id now names a newer session.
    // SAFETY: getsid(2) takes a plain value.
    if !shell_running && unsafe { libc::getsid(shell) } == shell {
        return HashSet::new();
    }
    table
        .iter()
        .map(|row| row.pid as pid_t)
        // SAFETY: getsid(2) takes a plain value.
        .filter(|&pid| unsafe { libc::getsid(pid) } == shell)
        .collect()
}

/// The Terminal Session Processes, and while the shell runs, its descendants that left its
/// session. A descendant of a reaped shell has been reparented, so it is no longer found.
pub(crate) fn session_processes(
    shell: pid_t,
    shell_running: bool,
) -> anyhow::Result<Vec<ProcessInfo>> {
    let table = process_table()?;
    let in_session = terminal_session_processes(shell, shell_running, &table);
    let mut descendants = HashSet::new();
    if shell_running {
        let mut parents = vec![shell];
        while let Some(parent) = parents.pop() {
            for row in &table {
                if row.ppid as pid_t == parent && descendants.insert(row.pid as pid_t) {
                    parents.push(row.pid as pid_t);
                }
            }
        }
    }
    let listed = |pid: pid_t| in_session.contains(&pid) || descendants.contains(&pid);
    Ok(table
        .into_iter()
        .filter(|row| listed(row.pid as pid_t))
        .map(|row| ProcessInfo {
            terminal_session_process: in_session.contains(&(row.pid as pid_t)),
            ..row
        })
        .collect())
}

/// `ps` rather than sysctl's `kinfo_proc`, whose layout libc does not define for Apple.
fn process_table() -> anyhow::Result<Vec<ProcessInfo>> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,command="])
        .output()
        .context("failed to run ps")?;
    if !output.status.success() {
        bail!("ps failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_ps_line)
        .collect())
}

fn parse_ps_line(line: &str) -> Option<ProcessInfo> {
    let mut rest = line.trim_start();
    let mut field = || {
        let (value, after) = rest.split_once(char::is_whitespace)?;
        rest = after.trim_start();
        Some(value)
    };
    let pid = field()?.parse().ok()?;
    let ppid = field()?.parse().ok()?;
    let pgid = field()?.parse().ok()?;
    let state = field()?.to_string();
    Some(ProcessInfo {
        pid,
        ppid,
        pgid,
        state,
        command: rest.to_string(),
        terminal_session_process: false,
    })
}

fn signal_terminal_session_processes(shell: pid_t, signal: libc::c_int) {
    let table = match process_table() {
        Ok(table) => table,
        Err(e) => {
            log::warn!("could not list the session of shell {shell}: {e:#}");
            return;
        }
    };
    let pids = terminal_session_processes(shell, false, &table);
    if pids.is_empty() {
        return;
    }
    log::info!("sending signal {signal} to the session of shell {shell}: {pids:?}");
    for pid in pids {
        // SAFETY: kill(2) takes plain values.
        unsafe { libc::kill(pid, signal) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_process_table_holds_this_process_and_its_session() {
        let me = std::process::id() as pid_t;
        let table = process_table().unwrap();
        assert!(table.iter().any(|row| row.pid as pid_t == me));
        // SAFETY: getsid(2) takes a plain value.
        let session = unsafe { libc::getsid(0) };
        assert!(terminal_session_processes(session, true, &table).contains(&me));
    }
}
