# CLAUDE.md

## よく使うコマンド

```bash
just dev           # 開発: Tauri ウィンドウ + Vite
just build         # release ビルド (.app のみ。配布物は CI で生成)
just install-local # .app をビルドして /Applications/Monica.app に配置
just check         # lint + fmt-check + cargo clippy (PR 前必須)
just test          # cargo test --workspace
just analyze       # dist/stats.html で chunk を可視化
just bloat         # Rust 依存サイズ内訳
just size          # dist/ と bundle/ のサイズ表示
```

## コード規約

- コメントは「なぜ」が非自明な場合のみ。

## PROGRESS.md

- [`PROGRESS.md`](./PROGRESS.md) は monica の「Goal」「Timeline」を集約する進捗ログ。
- 機能を追加・変更したら必ず `PROGRESS.md` を更新する。方向性が決まったら `## 向かう先` に反映する。
- **Timeline 記述ルール**: 1 項目 1〜2 行。`- YYYY-MM-DD 何をしたか（なぜ）` 形式で、新しいものを末尾に追記する。長くなる説明は書かない。
- 着手予定は `## Todo` に `- [ ]` で積み、完了したら Timeline に 1 行で移す。
