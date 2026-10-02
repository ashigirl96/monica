# Claude Code Hook 現行仕様と --settings 注入の成立

2026 年 10 月現在、Monica が Claude Code の hook メカニズムに依存している方法を確認します。

## 結論

- ✅ **Hook イベントは現行仕様で存在し、継続的にサポートされている**
  - SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、SubagentStart、SubagentStop、SessionEnd など
  - Matcher フィールド（e.g., "AskUserQuestion"、"ExitPlanMode"）で条件分岐が可能
  
- ✅ **`--settings` フラグで hook を注入できる**
  - settings ファイルのパスを渡すことで hook を追加できる
  - Settings の優先順位：Managed Settings > CLI (`--settings`) > Project Local > Shared Project > User
  - CLI 経由の `--settings` は高優先度（2 番目）で適用される
  
- ✅ **`session_id` は hook payload の `session_id` フィールドで取得可能**
  - 全イベントの JSON input に含まれる共通フィールド
  - `--session-id <uuid>` フラグで明示的に設定も可能
  
- ✅ **状態検出に必要なイベント群が存在する**
  - AskUserQuestion / ExitPlanMode / PermissionRequest 待ちを検出可能
  - Matcher フィールドで条件分岐できる（e.g., `PermissionRequest` イベントで `ExitPlanMode` matcher）
  
- ✅ **ZDOTDIR shim で claude 関数の wrapper 手法は引き続き成立**
  - Monica の現在の実装（shell_scaffold.rs）でも同じ手法を使用
  - `--settings` フラグをシェル関数内から挿入して hook を追加

## Monica が現在依存しているイベント・フィールド・CLI フラグ

File: `crates/monica-adapters/src/filesystem/shell_scaffold.rs` (Mon 実装)

### Hook イベント（マッチャー付き）
- **SessionStart** (matcher: "") → SessionStarted + Continuation 型
- **UserPromptSubmit** (matcher: "") → PromptSubmitted
- **PreToolUse** (matcher: "AskUserQuestion" | "ExitPlanMode") → UserInputRequired
- **PostToolUse** (matcher: "AskUserQuestion" | "ExitPlanMode") → UserInputRequired
- **PermissionRequest** (matcher: "ExitPlanMode" のみ) → UserInputRequired
- **Stop** (matcher: "") → TurnCompleted
- **SubagentStart** (matcher: "") → Inert
- **SubagentStop** (matcher: "") → SubagentFinished

File: `crates/monica-domain/src/agent_signal.rs` (Monica domain model)

### SignalKind の型
```
SessionStarted { continuation: Continuation }  // Fresh / Resume / Compact
PromptSubmitted
UserInputRequired { reason: TaskRunWaitReason, plan_file_path: Option<String> }
  - reason: AskUserQuestion, ExitPlanMode, PermissionRequest
UserInputResolved
TurnCompleted { subagents_running: bool }
SubagentFinished { subagents_running: bool }
SessionEnded
Inert
```

### Hook Wrapper スクリプト（ZDOTDIR shim）
- **Template**: `CLAUDE_WRAPPER_TEMPLATE` in shell_scaffold.rs
- **設定パスの注入**: `--settings __MONICA_SETTINGS_PATH__` を引数に追加
- **設定ファイル場所**: `{agent_shell_dir}/settings.json`
- **Hook コマンド**: `MONICA_HOME={monica_base} {monica_cli} hook {agent}`
- **環境変数チェック**:
  - `MONICA_TERMINAL_SESSION_ID`: hook を有効化（Monica PTY session 内でのみ）
  - `MONICA_TASK_ID`: `--session-id` を自動生成（uuidgen 使用）

## 現行仕様：Claude Code Hook 2.1.286 時点

Source: https://code.claude.com/docs/en/hooks.md（Claude Code 公式 docs）、CLI `claude --help`

### 利用可能なイベント一覧

Per Session:
- **SessionStart**: Matcher = "startup" | "resume" | "clear" | "compact" | "fork"
- **SessionEnd**: (No matcher)

Per Turn:
- **UserPromptSubmit**: (Can block)
- **Stop**: (No matcher, can block)
- **StopFailure**: (Error handling)

Per Tool Call:
- **PreToolUse**: Matcher = Tool name (e.g., "Bash", "Edit|Write")
- **PostToolUse**: Matcher = Tool name

Permission-related:
- **PermissionRequest**: Matcher support あり（Hook フィルタリング可能）

Agent-related:
- **SubagentStart**: 
- **SubagentStop**: 
- **Notification**: (Informational)

### Hook Payload の共通フィールド

すべてのイベントで stdin または POST で受け取る JSON：

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/dir",
  "scratchpad_dir": "/tmp/scratchpad",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "effort": { "level": "medium" }
}
```

### Exit Code 契約

| Exit Code | 動作 |
|-----------|------|
| 0 | Success; stdout から JSON output を読む |
| 2 | Blocking error; action をブロック、stderr を表示 |
| その他 | Non-blocking error（多くのイベント）; action は続行 |

### Hook Output Format

```json
{
  "continue": true,
  "stopReason": "Build failed",
  "systemMessage": "Warning: ...",
  "terminalSequence": "\u001b]0;Claude Code\u0007",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "additionalContext": "Extra info for Claude"
  }
}
```

### Settings の優先順位（`--settings` の位置付け）

1. **Managed Settings** （組織設定）- 最高
2. **CLI `--settings`** ← Monica が使用する層
3. **Project Local** `.claude/settings.local.json`
4. **Shared Project** `.claude/settings.json`
5. **User** `~/.claude/settings.json` - 最低

同じキーが複数の層で設定されている場合、優先度の高い層の値が使われます。

### CLI フラグ

```
--settings <file-or-json>        Settings JSON ファイルのパスまたは JSON 文字列
--session-id <uuid>              特定の session ID を使用（UUID 形式）
--session-id-file <path>         Session ID をファイルから読み込み
```

## 差分と注意点

### 仕様確認事項

1. **Hook イベントの安定性**: 
   - SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop は長年サポートされている基本イベント
   - SubagentStart / SubagentStop / SessionEnd はセッション・エージェント機能に伴い設計されている

2. **Matcher の仕様**:
   - Tool 名による正確なマッチ（"Bash"）、パイプ区切り（"Edit|Write"）、正規表現（"^Notebook"）をサポート
   - Monica が使用する "AskUserQuestion" と "ExitPlanMode" は hook の出力フィールド（tool_input の値ではなく、hook event の metadata）に基づく
   - PermissionRequest イベントでの "ExitPlanMode" matcher は、plan approval 時のみ hook を発火させる仕組み

3. **`--settings` の動作**:
   - Merge-add: 既存設定の上に追加マージされる（上書きでなく additive）
   - Wrapper による中継: Monica の shim は wrapper 関数内で `--settings` を展開、claude プロセスに渡す
   - Path resolution: ファイルパス指定時は、Hook handler コマンド実行時の cwd を基準に解決される（Monica は絶対パス指定で回避）

4. **Session ID の扱い**:
   - Hook payload 内の `session_id` 値が毎回のイベントで一貫性を保つ
   - Monica は wrapper で `--session-id` を自動生成して、複数 task run を session レベルで区別可能
   - Resume / Compact / Fork では continuation パラメータで継続の形態を指示

### 未確認事項

1. **Hook async 実行と timeout**:
   - Settings では `"async": false` がデフォルトか、実際の timeout 値の既定値がいくつかは確認未了
   - Monica の現実装では timeout を設定していない（デフォルト値に依存）

2. **MCP Tool Hook（新機能）との互換性**:
   - Hook type が "command" 以外に "mcp_tool" や "prompt" が選択肢として存在し、Monica が将来対応する可能性
   - 現状 Monica は "command" type のみ使用

3. **`prompt_id` フィールドの用途**:
   - Hook payload に含まれるが、Monica の現実装では参照していない

4. **SubagentStart と SubagentStop の payload 詳細**:
   - どのフィールドで subagent 識別情報が渡されるかは、実際の webhook 実行で確認が必要
