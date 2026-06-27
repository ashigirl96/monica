use std::process::Command;

const DELIMITER: &str = "_MONICA_PATH_DELIMITER_";

/// GUI launches (Finder/Dock) inherit launchd's minimal PATH, so child processes
/// such as worktree setup scripts can't find user-installed tools (mise, bun,
/// homebrew). Resolve PATH from the user's login shell instead, mirroring
/// tauri-apps/fix-path-env-rs.
pub fn fix_path_from_login_shell() -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let mut cmd = Command::new(&shell);
    cmd.arg("-ilc")
        .arg(format!(
            "printf '%s' '{DELIMITER}'; printf '%s' \"$PATH\"; printf '%s' '{DELIMITER}'"
        ))
        // Oh My Zsh's auto-update prompt would block the shell forever.
        .env("DISABLE_AUTO_UPDATE", "true");
    if let Some(home) = std::env::var_os("HOME") {
        cmd.current_dir(home);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("failed to run {shell}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{shell} exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let path = stdout
        .split(DELIMITER)
        .nth(1)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| format!("could not parse PATH from shell output: {stdout}"))?;

    std::env::set_var("PATH", path);
    Ok(())
}
