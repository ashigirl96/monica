# claude-agent-sdk TODO

`claude` CLI を `-p` なしの stream-json I/O で駆動する Rust SDK。
公式 TypeScript Agent SDK と同じ interface を目標とし、型定義は
[bartolli/anthropic-agent-sdk](https://github.com/bartolli/anthropic-agent-sdk) (MIT) を出発点に移植する。

- 仕様の正典（信頼順）: ① #341 の実測ログ > ② 公式 `sdk.d.ts` (0.3.202 に pin) > ③ 参考実装
- 参考実装: bartolli/anthropic-agent-sdk（API 形状・型）、recca0120/code-quest（プロトコル運用の知見）
- 関連 issue: #342（stream-json セッション種別）、#341（go 判定の検証ログ）

## 方針

**型は借りて、振る舞いは自分で書く。**
bartolli から `types/` と `error.rs` を 1 ファイルずつ読みながら移植し、
transport / parser / control / query / client は #341 実測と #342 仕様から自分で実装する
（詰まったら bartolli・code-quest を参照する open-book 方式）。

## anthropic-agent-sdk (bartolli) に足りていないもの・直すべきもの

### A. 課金レーン（blocker — そのままでは絶対に使えない）

- [x] `--print` を常時付与している（`subprocess.rs:176`）。`-p` は SDK 消費レーンに入るため
      **削除し、`-p` なし streaming を唯一のモードにする**（#341 で `-p` なし動作は検証済み）
- [x] `CLAUDE_CODE_ENTRYPOINT=sdk-rust` を設定している（`subprocess.rs:612`）。**設定ではなく除去**:
      `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` を `env_remove`（child-session 化の防止。monica の PTY 実装と同じ対処）
- [x] `DIRENV_*` の `env_remove`（.envrc 変数が継承先で unset される monica 既知問題への対処）

### B. spawn 引数が #341 検証済み構成と揃っていない

検証済み base args:
`--output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio --include-partial-messages --include-hook-events --replay-user-messages`

- [x] `--include-hook-events` が存在しない（コードベースに 0 hit）
- [x] `--permission-prompt-tool` が任意オプション扱い。**`stdio` 固定を既定にする**（隠しフラグ。
      permission を TUI ダイアログでなく stdout の `control_request` (`can_use_tool`) として流すスイッチ）
- [x] `--replay-user-messages` / `--include-partial-messages` が条件付き付与。既定で常時付与に
- [x] `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` の設定（`rewind_files` の前提）
- [ ] 起動時 smoke check（init イベント受信確認）。`--permission-prompt-tool stdio` + `-p` なしは
      `--help` 上サポート外の組み合わせなので、CLI 更新で壊れたことを即検知する
      （`tests/live_smoke.rs` で initialize → control_response(success) を実機確認済み。
      接続時のランタイム組み込みは Phase 4 の `query()` / client 実装で行う）
- [ ] `mcp_servers` の CLI 引数化（`--mcp-config`。`McpServerConfig` が Serialize 未実装のため保留）

### C. パーサ: 未知イベントを落とす（#342 原則違反）

- [ ] `parse_message` が 1 段デコードで、未知 `type` は**ハードエラー**（`message/parser.rs`。
      テストでも `invalid_type` → error を仕様化してしまっている）。
      **ok / skip / unknown / error の 4 値 2 段デコード**に置き換え、未知は `Unknown(serde_json::Value)` で上に流す
- [ ] 既知型の未知フィールド耐性の確認（`deny_unknown_fields` を使わない・追加フィールドで壊れないこと）
- [ ] stdin/stdout の生 JSON 行を direction タグ付きで流す **raw event hook**（journal は Monica 側の責務、
      SDK は hook 提供のみ。bartolli には存在しない）

### D. Message 型のカバレッジ不足

- [ ] `Message` enum は 5 variant（User / Assistant / System / Result / StreamEvent）。
      公式 `SDKMessage` (0.3.202) は **38 variant**。
      `System { subtype, #[serde(flatten)] data: Value }` が system 系を吸収するため P0 では許容し、
      `Unknown` 落ちの観測と typify パイプライン（後述）で優先度順に追加していく
- [ ] `SDKUserMessage` / `SDKUserMessageReplay` は同じ `type: "user"` なので
      `#[serde(tag = "type")]` 単独では判別不能（uuid 有無等の二段判別が必要）。移植時に要注意
- [ ] `Usage` / `ModelUsage` 等のフィールドを実測ログと突き合わせ（bartolli の型は手書きなので drift しうる)

### E. control protocol のカバレッジ不足

bartolli 実装済み subtype: `initialize` / `interrupt` / `send_message` / `hook_callback(hook)` /
`can_use_tool(permission)` / `set_model` / `set_permission_mode` / `set_max_thinking_tokens` / `rewind_files`

- [ ] 公式は **57 subtype**（うち 23 は sdk.d.ts 側の宣言漏れで型欠落 — 下記 G 参照）。
      不足分は「未知 control を forward」で受け、専用型は必要になったものから追加
      （`mcp_status` / `mcp_reconnect` / `generate_session_title` / `get_context_usage` /
      `elicitation` / `mcp_message` / `set_cwd` などは未実装）
- [ ] `can_use_tool` 応答の 3 形態の網羅確認: `allow (updatedInput / updatedPermissions / userFeedback)` /
      `deny (message, interrupt: bool)` / `{continue: bool}`。
      特に **`permission_suggestions`（「今後も許可」= localSettings への allow ルール追加提案）** の型
- [ ] ControlRequestTracker の**方向別非対称タイムアウト**が無い（pending map のみ、timeout 0 hit）: - inbound（CLI→host、人間の応答待ち）: タイムアウトなし - outbound（host→CLI、interrupt 等の ack 待ち）: 30 秒タイムアウト - プロセス exit 時に全 pending を reject
- [ ] `control_cancel_request` の扱い（未応答 permission 復元時の除外に必要）

### F. セッション管理

- [ ] `--resume <session_id>` + stream-json での再開は options に存在（`resume` / `fork_session` /
      `resume_session_at`）。**`-p` なし構成で同一 session_id のまま再開できるか実機確認**
      （#341 では検証済み。bartolli の実装が `--print` 前提の暗黙の仮定を持っていないか）
- [ ] initialize handshake が `-p` なしでも成立するかの smoke test（vendor 後の最初の作業）

### G. 型の同期手段

- [ ] `scripts/`（リポジトリ未配置。PoC は scratchpad にあり）: sdk.d.ts → JSON Schema → typify の
      ドラフト生成パイプライン。役割は**不足 variant のドラフト生成と上流 diff 検知のみ**
      （生成物を直接コミットする運用はしない — typify バグ 2 種と上流 .d.ts の壊れで断念済み）
- [ ] known-broken guard: sdk.d.ts 0.3.202 は **25 個の型が宣言漏れ**
      （`SDKControl*Request` 系 23 + `SDKControlRequestProgressMessage` + `SDKConversationResetMessage`、
      上流 issue: anthropics/claude-agent-sdk-typescript#363）。
      パイプラインは未定義名リストの完全一致を検査し、変化したら名前付きエラーで停止する

### H. monica との接続

- [x] 公開型に `specta::Type` derive を直付け（monica-api と同流儀で bindings.ts へ流す。feature gate 不要 —
      外部公開しない前提）。wire データ型のみ。callback / `CancellationToken` を含む runtime 型
      （`HookContext` / `HookMatcher` / `ToolPermissionContext` / `PermissionRequest` / `ClaudeAgentOptions` 等）には付けない。
      derive は通ったが bindings への export 検証は未実施（`#[serde(flatten)]` + `Value` を含む型が
      specta の export 時に通るかは bindings 編入時に確認）
- [ ] `just check`（clippy / fmt / coverage）への編入

### I. テスト

- [ ] #341 実測ログの fixtures 化と conformance test（パーサ・tracker・状態遷移を cargo test で検証）
- [ ] 実プロセス live smoke は `#[ignore]` でローカル実行のみ（CI でトークンを一切使わない）
- [ ] bartolli の既存テスト（client / control_protocol / security）は移植対象の参考にする

## Phase 計画

| Phase | 内容                                                                 | 完了条件                                                                   |
| ----- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0 ✅  | bartolli から `types/`・`error.rs`・`callbacks.rs`(trait) を移植済み | cargo test 通過（実測 fixtures での検証は Phase 2 の fixtures 整備と合流） |
| 1 ✅  | transport: spawn（A・B の全項目）+ 行単位 I/O                        | live smoke 通過: `-p` なし spawn → initialize → control_response(success)  |
| 2     | parser: 4 値 2 段デコード + raw event hook                           | fixtures 全通過・未知イベントが `Unknown` に落ちる                         |
| 3     | control: ControlRequestTracker（E の非対称タイムアウト）             | interrupt の ack 往復・can_use_tool 応答 3 形態                            |
| 4     | `query()` + streaming input（TS SDK 互換 interface）                 | 複数ターン対話の live smoke                                                |
| 5     | client 制御面: `set_model` / `set_permission_mode` / resume / fork   | #342 の Acceptance Criteria 相当                                           |
