use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use monica_core::shell::quote_single;
use monica_core::{Project, RunArtifacts, TaskShellEnv};
use serde_json::{json, Value};

use crate::filesystem::paths;

const HOOK_EVENTS_FILE: &str = "hook-events.jsonl";

#[derive(Debug, Default, Clone, Copy)]
pub struct FsRunArtifacts;

impl RunArtifacts for FsRunArtifacts {
    fn task_run_dir(&self, task_run_id: &str) -> Result<PathBuf> {
        paths::task_run_dir(task_run_id)
    }

    fn setup_log_path(&self, task_run_id: &str) -> Result<PathBuf> {
        let dir = self.task_run_dir(task_run_id)?;
        fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
        Ok(dir.join("setup.log"))
    }

    fn prepare_task_shell_env(
        &self,
        task_id: &str,
        project: &Project,
        task_run_id: Option<&str>,
        cwd: &Path,
    ) -> Result<TaskShellEnv> {
        let task_dir = paths::task_shell_dir(task_id)?;
        fs::create_dir_all(&task_dir)
            .with_context(|| format!("failed to create {}", task_dir.display()))?;

        // The hook must write to the DB this app instance reads, but the tab's
        // MONICA_HOME can be rewritten after spawn (direnv applying a repo
        // .envrc that exports another base) — so the command pins the base
        // itself instead of trusting the environment it inherits.
        let monica_home = paths::base_dir()?.to_string_lossy().into_owned();
        let hook_cmd = pin_hook_command_base(&resolve_hook_command()?, &monica_home);
        // Hooks live in the cwd's `.claude/settings.local.json` rather than behind a
        // `--settings` flag: Claude auto-loads it from disk, so it survives Claude's own
        // re-exec (clear + bypass permissions launches a bare `claude` that drops every flag).
        let settings_path_str = write_local_settings(cwd, &hook_cmd)?;

        let bin_dir = task_dir.join("bin");
        write_claude_wrapper(&bin_dir)?;
        let wrapper_path = bin_dir.join("claude").to_string_lossy().into_owned();

        let zdotdir = task_dir.join("zdotdir");
        write_zdotdir(&zdotdir)?;
        let zdotdir_str = zdotdir.to_string_lossy().into_owned();

        let mut env = vec![
            // The tab's shell and any `monica` CLI calls in it should use the
            // same base dir as the app (e.g. ~/monica/dev in dev).
            ("MONICA_HOME".to_string(), monica_home),
            ("MONICA_TASK_ID".to_string(), task_id.to_string()),
            ("MONICA_PROJECT_ID".to_string(), project.id.clone()),
            ("MONICA_CLAUDE_WRAPPER".to_string(), wrapper_path.clone()),
            ("ZDOTDIR".to_string(), zdotdir_str),
        ];
        // Set only when the user actually had ZDOTDIR; .zshenv unsets it otherwise
        // so zsh falls back to $HOME like vanilla.
        if let Ok(original) = std::env::var("ZDOTDIR") {
            env.push(("MONICA_ORIGINAL_ZDOTDIR".to_string(), original));
        }
        if let Some(run_id) = task_run_id {
            env.push(("MONICA_TASK_RUN_ID".to_string(), run_id.to_string()));
        }
        // Best-effort fallback for non-zsh shells, which ignore ZDOTDIR. The
        // user's rc files may still reorder PATH; zsh users get the reliable
        // shell-function wrapper instead.
        let bin_dir_str = bin_dir.to_string_lossy().into_owned();
        let path_value = match std::env::var("PATH") {
            Ok(path) if !path.is_empty() => format!("{bin_dir_str}:{path}"),
            _ => bin_dir_str,
        };
        env.push(("PATH".to_string(), path_value));

        Ok(TaskShellEnv {
            env,
            settings_path: settings_path_str,
            wrapper_path,
        })
    }

    fn append_hook_event(
        &self,
        task_run_id: &str,
        at: &str,
        event_name: Option<&str>,
        parsed: &Option<Value>,
        raw_stdin: &str,
    ) -> Result<()> {
        let dir = self.task_run_dir(task_run_id)?;
        fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
        let path = dir.join(HOOK_EVENTS_FILE);
        let payload = parsed
            .clone()
            .unwrap_or_else(|| json!({ "raw": raw_stdin }));
        let mut line = serde_json::to_string(&json!({
            "at": at,
            "hook_event_name": event_name,
            "payload": payload,
        }))?;
        line.push('\n');

        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(line.as_bytes()))
            .with_context(|| format!("failed to append to {}", path.display()))
    }
}

fn write_if_changed(path: &Path, contents: &str) -> Result<()> {
    if fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return Ok(());
    }
    fs::write(path, contents).with_context(|| format!("failed to write {}", path.display()))
}

fn resolve_hook_command() -> Result<String> {
    if let Ok(cmd) = std::env::var("MONICA_HOOK_COMMAND") {
        if !cmd.is_empty() {
            return Ok(cmd);
        }
    }
    if let Ok(cli) = std::env::var("MONICA_CLI_PATH") {
        if !cli.is_empty() && Path::new(&cli).is_file() {
            return Ok(format!("{} hook claude", quote_single(&cli)));
        }
    }
    if let Some(cli) = which_monica() {
        return Ok(format!("{} hook claude", quote_single(&cli)));
    }
    Err(anyhow!(
        "cannot resolve monica CLI for hook command; \
         set MONICA_CLI_PATH or ensure `monica` is on PATH"
    ))
}

fn which_monica() -> Option<String> {
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':') {
        let candidate = Path::new(dir).join("monica");
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn pin_hook_command_base(hook_command: &str, monica_home: &str) -> String {
    format!("MONICA_HOME={} {hook_command}", quote_single(monica_home))
}

/// Write the hook config into `<cwd>/.claude/settings.local.json`, merging into any existing file.
/// Returns the absolute path even when the write is skipped. Skips when `cwd` resolves to the
/// user's `$HOME`, so a project without a checkout path can never poison the global
/// `~/.claude/settings.local.json` shared by every Claude session.
fn write_local_settings(cwd: &Path, hook_command: &str) -> Result<String> {
    let settings_path = cwd.join(".claude").join("settings.local.json");
    let settings_path_str = settings_path.to_string_lossy().into_owned();

    if std::env::var_os("HOME").is_some_and(|home| same_path(Path::new(&home), cwd)) {
        return Ok(settings_path_str);
    }

    let claude_dir = cwd.join(".claude");
    fs::create_dir_all(&claude_dir)
        .with_context(|| format!("failed to create {}", claude_dir.display()))?;
    let existing = fs::read_to_string(&settings_path).ok();
    let body = merge_hooks_into_local_settings(existing.as_deref(), hook_command)?;
    write_if_changed(&settings_path, &body)?;
    Ok(settings_path_str)
}

// Compare through symlinks and trailing-slash differences so the HOME guard cannot be bypassed by
// macOS firmlinks (/home → /private/...) or a stored project path written as `$HOME/`.
fn same_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Merge Monica's hook block into existing `settings.local.json` content. Monica owns the `hooks`
/// key (replaced wholesale); every other top-level key the user set is preserved.
fn merge_hooks_into_local_settings(existing: Option<&str>, hook_command: &str) -> Result<String> {
    let hooks = hooks_value(hook_command);
    let mut root = existing
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    root["hooks"] = hooks["hooks"].clone();
    serde_json::to_string_pretty(&root).context("failed to serialize claude settings")
}

fn hooks_value(hook_command: &str) -> Value {
    let hook_group = |matcher: &str| {
        json!({ "matcher": matcher, "hooks": [{ "type": "command", "command": hook_command }] })
    };
    let group = || json!([hook_group("")]);
    json!({
        "hooks": {
            "SessionStart": group(),
            "UserPromptSubmit": group(),
            "PreToolUse": [
                hook_group("AskUserQuestion"),
                hook_group("ExitPlanMode"),
            ],
            "PostToolUse": [
                hook_group("AskUserQuestion"),
                hook_group("ExitPlanMode"),
            ],
            "Stop": group(),
            "StopFailure": group(),
            // Observation-only: a subagent (Task) starting/finishing in the parent
            // session. No status transition is mapped for them (lifecycle leaves them
            // inert), so they only land in hook-events.jsonl for investigation.
            "SubagentStart": group(),
            "SubagentStop": group(),
            "SessionEnd": group(),
        }
    })
}

const CLAUDE_WRAPPER: &str = r#"#!/usr/bin/env bash
find_real_claude() {
    local self_dir
    self_dir="$(cd "$(dirname "$0")" && pwd)"
    local IFS=:
    for d in $PATH; do
        [[ "$d" == "$self_dir" ]] && continue
        [[ -x "$d/claude" ]] && printf '%s' "$d/claude" && return 0
    done
    return 1
}
REAL_CLAUDE="$(find_real_claude)" || { echo "Error: claude not found in PATH" >&2; exit 127; }
# Outside a Monica-managed task shell, behave like vanilla claude. Hooks are loaded by
# claude itself from <cwd>/.claude/settings.local.json, so the wrapper only injects the
# launch flags (skip-permissions + a fresh session id).
if [[ -z "${MONICA_TASK_ID:-}" ]]; then
    exec "$REAL_CLAUDE" "$@"
fi
case "${1:-}" in mcp|config|api-key) exec "$REAL_CLAUDE" "$@" ;; esac
unset CLAUDECODE
SKIP_SESSION=false
for arg in "$@"; do
    case "$arg" in --resume|--resume=*|-r|--session-id|--session-id=*|--continue|-c) SKIP_SESSION=true; break ;; esac
done
EXTRA_ARGS=(--dangerously-skip-permissions)
if [[ "$SKIP_SESSION" != true ]]; then
    SESSION_ID="$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]')"
    if [[ -n "$SESSION_ID" ]]; then
        EXTRA_ARGS+=(--session-id "$SESSION_ID")
    fi
fi
exec "$REAL_CLAUDE" "${EXTRA_ARGS[@]}" "$@"
"#;

fn write_claude_wrapper(bin_dir: &Path) -> Result<()> {
    fs::create_dir_all(bin_dir)
        .with_context(|| format!("failed to create {}", bin_dir.display()))?;
    let wrapper_path = bin_dir.join("claude");
    write_if_changed(&wrapper_path, CLAUDE_WRAPPER)?;
    fs::set_permissions(&wrapper_path, fs::Permissions::from_mode(0o755))
        .with_context(|| format!("failed to chmod {}", wrapper_path.display()))?;
    Ok(())
}

// zsh resolves each startup file against ZDOTDIR at the moment it reads it, so
// once .zshenv restores the user's ZDOTDIR, zsh loads the user's real
// .zprofile/.zshrc next and the other files in this directory are never read.
// The claude() wrapper must therefore be installed here in .zshenv — a shell
// function survives the user's rc files, unlike PATH which path_helper,
// .zshrc, and direnv all rewrite.
const ZDOTDIR_ZSHENV: &str = r#"# Monica ZDOTDIR bootstrap for zsh.
if [[ -n "${MONICA_ORIGINAL_ZDOTDIR+X}" ]]; then
    builtin export ZDOTDIR="$MONICA_ORIGINAL_ZDOTDIR"
    builtin unset MONICA_ORIGINAL_ZDOTDIR
else
    builtin unset ZDOTDIR
fi

builtin typeset _monica_file="${ZDOTDIR-$HOME}/.zshenv"
[[ ! -r "$_monica_file" ]] || builtin source -- "$_monica_file"
builtin unset _monica_file

if [[ -o interactive && -x "${MONICA_CLAUDE_WRAPPER:-}" ]]; then
    builtin unalias claude >/dev/null 2>&1 || true
    # eval so an existing `alias claude=...` cannot break parsing.
    eval 'claude() { "$MONICA_CLAUDE_WRAPPER" "$@"; }'
fi
"#;

fn zdotdir_shim(file: &str) -> String {
    format!(
        r#"# Compatibility shim: .zshenv restores ZDOTDIR so this should never be reached.
if [[ -n "${{MONICA_ORIGINAL_ZDOTDIR+X}}" ]]; then
    builtin export ZDOTDIR="$MONICA_ORIGINAL_ZDOTDIR"
    builtin unset MONICA_ORIGINAL_ZDOTDIR
else
    builtin unset ZDOTDIR
fi

builtin typeset _monica_file="${{ZDOTDIR-$HOME}}/{file}"
[[ ! -r "$_monica_file" ]] || builtin source -- "$_monica_file"
builtin unset _monica_file
"#
    )
}

fn write_zdotdir(zdotdir: &Path) -> Result<()> {
    fs::create_dir_all(zdotdir)
        .with_context(|| format!("failed to create {}", zdotdir.display()))?;
    write_if_changed(&zdotdir.join(".zshenv"), ZDOTDIR_ZSHENV)?;
    for file in [".zprofile", ".zshrc", ".zlogin"] {
        write_if_changed(&zdotdir.join(file), &zdotdir_shim(file))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_value_contains_tracked_events() {
        let parsed = hooks_value("monica hook claude");
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "Stop",
            "StopFailure",
            "SubagentStart",
            "SubagentStop",
            "SessionEnd",
        ] {
            let cmd = parsed
                .pointer(&format!("/hooks/{event}/0/hooks/0/command"))
                .and_then(Value::as_str);
            assert_eq!(cmd, Some("monica hook claude"), "{event}: command");
        }
    }

    #[test]
    fn pinned_hook_command_carries_its_own_monica_home() {
        assert_eq!(
            pin_hook_command_base("'/usr/local/bin/monica' hook claude", "/Users/x/monica"),
            "MONICA_HOME='/Users/x/monica' '/usr/local/bin/monica' hook claude"
        );
    }

    #[test]
    fn merge_hooks_creates_fresh_settings_with_pinned_command() {
        let body = merge_hooks_into_local_settings(None, "monica hook claude").unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        let cmd = parsed
            .pointer("/hooks/SessionStart/0/hooks/0/command")
            .and_then(Value::as_str);
        assert_eq!(cmd, Some("monica hook claude"));
    }

    #[test]
    fn merge_hooks_preserves_other_top_level_keys() {
        let existing = r#"{"model":"opus","permissions":{"allow":["Bash"]}}"#;
        let body = merge_hooks_into_local_settings(Some(existing), "monica hook claude").unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed.pointer("/model").and_then(Value::as_str), Some("opus"));
        assert_eq!(
            parsed.pointer("/permissions/allow/0").and_then(Value::as_str),
            Some("Bash")
        );
        assert!(parsed.pointer("/hooks/Stop/0/hooks/0/command").is_some());
    }

    #[test]
    fn merge_hooks_replaces_pre_existing_hooks_key() {
        let existing = r#"{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"old"}]}]}}"#;
        let body = merge_hooks_into_local_settings(Some(existing), "monica hook claude").unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            parsed
                .pointer("/hooks/SessionStart/0/hooks/0/command")
                .and_then(Value::as_str),
            Some("monica hook claude")
        );
    }

    #[test]
    fn merge_hooks_replaces_non_object_or_malformed_existing() {
        // A non-object JSON value or unparseable content cannot carry user keys worth preserving,
        // so it is replaced with a clean hooks-only object rather than propagating broken state.
        for existing in [Some("[1,2,3]"), Some("not json"), Some("\"scalar\"")] {
            let body = merge_hooks_into_local_settings(existing, "monica hook claude").unwrap();
            let parsed: Value = serde_json::from_str(&body).unwrap();
            assert!(parsed.is_object());
            assert_eq!(
                parsed
                    .pointer("/hooks/SessionStart/0/hooks/0/command")
                    .and_then(Value::as_str),
                Some("monica hook claude")
            );
        }
    }

    #[test]
    fn wrapper_drops_settings_flag_and_gates_on_task_id() {
        assert!(CLAUDE_WRAPPER.contains("--dangerously-skip-permissions"));
        assert!(!CLAUDE_WRAPPER.contains("--settings"));
        assert!(CLAUDE_WRAPPER.contains(r#"-z "${MONICA_TASK_ID:-}""#));
        assert!(CLAUDE_WRAPPER.contains("--session-id"));
    }

    fn unique_temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "monica-artifacts-test-{tag}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_local_settings_writes_into_cwd_dot_claude() {
        let cwd = unique_temp_dir("write");
        let path = write_local_settings(&cwd, "monica hook claude").unwrap();
        let expected = cwd.join(".claude").join("settings.local.json");
        assert_eq!(path, expected.to_string_lossy());
        let body = fs::read_to_string(&expected).unwrap();
        assert!(body.contains("monica hook claude"));
        assert!(body.contains("SessionStart"));
        fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn write_local_settings_skips_home_to_protect_global_config() {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let home = PathBuf::from(home);
        let global = home.join(".claude").join("settings.local.json");
        let before = fs::read_to_string(&global).ok();

        let path = write_local_settings(&home, "monica hook claude").unwrap();
        assert_eq!(path, global.to_string_lossy());

        let after = fs::read_to_string(&global).ok();
        assert_eq!(before, after, "must not create or modify the global settings.local.json");
    }

    #[test]
    fn zshenv_restores_zdotdir_and_installs_claude_function() {
        assert!(ZDOTDIR_ZSHENV.contains(r#"builtin export ZDOTDIR="$MONICA_ORIGINAL_ZDOTDIR""#));
        assert!(ZDOTDIR_ZSHENV.contains("builtin unset ZDOTDIR"));
        assert!(ZDOTDIR_ZSHENV.contains(r#"claude() { "$MONICA_CLAUDE_WRAPPER" "$@"; }"#));
        let restore_pos = ZDOTDIR_ZSHENV.find("builtin unset ZDOTDIR").unwrap();
        let install_pos = ZDOTDIR_ZSHENV.find("claude()").unwrap();
        assert!(restore_pos < install_pos, "function must be installed after ZDOTDIR restore");
    }

}
