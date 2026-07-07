# GOTCHAS

この crate の実装中に実際に踏んだ失敗と、その根本原因。同じ罠を再度踏まないための記録。
新しい罠を踏んだら追記する。

---

## 課金レーンを壊す 2 つのスイッチ（最重要）

**症状**: 気づかないうちに subscription (five_hour) 枠でなく SDK クレジット消費レーンで課金される。

**原因**: 移植元（bartolli/anthropic-agent-sdk）は 2 つの「SDK として振る舞う」設定を入れていた。

1. `--print`（`-p`）を常時付与 — one-shot モードは SDK 消費レーンに入る
2. `CLAUDE_CODE_ENTRYPOINT=sdk-rust` を **設定** していた

**対処**: `-p` は付けず stream-json 双方向を唯一のモードにする。entrypoint 系は設定ではなく
**除去**する。`transport/subprocess.rs` の `REMOVED_ENV_VARS` で `CLAUDECODE` /
`CLAUDE_CODE_ENTRYPOINT` を `env_remove`。これらは #341 で「`-p` なし + entrypoint 除去なら
subscription 枠」と実測検証済み。`build_args` に `--print` が混入しないことを unit test で固定してある。

**教訓**: 参考実装をコピーするときは「SDK として名乗る」系の設定を最優先で洗う。

---

## PermissionResult の wire 形式が移植元と違った

**症状**: can_use_tool への応答を送っても permission が効かない可能性（deny が無視される等）。

**原因**: 移植元の `PermissionResult` は `#[serde(tag = "type", rename_all = "lowercase")]` +
フィールド snake_case で、`{"type":"allow","updated_input":...}` と serialize していた。
だが実 wire（#341 実測・sdk.d.ts）は **`behavior` タグ + camelCase**:
`{"behavior":"allow","updatedInput":...}` / `{"behavior":"deny","message":...,"interrupt":false}`。

**対処**: `types/permissions.rs` で `#[serde(tag = "behavior")]` + `rename_all = "camelCase"` に修正。
`PermissionRuleValue` も camelCase 化し、`PermissionUpdate` の rule 系 variant に TS 型にあった
`behavior` フィールドを補った。応答 3 形態の wire 形状を unit test（`permission_responses_match_wire_format`）で固定。

**教訓**: 手書き移植の型は wire と drift している前提で、判別子タグ名とフィールドの命名規則を
実測ログと 1 つずつ突き合わせる。permission のような「送信して相手が解釈する」型は特に
`behavior` deny の実効性（対象ファイルが作られないか）まで live smoke で確認する。

---

## actor デッドロック: 待つ主体と解決する主体が同一

**症状**: `query()` が initialize で 30 秒ハングし `ControlTimeout` で落ちる。

**原因**: actor の `run()` が select ループに入る **前** に `init_ack.wait().await` していた。
だが init の control_response を解決するのは、その下の reader ループ内の `handle_control`。
「ack を待つ主体」と「ack を解決する主体」が同じタスクで直列になり、永久に噛み合わない。

**対処**: init ack の待機を `tokio::spawn` で別タスクに逃がし、reader ループを即座に回す。
ack 失敗だけを message ストリームにエラーとして流す。

**教訓**: actor パターンでは「I/O を回すループ」と「その結果を await する側」を必ず別タスクに
分ける。制御メソッド（interrupt 等）の ack 待ちも同じ理由で別タスクに逃がしてある。

---

## tokio::select! に macros feature が要る

**症状**: `could not find 'select' in 'tokio'` でコンパイル不能。エラーに到達するまでの
フルビルド時間で「テストが遅い/固まった」ように見えた。

**原因**: `tokio::select!` は `macros` feature 必須。本体 dependencies に入れ忘れていた
（dev-dependencies にはあった）。

**対処**: 本体の tokio features に `macros` を追加。

**教訓**: 「テストが遅い」ときはまず `cargo build` だけ切り出して、コンパイルエラーで
止まっているのか実行時ハングなのかを分ける。

---

## mpsc 受信テストが永久ハング

**症状**: unit test が全件 pass 表示の後に固まる。

**原因**: `let (_tx, rx) = mpsc::unbounded_channel();` の `_tx` は `_` 始まりでも
**スコープ終端まで生きる**（即時 drop されない）。送信側が生存している限り
`poll_recv` は Pending を返し続け、`rx.next().await` が永久に待つ。

**対処**: Stream が閉じることを確認したいなら、明示的に送信側を `drop(msg_tx)` してから
`next().await` する。

**教訓**: `_` プレフィックスは「未使用警告の抑制」であって「早期 drop」ではない。
channel の close 挙動をテストするときは drop のタイミングを明示する。

---

## specta rc.25 の feature 宣言漏れ

**症状**: `cargo check -p claude-agent-sdk` 単独で `specta::Type is not implemented for Vec<Value>`。
workspace 全体ビルドでは通る。

**原因**: `specta = "=2.0.0-rc.25"` の `serde_json` feature が `std` を暗黙に前提とするが、
feature 依存が宣言されていない。workspace では他 crate が `std` を有効化するので露見せず、
単独ビルドでだけ壊れる。

**対処**: features に `std` を明示（`["derive", "std", "serde_json"]`）。

**教訓**: rc / pre-release の依存は feature の推移的宣言が抜けていることがある。
単独 `cargo check -p <crate>` で feature unification に頼らない状態を検証する。

---

## transcript JSONL は wire フォーマットではない

**内容**: `~/.claude/projects/**/*.jsonl`（Monica の #339 が watch）は stream-json の
wire とは別物。同じ `assistant` でも wire は `session_id`（snake_case）+ 通信用最小情報、
transcript は `sessionId`（camelCase）+ `parentUuid` / `timestamp` / `cwd` / `gitBranch` 等の
保存用封筒フィールド付き。`file-history-snapshot` / `attachment` 等の transcript 専用行もある。

**なぜ transcript_drift テストが成立するか**: `message` の中身（content blocks 等）は wire と
共通で、serde が未知フィールドを無視し欠損 Option を None にするため、大部分が型付きパースを通る。
完全な wire 検証は `wire_drift.rs`（生 wire コーパス）が担う。

**教訓**: 「wire に近似」であって「wire そのもの」ではない。パーサが対象にするのは wire で、
transcript はたまたま大部分が通るコーパス、という線引きを崩さない。

---

## 型自動生成（sdk.d.ts → typify）は断念した

**内容**: 公式 `sdk.d.ts` から JSON Schema 経由で Rust 型を生成する PoC を試したが、常用は断念。

**踏んだ壁**:

- sdk.d.ts 0.3.202 は **25 個の型が宣言漏れ**（`SDKControl*Request` 系 + `SDKControlRequestProgressMessage`
  等）。union に現れるが定義がなく、`skipLibCheck` 下では `any` に潰れる（上流 issue
  anthropics/claude-agent-sdk-typescript#363）
- typify が `NonNullable<...>` 由来の型名でパニック、`ContentBlockSourceContent` の生成バグ
- ts-json-schema-generator が `@deprecated` を boolean でなく string で出力し typify が拒否

**結論**: 型は手書き移植を正典にし、typify パイプラインは「不足 variant のドラフト生成 +
上流 diff 検知」の補助ツールに格下げ（TODO.md G 項）。生成物を直接コミットする運用はしない。

**教訓**: 上流 .d.ts を機械処理の入力にすると、上流の壊れ方に恒久的に追従することになる。
「うるさく壊れる」codegen より「実測で検証された手書き型」の方が総コストが低い場面がある。
