use serde::Serialize;

/// The permanent Workbench runspace hosting SDK-created Claude sessions — a fixed id in the
/// same convention family as `bench_runspace_id`'s `bench-{task_id}`.
pub fn sdk_runspace_id() -> &'static str {
    "sdk"
}

/// Injected into an SDK session's PTY env so later hook stages can identify the session.
pub const MONICA_SDK_SESSION_ID_ENV: &str = "MONICA_SDK_SESSION_ID";

#[derive(Debug, Clone)]
pub struct OpenSdkSessionParams {
    pub cwd: String,
    pub model: Option<String>,
    pub title: Option<String>,
    pub shell: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SdkSessionSpec {
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
pub(crate) fn sdk_initial_command(claude_session_id: &str, model: Option<&str>) -> String {
    let base = format!("claude --session-id {claude_session_id}");
    match model {
        Some(model) => format!("{base} --model {}", crate::shell::quote_single(model)),
        None => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launches_with_the_preminted_session_id() {
        assert_eq!(
            sdk_initial_command("5e0f5b0e-9f5c-4a4e-9d6e-000000000000", None),
            "claude --session-id 5e0f5b0e-9f5c-4a4e-9d6e-000000000000"
        );
    }

    #[test]
    fn model_is_passed_as_single_quoted_argument() {
        assert_eq!(
            sdk_initial_command("uuid", Some("opus")),
            "claude --session-id uuid --model 'opus'"
        );
    }

    #[test]
    fn model_with_embedded_quote_stays_one_shell_word() {
        assert_eq!(
            sdk_initial_command("uuid", Some("o'pus")),
            "claude --session-id uuid --model 'o'\\''pus'"
        );
    }
}
