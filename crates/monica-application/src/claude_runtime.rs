use serde::Serialize;

/// The permanent Workbench runspace hosting Agent Runtime-created Claude sessions — a fixed id in the
/// same convention family as `bench_runspace_id`'s `bench-{task_id}`.
pub fn agent_runtime_runspace_id() -> &'static str {
    "agent-runtime"
}

/// Injected into an Agent Runtime session's PTY env so later hook stages can identify the session.
pub const MONICA_CLAUDE_SESSION_ID_ENV: &str = "MONICA_CLAUDE_SESSION_ID";

#[derive(Debug, Clone)]
pub struct OpenClaudeSessionParams {
    pub cwd: String,
    pub model: Option<String>,
    pub title: Option<String>,
    pub shell: String,
    /// Client-supplied session id for idempotent opens: a retry after a lost response
    /// carries the same id, and an id already mapped to a live session returns that
    /// session instead of spawning a second one. `None` mints a fresh id server-side.
    pub claude_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClaudeSessionSpec {
    pub runspace_id: String,
    pub tab_id: String,
    pub session_id: String,
    pub claude_session_id: String,
    pub cwd: String,
    pub initial_command: String,
    pub title: Option<String>,
}

/// Launch command with a pre-minted session id, so the transcript path
/// (`~/.claude/projects/<slug>/<uuid>.jsonl`) is known before Claude starts.
pub(crate) fn claude_runtime_initial_command(claude_session_id: &str, model: Option<&str>) -> String {
    let base = format!("claude --session-id {claude_session_id}");
    match model {
        Some(model) => format!("{base} --model {}", crate::shell::quote_single(model)),
        None => base,
    }
}

/// Claude Code's project-directory slug for a cwd: every character outside ASCII
/// alphanumerics becomes `-`, with no collapsing (so `/a/.b` → `-a--b`). Claude Code does
/// this with a JS regex over UTF-16 code units, so mapping per UTF-16 unit — not per
/// `char` — keeps astral characters (which JS sees as two units) producing two dashes.
pub fn claude_project_slug(cwd: &str) -> String {
    cwd.encode_utf16()
        .map(|u| match char::from_u32(u as u32) {
            Some(c) if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect()
}

/// The directory Claude Code keeps a cwd's transcripts in: derived, never stored.
pub fn claude_project_dir(home: &std::path::Path, cwd: &str) -> std::path::PathBuf {
    home.join(".claude").join("projects").join(claude_project_slug(cwd))
}

/// Where Claude Code writes the session transcript: derived, never stored — the mapping
/// row keeps only `cwd` and `claude_session_id`.
pub fn claude_jsonl_path(
    home: &std::path::Path,
    cwd: &str,
    claude_session_id: &str,
) -> std::path::PathBuf {
    claude_project_dir(home, cwd).join(format!("{claude_session_id}.jsonl"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launches_with_the_preminted_session_id() {
        assert_eq!(
            claude_runtime_initial_command("5e0f5b0e-9f5c-4a4e-9d6e-000000000000", None),
            "claude --session-id 5e0f5b0e-9f5c-4a4e-9d6e-000000000000"
        );
    }

    #[test]
    fn model_is_passed_as_single_quoted_argument() {
        assert_eq!(
            claude_runtime_initial_command("uuid", Some("opus")),
            "claude --session-id uuid --model 'opus'"
        );
    }

    #[test]
    fn model_with_embedded_quote_stays_one_shell_word() {
        assert_eq!(
            claude_runtime_initial_command("uuid", Some("o'pus")),
            "claude --session-id uuid --model 'o'\\''pus'"
        );
    }

    #[test]
    fn slug_replaces_every_non_alphanumeric_without_collapsing() {
        assert_eq!(claude_project_slug("/private/tmp"), "-private-tmp");
        // `/` and `.` each become `-`, so `/.worktrees` yields a double dash.
        assert_eq!(
            claude_project_slug("/Users/me/.ghq/monica/.worktrees/issue-1"),
            "-Users-me--ghq-monica--worktrees-issue-1"
        );
        assert_eq!(claude_project_slug("/repos/auto_reserve"), "-repos-auto-reserve");
        assert_eq!(claude_project_slug("/Users/Me/Dir9"), "-Users-Me-Dir9");
    }

    #[test]
    fn slug_maps_astral_characters_to_two_dashes_like_js() {
        // '🦀' is one Rust char but two UTF-16 units; JS's per-unit regex emits two dashes.
        assert_eq!(claude_project_slug("/a/🦀b"), "-a---b");
    }

    #[test]
    fn jsonl_path_is_home_claude_projects_slug_uuid() {
        assert_eq!(
            claude_jsonl_path(std::path::Path::new("/Users/me"), "/private/tmp", "uuid-1"),
            std::path::PathBuf::from("/Users/me/.claude/projects/-private-tmp/uuid-1.jsonl")
        );
    }
}
