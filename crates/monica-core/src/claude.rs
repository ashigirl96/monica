use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::json;

const PROMPT_REL: &str = ".monica/prompt.md";

/// What `launch_agent` needs to start an agent process. `env` is *added* to the parent's
/// environment; callers must never feed this into `Command::env_clear()` because child processes
/// still need `PATH` so hook commands like `monica hook claude` can be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLaunch {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
}

/// The matcher is omitted so each hook fires unconditionally; the `command` string is a parameter
/// so the JSON body is pure and unit-testable with a fixed input.
pub(crate) fn claude_settings_json(hook_command: &str) -> Result<String> {
    let group = || json!([{ "hooks": [{ "type": "command", "command": hook_command }] }]);
    let value = json!({
        "hooks": {
            "SessionStart": group(),
            "UserPromptSubmit": group(),
            "Stop": group(),
            "StopFailure": group(),
            "SessionEnd": group(),
        }
    });
    serde_json::to_string_pretty(&value).context("failed to serialize claude settings")
}

/// A missing file or whitespace-only content is reported as `None` so the caller can omit the
/// positional arg entirely — passing an empty string would still seed an empty turn.
pub(crate) fn read_prompt(worktree: &Path) -> Result<Option<String>> {
    let path = worktree.join(PROMPT_REL);
    if !path.is_file() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    let trimmed = content.trim();
    Ok(if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Tmp;
    use serde_json::Value;

    fn write_prompt(worktree: &Path, body: &str) {
        let dir = worktree.join(".monica");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("prompt.md"), body).unwrap();
    }

    #[test]
    fn settings_json_contains_tracked_events_with_command_hook() {
        let body = claude_settings_json("monica hook claude").unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "StopFailure",
            "SessionEnd",
        ] {
            let cmd = parsed
                .pointer(&format!("/hooks/{event}/0/hooks/0/command"))
                .and_then(Value::as_str);
            assert_eq!(cmd, Some("monica hook claude"), "{event}: command");
            let ty = parsed
                .pointer(&format!("/hooks/{event}/0/hooks/0/type"))
                .and_then(Value::as_str);
            assert_eq!(ty, Some("command"), "{event}: type");
        }
    }

    #[test]
    fn settings_json_passes_arbitrary_command_through() {
        let body = claude_settings_json("/abs/bin/monica hook claude").unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        let cmd = parsed
            .pointer("/hooks/Stop/0/hooks/0/command")
            .and_then(Value::as_str);
        assert_eq!(cmd, Some("/abs/bin/monica hook claude"));
    }

    #[test]
    fn settings_json_omits_matcher_for_match_all() {
        let body = claude_settings_json("monica hook claude").unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert!(
            parsed.pointer("/hooks/SessionStart/0/matcher").is_none(),
            "matcher must be absent so the hook fires on every event"
        );
    }

    #[test]
    fn read_prompt_returns_none_when_missing() {
        let dir = Tmp::new("missing");
        assert_eq!(read_prompt(dir.path()).unwrap(), None);
    }

    #[test]
    fn read_prompt_returns_some_when_present() {
        let dir = Tmp::new("present");
        write_prompt(dir.path(), "/tackle\n");
        assert_eq!(read_prompt(dir.path()).unwrap().as_deref(), Some("/tackle"));
    }

    #[test]
    fn read_prompt_treats_whitespace_only_as_none() {
        let dir = Tmp::new("blank");
        write_prompt(dir.path(), "   \n\n  ");
        assert_eq!(read_prompt(dir.path()).unwrap(), None);
    }

    #[test]
    fn read_prompt_preserves_internal_lines() {
        let dir = Tmp::new("multi");
        write_prompt(dir.path(), "line one\nline two\n");
        assert_eq!(
            read_prompt(dir.path()).unwrap().as_deref(),
            Some("line one\nline two")
        );
    }
}
