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

pub(crate) fn terminal_session_processes(shell: pid_t) -> Vec<pid_t> {
    all_pids()
        .into_iter()
        // SAFETY: getsid(2) takes a plain value.
        .filter(|&pid| unsafe { libc::getsid(pid) } == shell)
        .collect()
}

/// Blocks for the whole grace period; call it from the thread that reaped the shell.
pub(crate) fn end_terminal_session_processes(shell: pid_t) {
    std::thread::sleep(TERM_AFTER);
    signal_terminal_session_processes(shell, libc::SIGTERM);
    std::thread::sleep(KILL_AFTER);
    signal_terminal_session_processes(shell, libc::SIGKILL);
}

fn left_behind(shell: pid_t) -> Vec<pid_t> {
    // A live process at the reaped shell's pid that leads its own session means the pid was
    // reused, and the session id now names a newer session.
    // SAFETY: getsid(2) takes a plain value.
    if unsafe { libc::getsid(shell) } == shell {
        return Vec::new();
    }
    terminal_session_processes(shell)
}

/// The Terminal Session Processes, and while the shell runs, its descendants that left its
/// session. A descendant of a reaped shell has been reparented, so it is no longer found.
pub(crate) fn session_processes(
    shell: pid_t,
    shell_running: bool,
) -> anyhow::Result<Vec<ProcessInfo>> {
    let in_session: HashSet<pid_t> = if shell_running {
        terminal_session_processes(shell)
    } else {
        left_behind(shell)
    }
    .into_iter()
    .collect();
    let table = process_table()?;
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

/// `ps` rather than `kinfo_proc`, whose offsets for these fields libc does not give for Apple.
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
    let pids = left_behind(shell);
    if pids.is_empty() {
        return;
    }
    log::info!("sending signal {signal} to the session of shell {shell}: {pids:?}");
    for pid in pids {
        // SAFETY: kill(2) takes plain values.
        unsafe { libc::kill(pid, signal) };
    }
}

fn all_pids() -> Vec<pid_t> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_ALL];
    let mut size = 0;
    // SAFETY: a null buffer asks sysctl(3) only for the size the table needs.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Vec::new();
    }
    // Room for processes born between the two calls.
    size += size / 8;
    let mut buf = vec![0u8; size];
    // SAFETY: buf is `size` writable bytes, and sysctl(3) writes at most that many.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Vec::new();
    }
    buf[..size]
        .chunks_exact(KINFO_PROC_SIZE)
        .map(|entry| {
            let at = KINFO_PROC_PID_OFFSET;
            pid_t::from_ne_bytes(entry[at..at + 4].try_into().unwrap())
        })
        .collect()
}

// libc has no `kinfo_proc` for Apple; these are `sizeof(struct kinfo_proc)` and
// `offsetof(struct kinfo_proc, kp_proc.p_pid)` from <sys/sysctl.h> on 64-bit macOS.
const KINFO_PROC_SIZE: usize = 648;
const KINFO_PROC_PID_OFFSET: usize = 40;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_process_table_holds_this_process_and_its_session() {
        let me = std::process::id() as pid_t;
        assert!(all_pids().contains(&me));
        // SAFETY: getsid(2) takes a plain value.
        let session = unsafe { libc::getsid(0) };
        assert!(terminal_session_processes(session).contains(&me));
    }
}
