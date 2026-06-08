# CLAUDE.md

**Monicaは、私の関心・知識・タスク・開発作業・エージェントの実行状態をひとつの作業空間に統合する、個人用のAgentic Workspaceである。**

単なるタスク管理ツールではない。単なるIDEでもない。単なるWikiでも、RSSリーダーでも、Slack botでもない。

Monicaは、私が日々考えたこと、読んだもの、任されたこと、作りたいもの、調べたいこと、実装したいことを受け取り、それを知識・タスク・計画・エージェント実行・成果物へと変換していくための環境である。

## よく使うコマンド

```bash
just dev           # 開発: Tauri ウィンドウ + Vite
just dev-cli       # CLI ビルドして ./monica に配置
just build         # release ビルド (.app のみ。配布物は CI で生成)
just install-app   # .app をビルドして /Applications/Monica.app に配置
just check         # lint + fmt-check + cargo clippy (PR 前必須)
just test          # cargo test --workspace
just db-validate   # Atlas で SQLite schema.sql と migrations を検証
just analyze       # dist/stats.html で chunk を可視化
just bloat         # Rust 依存サイズ内訳
just size          # dist/ と bundle/ のサイズ表示
```

## コード規約

- コメントは「なぜ」が非自明な場合のみ。
- SQLite schema の最新形は `crates/monica-infra/src/sqlite/schema.sql` を source of truth とする。変更後は `just db-migrate-diff <name>` で migration を生成し、`just db-validate` で Atlas 検証を通す。
- Atlas は開発/CI 用。Monica runtime は起動時にチェックイン済み migration SQL を Rust/rusqlite で未適用分だけ適用するため、`just install-app` / `just install-cli` に Atlas apply は組み込まない。
