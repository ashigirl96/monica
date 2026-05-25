use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

pub struct PtyHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub struct ShellSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

impl ShellSpec {
    pub fn from_env() -> Self {
        let program = std::env::var("SHELL").unwrap_or_else(|_| default_shell().to_string());
        Self { program, args: Vec::new(), cwd: std::env::var("HOME").ok() }
    }
}

#[cfg(target_os = "windows")]
fn default_shell() -> &'static str {
    "cmd.exe"
}

#[cfg(not(target_os = "windows"))]
fn default_shell() -> &'static str {
    "/bin/sh"
}

pub fn spawn(
    rows: u16,
    cols: u16,
    shell: &ShellSpec,
) -> Result<(PtyHandle, Box<dyn Read + Send>), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell.program);
    for arg in &shell.args {
        cmd.arg(arg);
    }
    if let Some(cwd) = &shell.cwd {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command failed: {e}"))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;

    let handle = PtyHandle {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    };
    Ok((handle, reader))
}

impl PtyHandle {
    pub fn write_all(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "writer mutex poisoned".to_string())?;
        writer.write_all(data).map_err(|e| format!("pty write failed: {e}"))?;
        writer.flush().map_err(|e| format!("pty flush failed: {e}"))
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|_| "master mutex poisoned".to_string())?;
        master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("pty resize failed: {e}"))
    }

    pub fn kill(&self) -> Result<(), String> {
        let mut child = self.child.lock().map_err(|_| "child mutex poisoned".to_string())?;
        child.kill().map_err(|e| format!("child kill failed: {e}"))
    }
}
