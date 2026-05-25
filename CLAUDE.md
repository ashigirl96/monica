# CLAUDE.md

monica は Tauri 2 + Bun + Vite + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui で構成されたデスクトップアプリ。

## 大原則: 配布バイナリのサイズを膨らませない

このプロジェクトは初期構成時点で「Five Aces」「`removeUnusedCommands`」「`default-features = false`」「`manualChunks` スケルトン」「esbuild drop/pure」「`build.target = es2022`」をすべて入れた状態で立ち上げている。**追加開発でこの状態を崩さない**ことが最優先の制約。

詳細な開発ガイドは @docs/dev.md にある。**依存を追加するとき・コードを書くときは必ずこのファイルを参照する**こと。特に以下の場面では `docs/dev.md` の該当章を読んでから手を動かす:

| 場面                                 | 参照する章                                               |
| ------------------------------------ | -------------------------------------------------------- |
| Rust クレートを追加する              | §2 (Rust 依存の引き締め)、§10 のチェックリスト           |
| フロント依存を追加する               | §4 (Vite ビルド)、§5 (動的 import)、§10 のチェックリスト |
| `#[tauri::command]` を追加・削除する | §3 (Tauri 設定)                                          |
| Tauri plugin を追加する              | §3.2                                                     |
| 重量級 UI コンポーネントを書く       | §5.2 (`React.lazy`)、§5.3 (遅延ロード判断)               |
| サイズが気になる                     | §8 (計測)、`just analyze` / `just bloat` / `just size`   |

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

レシピ一覧は `justfile` または @docs/dev.md §11。

## Git フック

`bun install` が `package.json` の `prepare` で `git config core.hooksPath .githooks` を自動設定する。`.githooks/pre-push` が `just check` を走らせるので、push のたびに lint + fmt-check + clippy が通る必要がある。手動で再設定するなら `git config core.hooksPath .githooks`。

## 即落ちする地雷

1. **Rust クレート追加時に `default-features = false` を忘れる** → `tokio` や `reqwest` がフル feature で入ってサイズが跳ねる
2. **静的 import で重量級依存を入れる** → 起動時に全部読み込まれる。条件分岐先の依存は `await import(...)` にする
3. **`oxlint.config.ts` を作る** → Node 22.18+ 要件で CI が落ちる。JSON 設定 `.oxlintrc.json` を維持
4. **`console.log` を残す** → 本番に残るので、デバッグ出力は `console.debug` 等にして `vite.config.ts` の `pure` に削らせる

## コード規約

- コメントは「なぜ」が非自明な場合のみ。`@/lib/utils` の `cn()` のような自明な処理にコメントしない
- クラス結合は `cn(...)` 経由 (`twMerge(clsx(...))` の合成)
- shadcn コンポーネントは `bunx shadcn@latest add <name>` で追加。`src/components/ui/` 配下に入る
- パスエイリアス `@/*` は `src/*` を指す（`tsconfig.json` と `vite.config.ts` の両方で定義済み）

## アーキテクチャの場所

| 役割                   | パス                           |
| ---------------------- | ------------------------------ |
| Rust エントリ          | `src-tauri/src/main.rs`        |
| Tauri コマンド         | `src-tauri/src/lib.rs`         |
| Tauri 設定             | `src-tauri/tauri.conf.json`    |
| Vite 設定              | `vite.config.ts`               |
| Tailwind / CSS変数     | `src/styles/globals.css`       |
| フロントエンドエントリ | `src/main.tsx` → `src/App.tsx` |

詳しいファイル早見表は @docs/dev.md §12。
