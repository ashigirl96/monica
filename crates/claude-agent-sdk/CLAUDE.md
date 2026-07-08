# claude-agent-sdk

`claude` CLI を `-p` なしの stream-json I/O で駆動し、公式 TypeScript Agent SDK と
同じ interface で操作する Rust SDK。**subscription 課金枠を維持する**ことが存在意義。

- 実装計画・進捗・未着手項目は [TODO.md](./TODO.md)
- **過去に踏んだ失敗と理由は [GOTCHAS.md](./GOTCHAS.md)（変更前に必ず読む）**
- 関連 issue: #342（stream-json セッション種別）、#341（go 判定の検証ログ）

## 絶対に壊してはいけない不変条件

1. **課金レーン**: `-p` / `--print` を付けない。`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` を
   spawn 前に `env_remove` する。これらを破ると subscription 枠でなく SDK 消費レーンに落ちる。
   → 詳細は GOTCHAS.md「課金レーンを壊す 2 つのスイッチ」
2. **未知を落とさない**: `parse_line` は必ず全行をいずれかの variant に分類する。
   新イベント型は `Unknown` に流し、パース失敗でストリームを止めない（#342 原則）。
3. **wire の正典は実測**: 型は #341 実測ログ > 公式 sdk.d.ts > 参考実装 の順で信頼する。
   移植元の型（snake_case / tag 名）が実 wire と食い違うことがある。→ GOTCHAS.md

## レイヤ構成（下位ほど依存されない）

```
types/        wire データ型（serde + specta::Type）
error.rs      ClaudeError / Result
parser.rs     1 行 → ParsedLine（Message/Control/Unknown/Malformed/Empty）2 段デコード
transport/    claude を spawn し行単位 I/O。課金レーンの境界はここ
control/      ControlRequestTracker（outbound=30s ack / inbound=無期限）。I/O 非依存
query.rs      TS SDK 互換 query()。transport を単独所有する actor で全部束ねる
callbacks.rs  HookCallback / PermissionCallback trait
```

- **transport を触るのは actor だけ**。制御メソッドと reader を同一タスクで await 越しに
  待たせるとデッドロックする。→ GOTCHAS.md「actor デッドロック」
- SDK は **stateless**。journal 永続化・未応答 permission 復元は利用側（Monica）の責務で、
  SDK は `raw_events` hook と `ControlRequestTracker::pending_inbound()` を提供するだけ。

## テスト方針

- **CI で走る**（トークン消費ゼロ）: `--lib` unit / `--doc` / `tests/conformance.rs`
  （採取済み fixtures のパース）
- **ローカルのみ `#[ignore]`**: `tests/live_smoke.rs`（実プロセス）、
  `tests/transcript_drift.rs`（`~/.claude/projects` の最新実データ）、
  `tests/wire_drift.rs`（`~/.monica/claude-agent-sdk/wire-corpus/` の蓄積 wire）
- 実行: `cargo test -p claude-agent-sdk -- --ignored`
- **examples は人間が手で触るデモ・道具**（assert なし）。自動検証は必ず tests に書く:
  - 対話での動作確認: `cargo run -p claude-agent-sdk --example chat [-- <cwd>]`
  - fixtures / corpus の採取: `cargo run -p claude-agent-sdk --example capture_fixtures`
- **テストがハングしたら** `--lib` / `--test <name>` 単位 + `timeout` で切り分ける。
  一括 `cargo test` は「どのバイナリで固まったか」が見えない。→ GOTCHAS.md

## 変更時のルール

- 型を Rust 側で single source of truth にする（CLAUDE.md 型管理原則）。フロントに複製しない。
- フォーマットは `just fmt`。`cargo fmt` を直接呼ばない。
- 公開型に `specta::Type` を付けるのは wire データ型のみ。callback や `CancellationToken` を
  含む runtime 型には付けない。
