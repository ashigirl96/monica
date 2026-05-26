# monica-app（Tauri）固有の罠

`crates/monica-app/` 配下で作業するときに気をつける点だけをまとめる。
全体方針 (Tauri 2 + Bun + Vite + サイズ最優先) はリポジトリルートの
[CLAUDE.md](../../CLAUDE.md) と [docs/dev.md](../../docs/dev.md) を参照すること。

## 絶対に崩さないもの

1. **`[profile.release]` の Five Aces**（**ワークスペース root の `Cargo.toml`**）
   `codegen-units = 1` / `lto = "fat"` / `opt-level = "s"` / `panic = "abort"` / `strip = true`
   どれか 1 つでも欠けると配布バイナリが目に見えて膨らむ。profile はメンバー crate 側に書いても Cargo に無視されるので、必ず root に置く。`docs/dev.md §1` 参照。
2. **`removeUnusedCommands: true`** (`tauri.conf.json` の `build`)
   フロントが `invoke()` していない `#[tauri::command]` をビルド時に削除する。
   これを切ると Tauri 内蔵コマンドが 70 個近く残って肥大化する。
3. **`[profile.dev].incremental = true`**（ワークスペース root の `Cargo.toml`）
   release 側の重い最適化を dev に持ち込まないため必要。

## 依存クレート追加時のチェック

- `default-features = false` を必ず付ける。`tokio` や `reqwest` を default で入れると数 MB 級の事故になる。
- 必要な feature だけ `features = [...]` に列挙する。既存依存
  (`tauri` / `serde` / `serde_json` / `tauri-build`) はこの方針で書かれている。
- 追加前後で `just bloat` を走らせてサイズ差を確認する。
- 詳細手順は `docs/dev.md §2` と `§10` のチェックリスト。

## `#[tauri::command]` を増やす/減らすとき

- 不要になったコマンドはソースからも削除する (`removeUnusedCommands` は
  自動で消してくれるが、死荷物をソースに残さない)。
- 新規 plugin (`tauri-plugin-*`) を入れたら `capabilities/default.json` の
  `permissions` を更新する。現状は `["core:default"]` のみ。

## 規約

- `unwrap()` / `expect()` / `let _ = fallible()` は避け、`?` で伝播する。
- パニックしうるインデックスアクセスに注意。
- コメントは「なぜ」が非自明なときだけ書く (ルート CLAUDE.md と同じ規約)。
- PR 前は `just check` (= oxlint + oxfmt --check + `cargo clippy --all-targets -- -D warnings`)。
