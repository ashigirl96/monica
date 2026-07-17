use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use monica_application::shell::quote_single;
use monica_domain::Agent;
use serde_json::{json, Value};

use monica_paths as paths;

/// Env vars every Monica-spawned shell needs to run any supported agent wrapped: the shared
/// zdotdir installs one shell function per agent, each wrapper injects that agent's hooks/flags.
/// Task identity is layered on separately.
pub(super) fn base_shell_env() -> Result<Vec<(String, String)>> {
    let mut wrappers = Vec::new();
    let mut bin_dirs = Vec::new();
    for agent in Agent::ALL {
        let bin_dir = paths::agent_shell_dir(agent.as_str())?.join("bin");
        write_agent_wrapper(&bin_dir, agent.as_str(), &agent_wrapper_script(agent)?)?;
        wrappers.push((agent, bin_dir.join(agent.as_str())));
        bin_dirs.push(bin_dir.to_string_lossy().into_owned());
    }
    let zdotdir = paths::shell_zdotdir()?;
    write_zdotdir(&zdotdir, &wrappers)?;

    let monica_home = paths::base_dir()?.to_string_lossy().into_owned();
    let mut env = vec![
        ("MONICA_HOME".to_string(), monica_home.clone()),
        ("_MONICA_APP_HOME".to_string(), monica_home),
        ("ZDOTDIR".to_string(), zdotdir.to_string_lossy().into_owned()),
    ];
    // Set only when the user actually had ZDOTDIR; .zshenv unsets it otherwise
    // so zsh falls back to $HOME like vanilla.
    if let Ok(original) = std::env::var("ZDOTDIR") {
        env.push(("MONICA_ORIGINAL_ZDOTDIR".to_string(), original));
    }
    // Best-effort fallback for non-zsh shells, which ignore ZDOTDIR. The
    // user's rc files may still reorder PATH; zsh users get the reliable
    // shell-function wrappers instead.
    let mut path_value = bin_dirs.join(":");
    if let Ok(path) = std::env::var("PATH") {
        if !path.is_empty() {
            path_value = format!("{path_value}:{path}");
        }
    }
    env.push(("PATH".to_string(), path_value));
    Ok(env)
}

/// The hook must write to the DB this app instance reads, but the tab's MONICA_HOME can be
/// rewritten after spawn (direnv applying a repo .envrc that exports another base) — so the
/// command pins the base itself instead of trusting the environment it inherits.
pub(super) fn pinned_hook_cmd(agent: Agent) -> Result<String> {
    let monica_home = paths::base_dir()?.to_string_lossy().into_owned();
    Ok(pin_hook_command_base(&resolve_hook_command(agent)?, &monica_home))
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
    if Path::new(&bin).is_absolute() {
        return is_executable_file(Path::new(&bin)).then_some(bin);
    }
    let path = std::env::var("PATH").ok()?;
    find_monica_in(&bin, &path)
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file() && path.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

fn find_monica_in(bin: &str, path_var: &str) -> Option<String> {
    for dir in path_var.split(':') {
        let candidate = Path::new(dir).join(bin);
        if is_executable_file(&candidate) {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn pin_hook_command_base(hook_command: &str, monica_home: &str) -> String {
    format!("MONICA_HOME={} {hook_command}", quote_single(monica_home))
}

pub(super) fn write_codex_hooks_config(cwd: &Path, hook_command: &str) -> Result<()> {
    let config_path = cwd.join(crate::agents::hooks_config_path(Agent::Codex));

    if cwd_is_home(cwd) {
        return Ok(());
    }

    let parent = config_path
        .parent()
        .ok_or_else(|| anyhow!("hooks config path has no parent: {}", config_path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create {}", parent.display()))?;

    let hooks = agent_hooks_value(Agent::Codex, hook_command);
    let body =
        serde_json::to_string_pretty(&hooks).context("failed to serialize hooks config")?;
    write_if_changed(&config_path, &body)
}

/// Earlier versions merged Monica's hook groups into the worktree's `settings.local.json`. Hooks
/// now arrive via the wrapper's `--settings`, so a leftover block would make every event fire
/// twice.
pub(super) fn strip_legacy_claude_hooks(cwd: &Path) -> Result<()> {
    if cwd_is_home(cwd) {
        return Ok(());
    }
    let config_path = cwd.join(crate::agents::hooks_config_path(Agent::Claude));
    let Ok(raw) = fs::read_to_string(&config_path) else {
        return Ok(());
    };
    let Ok(mut root) = serde_json::from_str::<Value>(&raw) else {
        return Ok(());
    };
    if !strip_monica_hook_groups(&mut root) {
        return Ok(());
    }
    if root.as_object().is_some_and(serde_json::Map::is_empty) {
        fs::remove_file(&config_path)
            .with_context(|| format!("failed to remove {}", config_path.display()))
    } else {
        let body =
            serde_json::to_string_pretty(&root).context("failed to serialize settings")?;
        write_if_changed(&config_path, &body)
    }
}

/// Returns true when any Monica-owned hook group was removed. User-defined hooks are kept.
fn strip_monica_hook_groups(root: &mut Value) -> bool {
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut modified = false;
    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        let Some(groups) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
            continue;
        };
        let before = groups.len();
        groups.retain(|group| !is_monica_hook_group(group));
        if groups.len() != before {
            modified = true;
            if groups.is_empty() {
                hooks.remove(&event);
            }
        }
    }
    if modified && hooks.is_empty() {
        if let Some(obj) = root.as_object_mut() {
            obj.remove("hooks");
        }
    }
    modified
}

fn is_monica_hook_group(group: &Value) -> bool {
    group.get("hooks").and_then(Value::as_array).is_some_and(|hooks| {
        !hooks.is_empty()
            && hooks.iter().all(|hook| {
                hook.get("command").and_then(Value::as_str).is_some_and(is_monica_hook_command)
            })
    })
}

/// Legacy Monica entries were written as `<cli> hook claude`, later with a `MONICA_HOME=<value> `
/// prefix — one command word (optionally single-quoted), nothing else. Anything looser (extra
/// arguments, chained commands) is treated as user-owned and kept, since a stray match here
/// deletes the group.
fn is_monica_hook_command(cmd: &str) -> bool {
    let rest = match cmd.strip_prefix("MONICA_HOME=") {
        Some(after) => match strip_shell_word(after).and_then(|r| r.strip_prefix(' ')) {
            Some(rest) => rest,
            None => return false,
        },
        None => cmd,
    };
    strip_shell_word(rest) == Some(" hook claude")
}

/// Strips one leading shell word — single-quoted (`'…'`) or bare (up to the first space) —
/// returning the remainder.
fn strip_shell_word(s: &str) -> Option<&str> {
    if let Some(rest) = s.strip_prefix('\'') {
        let end = rest.find('\'')?;
        Some(&rest[end + 1..])
    } else {
        let end = s.find(' ').unwrap_or(s.len());
        (end > 0).then(|| &s[end..])
    }
}

/// Guards the user's global agent config (`~/.claude`, `~/.codex`): a project checked out at
/// $HOME must never have its hooks config written or stripped.
fn cwd_is_home(cwd: &Path) -> bool {
    std::env::var_os("HOME").is_some_and(|home| crate::fs_util::same_path(Path::new(&home), cwd))
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

const CLAUDE_WRAPPER_TEMPLATE: &str = r#"#!/usr/bin/env bash
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
case "${1:-}" in mcp|config|api-key) exec "$REAL_CLAUDE" "$@" ;; esac
EXTRA_ARGS=()
# The hooks config lives in a file next to this wrapper and is passed by path — inline JSON would
# bloat the argv of every claude process (and its forks) in `ps`. claude merges --settings
# additively on top of the user's own settings, so nothing is written into the repo. Only
# Monica-spawned shells carry MONICA_TERMINAL_SESSION_ID — anywhere else this wrapper stays
# transparent.
if [[ -n "${MONICA_TERMINAL_SESSION_ID:-}" ]]; then
    # Monica tabs are independent sessions even when the app was launched from Claude Code.
    unset CLAUDECODE
    EXTRA_ARGS+=(--settings __MONICA_SETTINGS_PATH__)
fi
if [[ -n "${MONICA_TASK_ID:-}" ]]; then
    unset CLAUDECODE
    EXTRA_ARGS+=(--dangerously-skip-permissions)
    SKIP_SESSION=false
    for arg in "$@"; do
        case "$arg" in --resume|--resume=*|-r|--session-id|--session-id=*|--continue|-c) SKIP_SESSION=true; break ;; esac
    done
    if [[ "$SKIP_SESSION" != true ]]; then
        SESSION_ID="$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]')"
        if [[ -n "$SESSION_ID" ]]; then
            EXTRA_ARGS+=(--session-id "$SESSION_ID")
        fi
    fi
fi
exec "$REAL_CLAUDE" "${EXTRA_ARGS[@]}" "$@"
"#;

fn claude_wrapper_script(settings_path: &str) -> String {
    CLAUDE_WRAPPER_TEMPLATE.replace("__MONICA_SETTINGS_PATH__", &quote_single(settings_path))
}

fn write_agent_wrapper(bin_dir: &Path, name: &str, contents: &str) -> Result<()> {
    fs::create_dir_all(bin_dir)
        .with_context(|| format!("failed to create {}", bin_dir.display()))?;
    let wrapper_path = bin_dir.join(name);
    write_if_changed(&wrapper_path, contents)?;
    if !is_executable_file(&wrapper_path) {
        fs::set_permissions(&wrapper_path, fs::Permissions::from_mode(0o755))
            .with_context(|| format!("failed to chmod {}", wrapper_path.display()))?;
    }
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

fn agent_wrapper_script(agent: Agent) -> Result<String> {
    match agent {
        Agent::Claude => {
            let settings_path = write_claude_hooks_settings()?;
            Ok(claude_wrapper_script(&settings_path.to_string_lossy()))
        }
        Agent::Codex => Ok(CODEX_WRAPPER.to_string()),
    }
}

fn write_claude_hooks_settings() -> Result<PathBuf> {
    let dir = paths::agent_shell_dir(Agent::Claude.as_str())?;
    write_claude_hooks_settings_in(&dir, &pinned_hook_cmd(Agent::Claude)?)
}

fn write_claude_hooks_settings_in(dir: &Path, hook_command: &str) -> Result<PathBuf> {
    let hooks = agent_hooks_value(Agent::Claude, hook_command);
    let body =
        serde_json::to_string_pretty(&hooks).context("failed to serialize hooks config")?;
    fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let path = dir.join("settings.json");
    write_if_changed(&path, &body)?;
    Ok(path)
}

// zsh resolves each startup file against ZDOTDIR at the moment it reads it, so
// once .zshenv restores the user's ZDOTDIR, zsh loads the user's real
// .zprofile/.zshrc next and the other files in this directory are never read.
// The agent wrapper functions must therefore be installed here in .zshenv — a
// shell function survives the user's rc files, unlike PATH which path_helper,
// .zshrc, and direnv all rewrite.
fn zdotdir_zshenv(wrappers: &[(Agent, PathBuf)]) -> String {
    let mut out = String::from(
        r#"# Monica ZDOTDIR bootstrap for zsh.
if [[ -n "${MONICA_ORIGINAL_ZDOTDIR+X}" ]]; then
    builtin export ZDOTDIR="$MONICA_ORIGINAL_ZDOTDIR"
    builtin unset MONICA_ORIGINAL_ZDOTDIR
else
    builtin unset ZDOTDIR
fi

builtin typeset _monica_file="${ZDOTDIR-$HOME}/.zshenv"
[[ ! -r "$_monica_file" ]] || builtin source -- "$_monica_file"
builtin unset _monica_file
"#,
    );
    for (agent, wrapper_path) in wrappers {
        let bin = agent.as_str();
        let wrapper = wrapper_path.to_string_lossy();
        out.push_str(&format!(
            r#"
if [[ -o interactive && -x "{wrapper}" ]]; then
    builtin unalias {bin} >/dev/null 2>&1 || true
    eval '{bin}() {{ "{wrapper}" "$@"; }}'
fi
"#
        ));
    }
    out
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

fn write_zdotdir(zdotdir: &Path, wrappers: &[(Agent, PathBuf)]) -> Result<()> {
    fs::create_dir_all(zdotdir)
        .with_context(|| format!("failed to create {}", zdotdir.display()))?;
    write_if_changed(&zdotdir.join(".zshenv"), &zdotdir_zshenv(wrappers))?;
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
        write_codex_hooks_config(&cwd, "monica hook codex").unwrap();
        let expected = cwd.join(".codex").join("hooks.json");
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
    fn strip_removes_monica_groups_and_keeps_user_hooks() {
        let mut root: Value = serde_json::from_str(
            r#"{
              "model": "opus",
              "hooks": {
                "SessionStart": [
                  {"matcher":"","hooks":[{"type":"command","command":"MONICA_HOME='/x' '/bin/monica' hook claude"}]},
                  {"matcher":"","hooks":[{"type":"command","command":"my-own-hook"}]}
                ],
                "Stop": [
                  {"matcher":"","hooks":[{"type":"command","command":"monica hook claude"}]}
                ]
              }
            }"#,
        )
        .unwrap();
        assert!(strip_monica_hook_groups(&mut root));
        assert_eq!(root.pointer("/model").and_then(Value::as_str), Some("opus"));
        assert_eq!(
            root.pointer("/hooks/SessionStart/0/hooks/0/command")
                .and_then(Value::as_str),
            Some("my-own-hook")
        );
        assert!(root.pointer("/hooks/Stop").is_none());
    }

    #[test]
    fn strip_removes_hooks_key_when_only_monica_groups_existed() {
        let mut root: Value = serde_json::from_str(
            r#"{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"monica hook claude"}]}]}}"#,
        )
        .unwrap();
        assert!(strip_monica_hook_groups(&mut root));
        assert!(root.pointer("/hooks").is_none());
        assert!(root.as_object().unwrap().is_empty());
    }

    #[test]
    fn strip_leaves_foreign_settings_untouched() {
        for raw in [
            r#"{"model":"opus"}"#,
            r#"{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"other"}]}]}}"#,
        ] {
            let mut root: Value = serde_json::from_str(raw).unwrap();
            let before = root.clone();
            assert!(!strip_monica_hook_groups(&mut root));
            assert_eq!(root, before);
        }
    }

    #[test]
    fn strip_legacy_claude_hooks_deletes_file_when_nothing_remains() {
        let cwd = unique_temp_dir("strip-delete");
        let config = cwd.join(".claude").join("settings.local.json");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(
            &config,
            r#"{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"monica hook claude"}]}]}}"#,
        )
        .unwrap();
        strip_legacy_claude_hooks(&cwd).unwrap();
        assert!(!config.exists());
        fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn strip_legacy_claude_hooks_rewrites_file_when_user_keys_remain() {
        let cwd = unique_temp_dir("strip-rewrite");
        let config = cwd.join(".claude").join("settings.local.json");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(
            &config,
            r#"{"model":"opus","hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"monica hook claude"}]}]}}"#,
        )
        .unwrap();
        strip_legacy_claude_hooks(&cwd).unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(parsed.pointer("/model").and_then(Value::as_str), Some("opus"));
        assert!(parsed.pointer("/hooks").is_none());
        fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn write_claude_hooks_settings_in_writes_hooks_json_at_settings_json() {
        let dir = unique_temp_dir("claude-settings");
        let path = write_claude_hooks_settings_in(&dir, "monica hook claude").unwrap();
        assert_eq!(path, dir.join("settings.json"));
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            parsed
                .pointer("/hooks/SessionStart/0/hooks/0/command")
                .and_then(Value::as_str),
            Some("monica hook claude")
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrapper_bakes_in_settings_path_and_gates_task_flags_on_task_id() {
        let script = claude_wrapper_script("/Users/it's home/monica/shell/claude/settings.json");
        assert!(
            script.contains(
                r#"--settings '/Users/it'\''s home/monica/shell/claude/settings.json'"#
            ),
            "settings path must be baked in as a safely quoted literal"
        );
        assert!(!script.contains("__MONICA_SETTINGS_PATH__"));
        assert!(script.contains(r#"-n "${MONICA_TERMINAL_SESSION_ID:-}""#));
        assert!(script.contains(r#"-n "${MONICA_TASK_ID:-}""#));
        assert!(script.contains("--dangerously-skip-permissions"));
        assert!(script.contains("--session-id"));
        let hooks_pos = script.find(r#"-n "${MONICA_TERMINAL_SESSION_ID:-}""#).unwrap();
        let task_pos = script.find(r#"-n "${MONICA_TASK_ID:-}""#).unwrap();
        assert!(
            hooks_pos < task_pos,
            "hooks injection must not be gated behind the task check"
        );
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
    fn strip_legacy_claude_hooks_skips_home_to_protect_global_config() {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let home = PathBuf::from(home);
        let global = home.join(".claude").join("settings.local.json");
        let before = fs::read_to_string(&global).ok();

        strip_legacy_claude_hooks(&home).unwrap();

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
    fn zshenv_restores_zdotdir_and_installs_every_agent_function() {
        let wrappers: Vec<(Agent, PathBuf)> = Agent::ALL
            .into_iter()
            .map(|agent| {
                let bin = agent.as_str();
                (agent, PathBuf::from("/base/shell").join(bin).join("bin").join(bin))
            })
            .collect();
        let zshenv = zdotdir_zshenv(&wrappers);
        assert!(zshenv.contains(r#"builtin export ZDOTDIR="$MONICA_ORIGINAL_ZDOTDIR""#));
        assert!(zshenv.contains("builtin unset ZDOTDIR"));
        let restore_pos = zshenv.find("builtin unset ZDOTDIR").unwrap();
        for (agent, wrapper) in &wrappers {
            let bin = agent.as_str();
            let func = format!("{bin}() {{ \"{}\" \"$@\"; }}", wrapper.display());
            assert!(zshenv.contains(&func), "{bin}: expected {func}");
            let install_pos = zshenv.find(&format!("{bin}()")).unwrap();
            assert!(restore_pos < install_pos, "{bin}: function must be installed after ZDOTDIR restore");
        }
    }

    #[test]
    fn monica_hook_command_matches_only_the_exact_written_shapes() {
        for cmd in [
            "monica hook claude",
            "'/usr/local/bin/monica' hook claude",
            "MONICA_HOME='/Users/x/monica' '/usr/local/bin/monica' hook claude",
            "MONICA_HOME=/tmp/base monica hook claude",
        ] {
            assert!(is_monica_hook_command(cmd), "should own: {cmd}");
        }
        for cmd in [
            "my-own-hook",
            "echo done && monica hook claude",
            "monica hook codex",
            "monica hook claude --verbose",
            "MONICA_HOME='/x' echo pwned; monica hook claude",
        ] {
            assert!(!is_monica_hook_command(cmd), "must keep: {cmd}");
        }
    }
}
