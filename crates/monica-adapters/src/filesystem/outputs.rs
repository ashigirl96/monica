use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use monica_application::shell::quote_single;
use monica_application::{ExecutionProfile, TaskRunOutputs, TaskShellEnv};
use monica_domain::{Agent, Project};
use serde_json::{json, Value};

use monica_paths as paths;

const HOOK_EVENTS_FILE: &str = "hook-events.jsonl";

#[derive(Debug, Default, Clone, Copy)]
pub struct FsTaskRunOutputs;

impl TaskRunOutputs for FsTaskRunOutputs {
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
        profile: &ExecutionProfile,
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
        let agent = profile.agent_default;
        let hook_cmd = pin_hook_command_base(&resolve_hook_command(agent)?, &monica_home);
        let settings_path_str = write_agent_hooks_config(agent, cwd, &hook_cmd)?;

        let bin_dir = task_dir.join("bin");
        let agent_bin = agent.as_str();
        write_agent_wrapper(&bin_dir, agent_bin, agent_wrapper_script(agent))?;
        let wrapper_path = bin_dir.join(agent_bin).to_string_lossy().into_owned();

        let zdotdir = task_dir.join("zdotdir");
        write_zdotdir(&zdotdir, agent)?;
        let zdotdir_str = zdotdir.to_string_lossy().into_owned();

        let mut env = vec![
            ("MONICA_HOME".to_string(), monica_home),
            ("MONICA_TASK_ID".to_string(), task_id.to_string()),
            ("MONICA_PROJECT_ID".to_string(), project.id.clone()),
            ("MONICA_AGENT_WRAPPER".to_string(), wrapper_path.clone()),
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
        event_label: Option<&str>,
        raw_stdin: &str,
    ) -> Result<()> {
        let dir = self.task_run_dir(task_run_id)?;
        fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
        let path = dir.join(HOOK_EVENTS_FILE);
        let payload: Value =
            serde_json::from_str(raw_stdin.trim()).unwrap_or_else(|_| json!({ "raw": raw_stdin }));
        let mut line = serde_json::to_string(&json!({
            "at": at,
            "hook_event_name": event_label,
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

fn resolve_hook_command(agent: Agent) -> Result<String> {
    let subcommand = agent.as_str();
    if let Ok(base) = std::env::var("MONICA_HOOK_COMMAND") {
        if !base.is_empty() {
            return Ok(format!("{base} hook {subcommand}"));
        }
    }
    if let Some(cli) = which_monica() {
        return Ok(format!("{} hook {subcommand}", quote_single(&cli)));
    }
    Err(anyhow!(
        "cannot resolve monica CLI for hook command; \
         set MONICA_BIN or ensure `monica` is on PATH"
    ))
}

fn which_monica() -> Option<String> {
    let bin = std::env::var("MONICA_BIN").unwrap_or_else(|_| "monica".to_string());
    let path = std::env::var("PATH").ok()?;
    find_monica_in(&bin, &path)
}

fn find_monica_in(bin: &str, path_var: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    for dir in path_var.split(':') {
        let candidate = Path::new(dir).join(bin);
        if candidate.is_file() {
            if let Ok(meta) = candidate.metadata() {
                if meta.permissions().mode() & 0o111 != 0 {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

fn pin_hook_command_base(hook_command: &str, monica_home: &str) -> String {
    format!("MONICA_HOME={} {hook_command}", quote_single(monica_home))
}

fn write_agent_hooks_config(
    agent: Agent,
    cwd: &Path,
    hook_command: &str,
) -> Result<String> {
    let config_path = cwd.join(crate::agents::hooks_config_path(agent));
    let config_path_str = config_path.to_string_lossy().into_owned();

    if std::env::var_os("HOME").is_some_and(|home| same_path(Path::new(&home), cwd)) {
        return Ok(config_path_str);
    }

    let parent = config_path
        .parent()
        .ok_or_else(|| anyhow!("hooks config path has no parent: {}", config_path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create {}", parent.display()))?;

    let hooks = agent_hooks_value(agent, hook_command);
    let body = match agent {
        Agent::Claude => {
            let existing = fs::read_to_string(&config_path).ok();
            merge_hooks_into_settings(existing.as_deref(), &hooks)?
        }
        Agent::Codex => serde_json::to_string_pretty(&hooks)
            .context("failed to serialize hooks config")?,
    };
    write_if_changed(&config_path, &body)?;
    Ok(config_path_str)
}

// Compare through symlinks and trailing-slash differences so the HOME guard cannot be bypassed by
// macOS firmlinks (/home → /private/...) or a stored project path written as `$HOME/`.
fn same_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn merge_hooks_into_settings(existing: Option<&str>, hooks: &Value) -> Result<String> {
    let mut root = existing
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    root["hooks"] = hooks["hooks"].clone();
    serde_json::to_string_pretty(&root).context("failed to serialize settings")
}

fn hook_group(hook_command: &str, matcher: &str) -> Value {
    json!({ "matcher": matcher, "hooks": [{ "type": "command", "command": hook_command }] })
}

fn agent_hooks_value(agent: Agent, hook_command: &str) -> Value {
    let group = || json!([hook_group(hook_command, "")]);
    let tool_wait_groups = || {
        json!([
            hook_group(hook_command, "AskUserQuestion"),
            hook_group(hook_command, "ExitPlanMode"),
        ])
    };
    let mut map = serde_json::Map::new();
    map.insert("SessionStart".into(), group());
    map.insert("UserPromptSubmit".into(), group());
    map.insert("PreToolUse".into(), tool_wait_groups());
    map.insert("PostToolUse".into(), tool_wait_groups());
    map.insert("Stop".into(), group());
    map.insert("SubagentStart".into(), group());
    map.insert("SubagentStop".into(), group());
    for event in crate::agents::extra_hook_events(agent) {
        map.insert((*event).into(), group());
    }
    json!({ "hooks": Value::Object(map) })
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

fn write_agent_wrapper(bin_dir: &Path, name: &str, contents: &str) -> Result<()> {
    fs::create_dir_all(bin_dir)
        .with_context(|| format!("failed to create {}", bin_dir.display()))?;
    let wrapper_path = bin_dir.join(name);
    write_if_changed(&wrapper_path, contents)?;
    fs::set_permissions(&wrapper_path, fs::Permissions::from_mode(0o755))
        .with_context(|| format!("failed to chmod {}", wrapper_path.display()))?;
    Ok(())
}

const CODEX_WRAPPER: &str = r#"#!/usr/bin/env bash
find_real_codex() {
    local self_dir
    self_dir="$(cd "$(dirname "$0")" && pwd)"
    local IFS=:
    for d in $PATH; do
        [[ "$d" == "$self_dir" ]] && continue
        [[ -x "$d/codex" ]] && printf '%s' "$d/codex" && return 0
    done
    return 1
}
REAL_CODEX="$(find_real_codex)" || { echo "Error: codex not found in PATH" >&2; exit 127; }
if [[ -z "${MONICA_TASK_ID:-}" ]]; then
    exec "$REAL_CODEX" "$@"
fi
exec "$REAL_CODEX" --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust "$@"
"#;

fn agent_wrapper_script(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => CLAUDE_WRAPPER,
        Agent::Codex => CODEX_WRAPPER,
    }
}

// zsh resolves each startup file against ZDOTDIR at the moment it reads it, so
// once .zshenv restores the user's ZDOTDIR, zsh loads the user's real
// .zprofile/.zshrc next and the other files in this directory are never read.
// The claude() wrapper must therefore be installed here in .zshenv — a shell
// function survives the user's rc files, unlike PATH which path_helper,
// .zshrc, and direnv all rewrite.
fn zdotdir_zshenv(agent: Agent) -> String {
    let bin = agent.as_str();
    format!(
        r#"# Monica ZDOTDIR bootstrap for zsh.
if [[ -n "${{MONICA_ORIGINAL_ZDOTDIR+X}}" ]]; then
    builtin export ZDOTDIR="$MONICA_ORIGINAL_ZDOTDIR"
    builtin unset MONICA_ORIGINAL_ZDOTDIR
else
    builtin unset ZDOTDIR
fi

builtin typeset _monica_file="${{ZDOTDIR-$HOME}}/.zshenv"
[[ ! -r "$_monica_file" ]] || builtin source -- "$_monica_file"
builtin unset _monica_file

if [[ -o interactive && -x "${{MONICA_AGENT_WRAPPER:-}}" ]]; then
    builtin unalias {bin} >/dev/null 2>&1 || true
    eval '{bin}() {{ "$MONICA_AGENT_WRAPPER" "$@"; }}'
fi
"#
    )
}

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

fn write_zdotdir(zdotdir: &Path, agent: Agent) -> Result<()> {
    fs::create_dir_all(zdotdir)
        .with_context(|| format!("failed to create {}", zdotdir.display()))?;
    write_if_changed(&zdotdir.join(".zshenv"), &zdotdir_zshenv(agent))?;
    for file in [".zprofile", ".zshrc", ".zlogin"] {
        write_if_changed(&zdotdir.join(file), &zdotdir_shim(file))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_hooks_value_claude_contains_tracked_events() {
        let parsed = agent_hooks_value(Agent::Claude, "monica hook claude");
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
    fn agent_hooks_value_codex_contains_supported_events() {
        let parsed = agent_hooks_value(Agent::Codex, "monica hook codex");
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "Stop",
            "SubagentStart",
            "SubagentStop",
            "PermissionRequest",
        ] {
            let cmd = parsed
                .pointer(&format!("/hooks/{event}/0/hooks/0/command"))
                .and_then(Value::as_str);
            assert_eq!(cmd, Some("monica hook codex"), "{event}: command");
        }
    }

    #[test]
    fn agent_hooks_value_codex_excludes_claude_only_events() {
        let parsed = agent_hooks_value(Agent::Codex, "monica hook codex");
        assert!(parsed.pointer("/hooks/SessionEnd").is_none());
        assert!(parsed.pointer("/hooks/StopFailure").is_none());
    }

    #[test]
    fn write_agent_hooks_config_codex_writes_into_cwd_dot_codex() {
        let cwd = unique_temp_dir("codex-write");
        let path =
            write_agent_hooks_config(Agent::Codex, &cwd, "monica hook codex")
                .unwrap();
        let expected = cwd.join(".codex").join("hooks.json");
        assert_eq!(path, expected.to_string_lossy());
        let body = fs::read_to_string(&expected).unwrap();
        assert!(body.contains("monica hook codex"));
        assert!(body.contains("SessionStart"));
        assert!(!body.contains("SessionEnd"));
        fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn pinned_hook_command_carries_its_own_monica_home() {
        assert_eq!(
            pin_hook_command_base("'/usr/local/bin/monica' hook claude", "/Users/x/monica"),
            "MONICA_HOME='/Users/x/monica' '/usr/local/bin/monica' hook claude"
        );
    }

    #[test]
    fn merge_hooks_creates_fresh_settings() {
        let hooks = agent_hooks_value(Agent::Claude, "monica hook claude");
        let body = merge_hooks_into_settings(None, &hooks).unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        let cmd = parsed
            .pointer("/hooks/SessionStart/0/hooks/0/command")
            .and_then(Value::as_str);
        assert_eq!(cmd, Some("monica hook claude"));
    }

    #[test]
    fn merge_hooks_preserves_other_top_level_keys() {
        let existing = r#"{"model":"opus","permissions":{"allow":["Bash"]}}"#;
        let hooks = agent_hooks_value(Agent::Claude, "monica hook claude");
        let body = merge_hooks_into_settings(Some(existing), &hooks).unwrap();
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
        let hooks = agent_hooks_value(Agent::Claude, "monica hook claude");
        let body = merge_hooks_into_settings(Some(existing), &hooks).unwrap();
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
        let hooks = agent_hooks_value(Agent::Claude, "monica hook claude");
        for existing in [Some("[1,2,3]"), Some("not json"), Some("\"scalar\"")] {
            let body = merge_hooks_into_settings(existing, &hooks).unwrap();
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
            "monica-task-run-outputs-test-{tag}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_agent_hooks_config_claude_writes_into_cwd_dot_claude() {
        let cwd = unique_temp_dir("write");
        let path =
            write_agent_hooks_config(Agent::Claude, &cwd, "monica hook claude")
                .unwrap();
        let expected = cwd.join(".claude").join("settings.local.json");
        assert_eq!(path, expected.to_string_lossy());
        let body = fs::read_to_string(&expected).unwrap();
        assert!(body.contains("monica hook claude"));
        assert!(body.contains("SessionStart"));
        assert!(body.contains("StopFailure"));
        assert!(body.contains("SessionEnd"));
        fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn write_agent_hooks_config_skips_home_to_protect_global_config() {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let home = PathBuf::from(home);
        let global = home.join(".claude").join("settings.local.json");
        let before = fs::read_to_string(&global).ok();

        let path =
            write_agent_hooks_config(Agent::Claude, &home, "monica hook claude")
                .unwrap();
        assert_eq!(path, global.to_string_lossy());

        let after = fs::read_to_string(&global).ok();
        assert_eq!(before, after, "must not create or modify the global settings.local.json");
    }

    #[test]
    fn find_monica_in_returns_first_match() {
        let dir = unique_temp_dir("find-monica");
        let dummy = dir.join("monica");
        fs::write(&dummy, "").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&dummy, fs::Permissions::from_mode(0o755)).unwrap();

        let result = find_monica_in("monica", &dir.to_string_lossy());
        assert_eq!(result, Some(dummy.to_string_lossy().into_owned()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_monica_in_returns_none_when_not_found() {
        assert_eq!(find_monica_in("monica", "/nonexistent/path"), None);
    }

    #[test]
    fn find_monica_in_skips_non_executable_file() {
        let dir = unique_temp_dir("find-noexec");
        let dummy = dir.join("monica");
        fs::write(&dummy, "").unwrap();
        fs::set_permissions(&dummy, fs::Permissions::from_mode(0o644)).unwrap();

        assert_eq!(find_monica_in("monica", &dir.to_string_lossy()), None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_monica_in_picks_first_dir_in_path() {
        let dir1 = unique_temp_dir("find-first");
        let dir2 = unique_temp_dir("find-second");
        let dummy1 = dir1.join("monica");
        let dummy2 = dir2.join("monica");
        fs::write(&dummy1, "").unwrap();
        fs::write(&dummy2, "").unwrap();
        fs::set_permissions(&dummy1, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&dummy2, fs::Permissions::from_mode(0o755)).unwrap();

        let path_var = format!("{}:{}", dir1.display(), dir2.display());
        let result = find_monica_in("monica", &path_var);
        assert_eq!(result, Some(dummy1.to_string_lossy().into_owned()));
        fs::remove_dir_all(&dir1).ok();
        fs::remove_dir_all(&dir2).ok();
    }

    #[test]
    fn zshenv_restores_zdotdir_and_installs_agent_function() {
        for (agent, bin) in [
            (Agent::Claude, "claude"),
            (Agent::Codex, "codex"),
        ] {
            let zshenv = zdotdir_zshenv(agent);
            assert!(zshenv.contains(r#"builtin export ZDOTDIR="$MONICA_ORIGINAL_ZDOTDIR""#), "{bin}");
            assert!(zshenv.contains("builtin unset ZDOTDIR"), "{bin}");
            let func = format!("{bin}() {{ \"$MONICA_AGENT_WRAPPER\" \"$@\"; }}");
            assert!(zshenv.contains(&func), "{bin}: expected {func}");
            let restore_pos = zshenv.find("builtin unset ZDOTDIR").unwrap();
            let install_pos = zshenv.find(&format!("{bin}()")).unwrap();
            assert!(restore_pos < install_pos, "{bin}: function must be installed after ZDOTDIR restore");
        }
    }

}
