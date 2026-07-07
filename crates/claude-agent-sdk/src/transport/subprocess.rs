//! claude CLI を `-p` なしの stream-json 双方向モードで spawn する subprocess transport。
//!
//! ここが課金レーンの境界。`--print` を付けず、SDK entrypoint 系の環境変数を除去して
//! spawn することで、subscription (five_hour) 枠での消費を維持する（#341 で実測検証済み）。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

use crate::error::{ClaudeError, Result};
use crate::types::{
    ClaudeAgentOptions, PermissionMode, RawEventCallback, RawEventDirection, SystemPrompt,
};

/// #341 で検証済みの base args。`-p` を付けないことが課金レーン維持の必須条件。
/// `--permission-prompt-tool stdio` は `--help` に出ない隠しフラグで、permission 確認を
/// TUI ダイアログの代わりに stdout の `control_request` (can_use_tool) として流す。
const BASE_ARGS: &[&str] = &[
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--replay-user-messages",
];

const DEFAULT_PERMISSION_PROMPT_TOOL: &str = "stdio";

/// stderr の末尾を保持する行数（プロセス異常終了時のエラー文脈用）
const STDERR_TAIL_LINES: usize = 40;

/// spawn 前に子プロセス環境から除去する変数。
///
/// - `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`: 残っていると claude が child-session 化し、
///   SDK 課金レーンに切り替わる
/// - `DIRENV_*`: DIRENV_DIFF を継承した子プロセスで direnv が export 済み変数を
///   unset してしまう（monica-terminal-daemon の PTY spawn と同じ対処）
const REMOVED_ENV_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "DIRENV_DIFF",
    "DIRENV_DIR",
    "DIRENV_FILE",
    "DIRENV_WATCHES",
];

fn find_claude_cli(options: &ClaudeAgentOptions) -> Result<PathBuf> {
    if let Some(path) = &options.path_to_claude_code_executable {
        if path.is_file() {
            return Ok(path.clone());
        }
        return Err(ClaudeError::CliNotFound(format!(
            "specified executable not found: {}",
            path.display()
        )));
    }
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join("claude");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(ClaudeError::cli_not_found())
}

/// options から CLI 引数列を組み立てる（テスト可能な純粋関数）
fn build_args(options: &ClaudeAgentOptions) -> Vec<String> {
    let mut args: Vec<String> = BASE_ARGS.iter().map(ToString::to_string).collect();

    args.push("--permission-prompt-tool".into());
    args.push(
        options
            .permission_prompt_tool_name
            .clone()
            .unwrap_or_else(|| DEFAULT_PERMISSION_PROMPT_TOOL.into()),
    );

    match &options.system_prompt {
        Some(SystemPrompt::String(s)) => {
            args.push("--system-prompt".into());
            args.push(s.clone());
        }
        Some(SystemPrompt::Preset(preset)) => {
            if let Some(append) = &preset.append {
                args.push("--append-system-prompt".into());
                args.push(append.clone());
            }
        }
        Some(SystemPrompt::File(path)) => {
            args.push("--system-prompt-file".into());
            args.push(path.display().to_string());
        }
        None => {}
    }
    if let Some(append) = &options.append_system_prompt {
        args.push("--append-system-prompt".into());
        args.push(append.clone());
    }

    if !options.allowed_tools.is_empty() {
        args.push("--allowedTools".into());
        args.push(
            options
                .allowed_tools
                .iter()
                .map(|t| t.as_str().to_string())
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    if !options.disallowed_tools.is_empty() {
        args.push("--disallowedTools".into());
        args.push(
            options
                .disallowed_tools
                .iter()
                .map(|t| t.as_str().to_string())
                .collect::<Vec<_>>()
                .join(","),
        );
    }

    if let Some(mode) = options.permission_mode {
        args.push("--permission-mode".into());
        args.push(
            match mode {
                PermissionMode::Default => "default",
                PermissionMode::AcceptEdits => "acceptEdits",
                PermissionMode::Plan => "plan",
                PermissionMode::BypassPermissions => "bypassPermissions",
            }
            .into(),
        );
    }

    if let Some(model) = &options.model {
        args.push("--model".into());
        args.push(model.clone());
    }
    if let Some(fallback) = &options.fallback_model {
        args.push("--fallback-model".into());
        args.push(fallback.clone());
    }
    if let Some(max_turns) = options.max_turns {
        args.push("--max-turns".into());
        args.push(max_turns.to_string());
    }
    if let Some(tokens) = options.max_thinking_tokens {
        args.push("--max-thinking-tokens".into());
        args.push(tokens.to_string());
    }

    if options.continue_conversation {
        args.push("--continue".into());
    }
    if let Some(resume) = &options.resume {
        args.push("--resume".into());
        args.push(resume.as_str().to_string());
    }
    if options.fork_session {
        args.push("--fork-session".into());
    }
    if let Some(session_id) = &options.session_id {
        args.push("--session-id".into());
        args.push(session_id.clone());
    }

    if let Some(settings) = &options.settings {
        args.push("--settings".into());
        args.push(settings.display().to_string());
    }
    for dir in &options.add_dirs {
        args.push("--add-dir".into());
        args.push(dir.display().to_string());
    }
    if options.strict_mcp_config {
        args.push("--strict-mcp-config".into());
    }

    for (key, value) in &options.extra_args {
        args.push(format!("--{key}"));
        if let Some(value) = value {
            args.push(value.clone());
        }
    }

    args
}

fn build_command(cli_path: &Path, options: &ClaudeAgentOptions) -> Command {
    let mut cmd = Command::new(cli_path);
    cmd.args(build_args(options));

    // rewind_files control の前提（#342 の spawn 仕様）
    cmd.env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "true");
    for (key, value) in &options.env {
        cmd.env(key, value);
    }
    // env_remove は options.env 適用の「後」に行う。順序を逆にすると、
    // 利用側が現在の環境をコピーして options.env に載せた場合に
    // CLAUDECODE / CLAUDE_CODE_ENTRYPOINT が復活し、課金レーンが SDK 側に落ちる
    for key in REMOVED_ENV_VARS {
        cmd.env_remove(key);
    }

    if let Some(cwd) = &options.cwd {
        cmd.current_dir(cwd);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

/// claude CLI プロセスと行単位で stream-json をやり取りする transport。
///
/// 1 行 = 1 JSON の生の文字列を扱うだけで、パースは上位層（parser / control）の責務。
pub struct SubprocessTransport {
    child: Child,
    stdin: ChildStdin,
    stdout_rx: mpsc::UnboundedReceiver<String>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    raw_events: Option<RawEventCallback>,
}

impl SubprocessTransport {
    /// claude CLI を spawn する。呼び出しには tokio ランタイムが必要。
    pub fn spawn(options: &ClaudeAgentOptions) -> Result<Self> {
        let cli_path = find_claude_cli(options)?;
        let mut child = build_command(&cli_path, options).spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ClaudeError::transport("failed to capture stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ClaudeError::transport("failed to capture stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ClaudeError::transport("failed to capture stderr"))?;

        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel();
        let raw_events = options.raw_events.clone();
        let reader_raw_events = raw_events.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(hook) = &reader_raw_events {
                    hook(RawEventDirection::Received, &line);
                }
                if stdout_tx.send(line).is_err() {
                    break;
                }
            }
        });

        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
        let stderr_callback = options.stderr.clone();
        let tail = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut tail) = tail.lock() {
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line.clone());
                }
                if let Some(callback) = &stderr_callback {
                    callback(line);
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout_rx,
            stderr_tail,
            raw_events,
        })
    }

    /// 1 行（= 1 JSON）を stdin に書き込む。改行は付けて渡さないこと。
    pub async fn write_line(&mut self, line: &str) -> Result<()> {
        if let Some(hook) = &self.raw_events {
            hook(RawEventDirection::Sent, line);
        }
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// stdout の次の 1 行を受け取る。プロセスが終了しストリームが尽きると None。
    pub async fn next_line(&mut self) -> Option<String> {
        self.stdout_rx.recv().await
    }

    /// プロセスが生存しているか
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// 直近の stderr 出力（異常終了時の文脈用）
    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail
            .lock()
            .map(|tail| tail.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// プロセスを強制終了して回収する
    pub async fn kill(&mut self) -> Result<()> {
        self.child.kill().await?;
        Ok(())
    }

    /// 終了を待って exit code を返す。非ゼロ終了は stderr tail 付きの Process エラー。
    pub async fn wait(&mut self) -> Result<i32> {
        let status = self.child.wait().await?;
        let code = status.code().unwrap_or(-1);
        if status.success() {
            Ok(code)
        } else {
            Err(ClaudeError::process(
                "claude exited with non-zero status",
                code,
                Some(self.stderr_tail().join("\n")),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{SystemPromptPreset, ToolName};

    #[test]
    fn base_args_never_include_print_mode() {
        let args = build_args(&ClaudeAgentOptions::default());
        assert!(!args.contains(&"--print".to_string()));
        assert!(!args.contains(&"-p".to_string()));
    }

    #[test]
    fn base_args_match_verified_spawn_spec() {
        let args = build_args(&ClaudeAgentOptions::default());
        for expected in [
            "--output-format",
            "--input-format",
            "--verbose",
            "--include-partial-messages",
            "--include-hook-events",
            "--replay-user-messages",
        ] {
            assert!(args.contains(&expected.to_string()), "missing {expected}");
        }
        let idx = args
            .iter()
            .position(|a| a == "--permission-prompt-tool")
            .expect("permission-prompt-tool missing");
        assert_eq!(args[idx + 1], "stdio");
    }

    #[test]
    fn permission_prompt_tool_is_overridable() {
        let options = ClaudeAgentOptions::builder()
            .permission_prompt_tool_name("mcp__custom__tool")
            .build();
        let args = build_args(&options);
        let idx = args
            .iter()
            .position(|a| a == "--permission-prompt-tool")
            .unwrap();
        assert_eq!(args[idx + 1], "mcp__custom__tool");
    }

    #[test]
    fn option_flags_are_mapped() {
        let options = ClaudeAgentOptions::builder()
            .model("haiku")
            .max_turns(3)
            .allowed_tools(vec![ToolName::new("Read"), ToolName::new("Bash")])
            .permission_mode(PermissionMode::AcceptEdits)
            .resume(crate::types::SessionId::new("abc-123"))
            .fork_session(true)
            .build();
        let args = build_args(&options);

        let pairs: Vec<(String, String)> = args
            .windows(2)
            .map(|w| (w[0].clone(), w[1].clone()))
            .collect();
        assert!(pairs.contains(&("--model".into(), "haiku".into())));
        assert!(pairs.contains(&("--max-turns".into(), "3".into())));
        assert!(pairs.contains(&("--allowedTools".into(), "Read,Bash".into())));
        assert!(pairs.contains(&("--permission-mode".into(), "acceptEdits".into())));
        assert!(pairs.contains(&("--resume".into(), "abc-123".into())));
        assert!(args.contains(&"--fork-session".to_string()));
    }

    #[test]
    fn system_prompt_variants_are_mapped() {
        let string_args = build_args(&ClaudeAgentOptions::builder().system_prompt("be terse").build());
        assert!(string_args.contains(&"--system-prompt".to_string()));

        let preset = SystemPromptPreset {
            prompt_type: "preset".into(),
            preset: "claude_code".into(),
            append: Some("extra".into()),
        };
        let preset_args = build_args(&ClaudeAgentOptions::builder().system_prompt(preset).build());
        assert!(!preset_args.contains(&"--system-prompt".to_string()));
        assert!(preset_args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn extra_args_pass_through() {
        let mut extra = std::collections::HashMap::new();
        extra.insert("debug-to-stderr".to_string(), None);
        extra.insert("betas".to_string(), Some("context-1m-2025-08-07".to_string()));
        let options = ClaudeAgentOptions::builder().extra_args(extra).build();
        let args = build_args(&options);
        assert!(args.contains(&"--debug-to-stderr".to_string()));
        let idx = args.iter().position(|a| a == "--betas").unwrap();
        assert_eq!(args[idx + 1], "context-1m-2025-08-07");
    }

    #[test]
    fn removed_env_vars_cover_lane_and_direnv() {
        for key in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "DIRENV_DIFF"] {
            assert!(REMOVED_ENV_VARS.contains(&key));
        }
    }
}
