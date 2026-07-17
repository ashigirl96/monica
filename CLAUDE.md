# CLAUDE.md

**Monicaは、私の関心・知識・タスク・開発作業・エージェントの実行状態をひとつの作業空間に統合する、個人用のAgentic Workspaceである。**

単なるタスク管理ツールではない。単なるIDEでもない。単なるWikiでも、RSSリーダーでも、Slack botでもない。

Monicaは、私が日々考えたこと、読んだもの、任されたこと、作りたいもの、調べたいこと、実装したいことを受け取り、それを知識・タスク・計画・エージェント実行・成果物へと変換していくための環境である。

一言で言えば、

> **Monicaは、私とAIエージェントが一緒に仕事を進めるための、個人用Agent OSである。**

## よく使うコマンド

```bash
just dev           # 開発: Tauri ウィンドウ + Vite
just dev-cli       # CLI ビルドして ./monica に配置
just build         # release ビルド (.app のみ。配布物は CI で生成)
just install-app   # .app をビルドして /Applications/Monica.app に配置
just check         # lint + fmt-check + knip + unused-commands + dup + cargo clippy (PR 前必須)
just knip          # 未使用 export/依存の検出 (--fix で自動削除)
just unused-commands  # bindings.ts のコマンドがフロントで使われているか照合
just dup           # 100 トークン以上の逐語コピペ検知 (jscpd。check に含まれる)
just generate-bindings  # Rust の型・コマンドから bindings.ts を再生成
just test          # cargo test --workspace
just coverage      # Rust カバレッジ (0% の pub fn = workspace 横断では clippy に映らない dead code 候補)
just analyze       # dist/stats.html で chunk を可視化
just bloat         # Rust 依存サイズ内訳
just size          # dist/ と bundle/ のサイズ表示
```

## 型の管理原則

enum・struct・定数は Rust (backend) を single source of truth とし、フロントでは二重定義しない。
`just generate-bindings` で `desktop/commands/bindings.ts` に TypeScript 型が自動生成される。

- Rust 側で型やコマンドを追加・変更したら `just generate-bindings` を実行する。
- `bindings.ts` は手動編集しない（`just dev` 起動時にも上書きされる）。
- 型だけでなくビジネスルール（status による可否判定・フィルタ・入力パース）も Rust 側に置き、
  結果をフィールドやコマンドとして公開する。フロントに判定用の Set 定数や正規表現を複製しない。

## コード規約

- コメントは「なぜ」が非自明な場合のみ。
- フォーマットは `just fmt` を使う。biome や cargo fmt を直接呼ばない。

## テスト規約

- **MONICA_HOME 隔離は 3 層構成**（テストが実データの home を継承して本物の DB を触る事故の防止）:
  1. `just test` / `just coverage` が実行ごとに `mktemp -d` の home を注入する — 標準経路は
     crate 側の対応なしで安全。
  2. 生の `cargo test -p <crate>` 向けの防衛線として、MONICA_HOME 依存のテストを持つ crate は
     `#[ctor::ctor]` で main 前に temp home へ差し替える（例: `monica-adapters/src/test_support.rs`）。
  3. `std::env::set_var` / `remove_var` は clippy の disallowed-methods（`clippy.toml`）で禁止 —
     テスト内で env を書き換えるコードは `just check` で機械的に落ちる。正当な例外
     （ctor・起動直後の単一スレッド区間）だけ `#[allow(clippy::disallowed_methods)]` を理由付きで付ける。
- cargo を生で叩くときの注意: `monica-desktop` の build script は
  `binaries/monica-ptyd-<host-triple>` を要求する。`just check` / `just test` は `ptyd-bin` 依存で
  自動生成されるが、生の `cargo check --workspace` 等が落ちたら先に `just ptyd-bin` を実行する
  （新規 worktree は `.monica/setup.sh` が用意する）。
