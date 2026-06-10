use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
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
        let settings_body = claude_settings_json(&hook_cmd)?;
        let settings_path = task_dir.join("claude-settings.json");
        write_if_changed(&settings_path, &settings_body)?;
        let settings_path_str = settings_path.to_string_lossy().into_owned();

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
            ("MONICA_ID".to_string(), task_id.to_string()),
            ("MONICA_PROJECT_ID".to_string(), project.id.clone()),
            ("MONICA_CLAUDE_SETTINGS_PATH".to_string(), settings_path_str.clone()),
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
            env.push(("MONICA_RUN_ID".to_string(), run_id.to_string()));
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
            return Ok(format!("{} hook claude", shell_quote_single(&cli)));
        }
    }
    if let Some(cli) = which_monica() {
        return Ok(format!("{} hook claude", shell_quote_single(&cli)));
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

fn shell_quote_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn pin_hook_command_base(hook_command: &str, monica_home: &str) -> String {
    format!("MONICA_HOME={} {hook_command}", shell_quote_single(monica_home))
}

fn claude_settings_json(hook_command: &str) -> Result<String> {
    let hook_group = |matcher: &str| {
        json!({ "matcher": matcher, "hooks": [{ "type": "command", "command": hook_command }] })
    };
    let group = || json!([hook_group("")]);
    let value = json!({
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
            "SessionEnd": group(),
        }
    });
    serde_json::to_string_pretty(&value).context("failed to serialize claude settings")
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
if [[ -z "${MONICA_CLAUDE_SETTINGS_PATH:-}" ]]; then
    exec "$REAL_CLAUDE" "$@"
fi
case "${1:-}" in mcp|config|api-key) exec "$REAL_CLAUDE" "$@" ;; esac
unset CLAUDECODE
SKIP_SESSION=false
for arg in "$@"; do
    case "$arg" in --resume|--resume=*|-r|--session-id|--session-id=*|--continue|-c) SKIP_SESSION=true; break ;; esac
done
EXTRA_ARGS=(--dangerously-skip-permissions --settings "$MONICA_CLAUDE_SETTINGS_PATH")
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
    fn claude_settings_json_contains_tracked_events() {
        let body = claude_settings_json("monica hook claude").unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "Stop",
            "StopFailure",
            "SessionEnd",
        ] {
            let cmd = parsed
                .pointer(&format!("/hooks/{event}/0/hooks/0/command"))
                .and_then(Value::as_str);
            assert_eq!(cmd, Some("monica hook claude"), "{event}: command");
        }
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote_single("a'b"), "'a'\\''b'");
    }

    #[test]
    fn pinned_hook_command_carries_its_own_monica_home() {
        assert_eq!(
            pin_hook_command_base("'/usr/local/bin/monica' hook claude", "/Users/x/monica"),
            "MONICA_HOME='/Users/x/monica' '/usr/local/bin/monica' hook claude"
        );
    }

    #[test]
    fn wrapper_script_is_valid_bash() {
        assert!(CLAUDE_WRAPPER.starts_with("#!/usr/bin/env bash"));
        assert!(CLAUDE_WRAPPER.contains("find_real_claude"));
        assert!(CLAUDE_WRAPPER.contains("MONICA_CLAUDE_SETTINGS_PATH"));
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

    #[test]
    fn zdotdir_shim_sources_matching_user_file() {
        let shim = zdotdir_shim(".zshrc");
        assert!(shim.contains(r#""${ZDOTDIR-$HOME}/.zshrc""#));
        assert!(shim.contains("builtin unset ZDOTDIR"));
    }
}
