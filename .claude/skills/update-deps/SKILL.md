---
name: update-deps
description: Rust（Cargo）と TypeScript（bun）の依存ライブラリを互換更新＋メジャー検証でアップデートする。
disable-model-invocation: true
---

# update-deps

依存を 2 層に分けて上げる。**互換更新（compatible）** は semver 範囲内なのでツール一発で安全。**メジャー更新（major）** は breaking を跨ぐので 1 件ずつコンパイルとテストで検証する。この分離が全体の背骨。

## 前提（monica 固有）

- TypeScript のパッケージマネージャは **bun**。npm / yarn / pnpm は使わない。
- フォーマットは `just fmt`、検証は `just check` / `just test`。ただし **`just check` も `just test` も TS の型検査をしない** — 型エラーは `bunx tsc --noEmit` でしか出ない。
- Rust の依存は `crates/*/Cargo.toml` に分散（`[workspace.dependencies]` は未使用）。`.worktrees/` と `docs/repos/` は対象外。
- `specta` / `specta-typescript` / `tauri-specta` は `=2.0.0-rc.25` 等で **pin** 済み（bindings 生成の互換性固定）。
- ユーザーが言語を指定しなければ Rust・TypeScript の両方を対象にする。

## 手順

### 1. 互換更新（compatible）を一括適用

対象言語ぶんを実行する:

- TypeScript: `bun update`
- Rust: `cargo update`

Cargo.toml の `"1.0.102"` は caret 要件（`^1.0.102`）なので、文字列を書き換えなくても `cargo update` で Cargo.lock の実体が 1.x 系最新に上がる。

**完了基準**: 両コマンドが成功し lockfile（`bun.lock` / `Cargo.lock`）が更新される。

### 2. メジャー候補（major）を検出

caret 範囲では上がらない＝メジャーを跨ぐ候補を洗い出す:

- TypeScript: `bun outdated`。**Update 列 ≠ Latest 列** のものがメジャー候補。一致していれば互換更新で最新到達済み＝候補なし。
- Rust: `cargo outdated --workspace --root-deps-only`。**Compat 列が `---` で Latest に値がある** ものが候補。未インストールなら先に `cargo install cargo-outdated`（ビルドに数分かかるのでバックグラウンド可）。

pin 済みの specta 系は候補から除外する。

**完了基準**: 各言語のメジャー候補リスト（空でも可）が確定する。

### 3. メジャー更新を 1 件ずつ適用・検証

候補を 1 件ずつ処理する。**連動依存はまとめて** — 例: `rusqlite` と `rusqlite_migration` は後者が前者の新メジャーに依存するため同時に上げる:

1. `Cargo.toml` / `package.json` のバージョンを書き換える。
2. lockfile を解決する（Rust: `cargo update -p <name>`）。
3. コンパイル／型チェックで breaking を見る（Rust: `cargo check -p <crate> --all-targets` / TS: `bunx tsc --noEmit`）。
4. 通れば残す。エラーは breaking change — 直せれば直す。深掘りが要るなら **その 1 件だけ revert** してユーザーに報告し、残りを続ける。

**完了基準**: 上げた各 major がコンパイル成功、または revert 済みで未解決理由を記録。1 件の失敗で他を巻き添えにしない。

### 4. 全体検証

すべての更新後、まとめて検証する:

- `just check`（lint + fmt-check + clippy + knip + dup の PR 前ゲート。**警告・エラー 0**）
- `just test`（**失敗 0**）
- TypeScript: `bunx tsc --noEmit` と `bunx tsc --noEmit -p tsconfig.node.json`、`bun --bun vite build`

**完了基準**: `just check` green・テスト失敗 0・型エラー 0・build 成功をすべて確認。1 つでも赤なら手順 3 に戻る。

### 5. 報告

- `git status --short` で変更ファイルを示し、更新内容（パッケージ名と新旧バージョン）を一覧化する。
- **`bun update` の副作用に注意** — `package.json` の `^` 下限を実インストール版へ引き上げる（例: `"@tauri-apps/api": "^2"` → `"^2.11.1"`）。意図的に緩くしていた制約があれば、その行を戻すかユーザーに確認する。

### 6. PR を作成

`create-pr` スキルを呼び出し、コミット・PR 作成・browser で開くまでを任せる。

**完了基準**: `create-pr` が PR の URL を返す。
