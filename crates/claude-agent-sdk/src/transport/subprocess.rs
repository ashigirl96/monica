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
    ClaudeAgentOptions, McpServers, PermissionMode, RawEventCallback, RawEventDirection,
    SdkPluginConfig, SystemPrompt, ToolsConfig,
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

    if let Some(budget) = options.max_budget_usd {
        args.push("--max-budget-usd".into());
        args.push(budget.to_string());
    }
    match &options.tools {
        // Preset(claude_code) は既定のフルセットと同義なのでフラグ省略で表現できる
        Some(ToolsConfig::List(list)) => {
            args.push("--tools".into());
            args.push(
                list.iter()
                    .map(|t| t.as_str().to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        Some(ToolsConfig::Preset(_)) | None => {}
    }
    if let Some(betas) = &options.betas {
        args.push("--betas".into());
        args.push(
            betas
                .iter()
                .filter_map(|beta| serde_json::to_value(beta).ok())
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    if let Some(output_format) = &options.output_format {
        args.push("--json-schema".into());
        args.push(output_format.schema.to_string());
    }
    if let Some(agents) = &options.agents {
        args.push("--agents".into());
        args.push(serde_json::to_string(agents).unwrap_or_default());
    }
    if let Some(sources) = &options.setting_sources {
        args.push("--setting-sources".into());
        args.push(
            sources
                .iter()
                .filter_map(|source| serde_json::to_value(source).ok())
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    if let Some(plugins) = &options.plugins {
        for SdkPluginConfig::Local { path } in plugins {
            args.push("--plugin-dir".into());
            args.push(path.clone());
        }
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

/// spawn 前の設定検証。
///
/// - `BypassPermissions` は全 permission チェックを無効化するため、
///   明示的な `allow_dangerously_skip_permissions` opt-in を必須にする
/// - 未配線の option は黙って無視せず `InvalidConfig` で弾く（設定したのに
///   効いていない、という静かな事故を防ぐ。対応したら個別にこのリストから外す）
fn validate_options(options: &ClaudeAgentOptions) -> Result<()> {
    if options.permission_mode == Some(PermissionMode::BypassPermissions)
        && !options.allow_dangerously_skip_permissions
    {
        return Err(ClaudeError::invalid_config(
            "permission_mode = BypassPermissions requires allow_dangerously_skip_permissions = true",
        ));
    }

    let unsupported: &[(&str, bool)] = &[
        ("user", options.user.is_some()),
        ("max_buffer_size", options.max_buffer_size.is_some()),
        ("read_timeout_secs", options.read_timeout_secs.is_some()),
        ("resume_session_at", options.resume_session_at.is_some()),
        ("hooks", options.hooks.is_some()),
        (
            "mcp_servers",
            !matches!(options.mcp_servers, McpServers::None),
        ),
    ];
    for (name, set) in unsupported {
        if *set {
            return Err(ClaudeError::invalid_config(format!(
                "option `{name}` is not supported yet by claude-agent-sdk (see TODO.md)"
            )));
        }
    }
    Ok(())
}

impl SubprocessTransport {
    /// claude CLI を spawn する。呼び出しには tokio ランタイムが必要。
    pub fn spawn(options: &ClaudeAgentOptions) -> Result<Self> {
        validate_options(options)?;
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

    #[test]
    fn budget_tools_and_parity_flags_are_mapped() {
        use crate::types::{AgentDefinition, OutputFormat, SdkBeta, SettingSource};

        let mut agents = std::collections::HashMap::new();
        agents.insert(
            "reviewer".to_string(),
            AgentDefinition {
                description: "reviews code".into(),
                prompt: "review".into(),
                tools: None,
                model: None,
            },
        );
        let options = ClaudeAgentOptions::builder()
            .max_budget_usd(1.5)
            .tools(ToolsConfig::from_list(vec![ToolName::new("Read")]))
            .betas(vec![SdkBeta::Context1M])
            .output_format(OutputFormat::json_schema(serde_json::json!({"type": "object"})))
            .agents(agents)
            .setting_sources(vec![SettingSource::User, SettingSource::Project])
            .plugins(vec![SdkPluginConfig::Local { path: "/tmp/plugin".into() }])
            .build();
        let args = build_args(&options);

        let pairs: Vec<(String, String)> = args
            .windows(2)
            .map(|w| (w[0].clone(), w[1].clone()))
            .collect();
        assert!(pairs.contains(&("--max-budget-usd".into(), "1.5".into())));
        assert!(pairs.contains(&("--tools".into(), "Read".into())));
        assert!(pairs.contains(&("--betas".into(), "context-1m-2025-08-07".into())));
        assert!(pairs.contains(&("--setting-sources".into(), "user,project".into())));
        assert!(pairs.contains(&("--plugin-dir".into(), "/tmp/plugin".into())));
        let idx = args.iter().position(|a| a == "--json-schema").unwrap();
        assert!(args[idx + 1].contains("object"));
        let idx = args.iter().position(|a| a == "--agents").unwrap();
        assert!(args[idx + 1].contains("reviewer"));
    }

    #[test]
    fn tools_preset_is_default_toolset_and_omits_flag() {
        let options = ClaudeAgentOptions::builder()
            .tools(ToolsConfig::claude_code_preset())
            .build();
        assert!(!build_args(&options).contains(&"--tools".to_string()));
    }

    #[test]
    fn unwired_options_are_rejected_not_silently_ignored() {
        let cases: Vec<ClaudeAgentOptions> = vec![
            ClaudeAgentOptions::builder().user("someone").build(),
            ClaudeAgentOptions::builder().max_buffer_size(1024).build(),
            ClaudeAgentOptions::builder().read_timeout_secs(10).build(),
            ClaudeAgentOptions::builder()
                .resume_session_at("uuid-1")
                .build(),
            ClaudeAgentOptions::builder()
                .hooks(std::collections::HashMap::new())
                .build(),
            ClaudeAgentOptions::builder()
                .mcp_servers(McpServers::Path("/tmp/mcp.json".into()))
                .build(),
        ];
        for options in cases {
            assert!(
                matches!(validate_options(&options), Err(ClaudeError::InvalidConfig(_))),
                "expected InvalidConfig for unwired option"
            );
        }
    }

    #[test]
    fn bypass_permissions_requires_explicit_opt_in() {
        let unguarded = ClaudeAgentOptions::builder()
            .permission_mode(PermissionMode::BypassPermissions)
            .build();
        assert!(matches!(
            validate_options(&unguarded),
            Err(ClaudeError::InvalidConfig(_))
        ));

        let guarded = ClaudeAgentOptions::builder()
            .permission_mode(PermissionMode::BypassPermissions)
            .allow_dangerously_skip_permissions(true)
            .build();
        assert!(validate_options(&guarded).is_ok());

        // 他のモードは opt-in 不要
        let plan = ClaudeAgentOptions::builder()
            .permission_mode(PermissionMode::Plan)
            .build();
        assert!(validate_options(&plan).is_ok());
    }
}
