# monica

Tauri 2 + Bun + Vite + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui で構成したデスクトップアプリ。

配布バイナリのサイズを膨らませないことを最優先の設計制約としている（Five Aces, `removeUnusedCommands`, `manualChunks`, esbuild drop/pure, `build.target=es2022`, `default-features = false`）。詳細は [`docs/dev.md`](./docs/dev.md)。

---

## 必要なツール

- [Rust toolchain](https://www.rust-lang.org/tools/install) (`rustc`, `cargo`)
- [Bun](https://bun.sh/) >= 1.3
- [just](https://github.com/casey/just) >= 1.0
- Platform 依存: macOS は Xcode CLT、Linux は `webkit2gtk-4.1`、Windows は WebView2 (Win11 標準)

## セットアップ

```bash
bun install
just dev
```

`just dev` は Vite を `http://localhost:1420` で立ち上げ、Tauri ウィンドウを開く。

## コマンド

| コマンド                      | 説明                                                    |
| ----------------------------- | ------------------------------------------------------- |
| `just dev`                    | Tauri ウィンドウ + Vite dev server                      |
| `just build`                  | release ビルド（配布物まで生成）                        |
| `just build-debug`            | デバッグ情報入りビルド                                  |
| `just preview`                | フロントエンドだけプレビュー                            |
| `just lint`                   | oxlint                                                  |
| `just fmt` / `just fmt-check` | oxfmt                                                   |
| `just check`                  | lint + fmt-check + cargo check                          |
| `just analyze`                | `dist/stats.html` を出力（rollup-plugin-visualizer）    |
| `just bloat`                  | Rust 依存のサイズ内訳（要 `cargo install cargo-bloat`） |
| `just size`                   | フロント `dist/` と Tauri バンドルのサイズ表示          |
| `just clean`                  | `dist`, `node_modules`, `src-tauri/target` を削除       |

## shadcn/ui コンポーネントの追加

```bash
bunx shadcn@latest add button
```

`components.json` の `aliases` に従って `src/components/ui/` 配下に追加される。

## 依存を追加するときの注意

バイナリサイズの最適化を維持するため:

1. **Rust 依存**: 必ず `default-features = false` を付け、必要な feature だけ列挙する
2. **重量級フロント依存**（エディタ、グラフ、AI SDK など）: 静的 import せず `await import(...)` で動的ロード
3. **`manualChunks`** (`vite.config.ts`): 重量級依存は独立 chunk に切る
4. **不要な Tauri command**: 削除すれば `removeUnusedCommands` が自動で Rust 側も削る

## サイズを計測する

```bash
just build         # 配布物まで作る
just size          # dist/ と bundle/ のサイズ
just analyze       # dist/stats.html で chunk の内訳
just bloat         # Rust 依存のサイズ内訳
```

配布される `.dmg` / `.msi` / `.deb` のサイズが最終的な答え。
