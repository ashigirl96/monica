# CLAUDE.md

## よく使うコマンド

```bash
just dev           # 開発: Tauri ウィンドウ + Vite
just build         # release ビルド (.app のみ。配布物は CI で生成)
just install-local # .app をビルドして /Applications/Monica.app に配置
just check         # lint + fmt-check + cargo clippy (PR 前必須)
just analyze       # dist/stats.html で chunk を可視化
just bloat         # Rust 依存サイズ内訳
just size          # dist/ と bundle/ のサイズ表示
```

## コード規約

- コメントは「なぜ」が非自明な場合のみ。
