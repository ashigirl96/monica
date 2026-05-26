use std::path::Path;
use std::process::Command;

/// Run a command, returning trimmed stdout. Non-zero exit is an error carrying stderr.
pub fn run(program: &str, args: &[&str], cwd: Option<&Path>) -> crate::Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    let output = command
        .output()
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("`{program} {}` failed: {}", args.join(" "), stderr.trim()).into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Like `run`, but returns whether the command succeeded instead of erroring.
pub fn ok(program: &str, args: &[&str], cwd: Option<&Path>) -> bool {
    run(program, args, cwd).is_ok()
}
