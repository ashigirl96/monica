use std::path::{Path, PathBuf};

/// Resolve each candidate against `cwd` (expanding a leading `~`) and return the
/// canonical absolute path when it exists, or `null` otherwise. `canonicalize`
/// doubles as the existence check: a path that cannot be resolved on disk is
/// dropped, so the frontend only ever highlights real files.
#[tauri::command]
#[specta::specta]
pub fn resolve_editor_paths(cwd: String, candidates: Vec<String>) -> Vec<Option<String>> {
    candidates
        .iter()
        .map(|raw| resolve_one(&cwd, raw))
        .collect()
}

#[tauri::command]
#[specta::specta]
pub fn open_in_editor(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .args(["-a", "Zed", &path])
            .status()
            .map_err(|e| format!("failed to launch Zed: {e}"))?;
        if !status.success() {
            return Err(format!("`open -a Zed {path}` exited with {status}"));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("open_in_editor is only supported on macOS".to_string())
    }
}

fn resolve_one(cwd: &str, raw: &str) -> Option<String> {
    if let Some(path) = expand_and_resolve(cwd, raw) {
        return Some(path.to_string_lossy().into_owned());
    }
    // Terminal output often carries a `file:line[:col]` suffix; retry without it
    // so `src/foo.rs:42` still resolves to `src/foo.rs`.
    strip_line_suffix(raw)
        .and_then(|stripped| expand_and_resolve(cwd, stripped))
        .map(|path| path.to_string_lossy().into_owned())
}

fn expand_and_resolve(cwd: &str, raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let candidate = if let Some(expanded) = expand_tilde(raw) {
        expanded
    } else {
        let path = Path::new(raw);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            // cwd はウィンドウタイトル由来だと `~/...` のことがあるので、相対パスの
            // ベースにする前にチルダを展開する。展開しないと canonicalize が必ず失敗する。
            let base = expand_tilde(cwd).unwrap_or_else(|| PathBuf::from(cwd));
            base.join(path)
        }
    };
    candidate.canonicalize().ok()
}

fn expand_tilde(s: &str) -> Option<PathBuf> {
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    if s == "~" {
        home()
    } else if let Some(rest) = s.strip_prefix("~/") {
        home().map(|h| h.join(rest))
    } else {
        None
    }
}

fn strip_line_suffix(raw: &str) -> Option<&str> {
    let mut head = raw;
    let mut stripped = false;
    for _ in 0..2 {
        let Some(idx) = head.rfind(':') else { break };
        let digits = &head[idx + 1..];
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            break;
        }
        head = &head[..idx];
        stripped = true;
    }
    stripped.then_some(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_line_and_column_suffix() {
        assert_eq!(strip_line_suffix("src/foo.rs:42"), Some("src/foo.rs"));
        assert_eq!(strip_line_suffix("src/foo.rs:42:7"), Some("src/foo.rs"));
        assert_eq!(strip_line_suffix("src/foo.rs"), None);
        // A URL's scheme colon is not a line suffix (the tail is not all digits).
        assert_eq!(strip_line_suffix("https://x"), None);
    }

    #[test]
    fn resolves_relative_path_against_cwd_only_when_it_exists() {
        let dir = std::env::temp_dir().join(format!("monica-editor-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        let file = dir.join("nested").join("real.txt");
        std::fs::write(&file, b"x").unwrap();
        let cwd = dir.to_string_lossy().into_owned();

        let got = resolve_one(&cwd, "nested/real.txt").unwrap();
        assert_eq!(
            std::fs::canonicalize(&got).unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
        // `nested/real.txt:12` still resolves to the file by stripping the suffix.
        assert!(resolve_one(&cwd, "nested/real.txt:12").is_some());
        // A non-existent path resolves to nothing (existence check via canonicalize).
        assert!(resolve_one(&cwd, "nested/missing.txt").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expands_tilde_only_for_tilde_prefixed_input() {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        assert_eq!(expand_tilde("~"), home.clone());
        assert_eq!(expand_tilde("~/foo"), home.map(|h| h.join("foo")));
        assert_eq!(expand_tilde("/abs/path"), None);
        assert_eq!(expand_tilde("relative/path"), None);
    }

    #[test]
    fn resolves_relative_path_against_tilde_prefixed_cwd() {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return;
        };
        // Create a uniquely-named file under HOME so a `~`-based cwd must be expanded.
        // The pid suffix keeps the test from clobbering a real file the user may own.
        let name = format!(".monica-editor-probe-{}", std::process::id());
        let probe = home.join(&name);
        std::fs::write(&probe, b"x").unwrap();

        // cwd reported as `~` (window-title flavor) + relative candidate must resolve.
        assert!(resolve_one("~", &name).is_some());

        std::fs::remove_file(&probe).ok();
    }
}
