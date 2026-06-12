## コード規約

- クラス結合は `cn(...)` 経由 (`twMerge(clsx(...))` の合成)
- パスエイリアス `@/*` は `src/*` を指す（`tsconfig.json` と `vite.config.ts` の両方で定義済み）

## ディレクトリ構成

- `app/` — アプリ全体のレイアウト
- `features/` — feature slice（UI・状態・ロジックを feature 単位にまとめたもの）
  - `features/work-bench/store.ts` — terminal state（jotai atoms）
  - `features/work-bench/ui/` — WorkBench UI コンポーネント
  - `features/work-board/ui/` — WorkBoard UI コンポーネント
- `spaces/` — 各 Space の組み立て層（registry のみ）
- `components/` — 共有 UI コンポーネント
- `commands/` — Tauri invoke ラッパー
- `hooks/` — React hooks
- `stores/` — jotai atoms（cross-feature な atoms）
- `lib/` — ユーティリティ
