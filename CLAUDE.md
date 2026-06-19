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
`just generate-bindings` で `src/commands/bindings.ts` に TypeScript 型が自動生成される。

- Rust 側で型やコマンドを追加・変更したら `just generate-bindings` を実行する。
- `bindings.ts` は手動編集しない（`just dev` 起動時にも上書きされる）。
- 型だけでなくビジネスルール（status による可否判定・フィルタ・入力パース）も Rust 側に置き、
  結果をフィールドやコマンドとして公開する。フロントに判定用の Set 定数や正規表現を複製しない。

## コード規約

- コメントは「なぜ」が非自明な場合のみ。
- フォーマットは `just fmt` を使う。biome や cargo fmt を直接呼ばない。
