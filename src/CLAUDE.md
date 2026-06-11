## コード規約

- クラス結合は `cn(...)` 経由 (`twMerge(clsx(...))` の合成)
- パスエイリアス `@/*` は `src/*` を指す（`tsconfig.json` と `vite.config.ts` の両方で定義済み）

## ディレクトリ構成

- `app/` — アプリ全体のレイアウト
- `features/` — React 非依存の feature runtime（stores から参照される registry 類）
- `spaces/` — 各 Space 固有の UI（sidebar / header / content）
- `components/` — 共有 UI コンポーネント
- `commands/` — Tauri invoke ラッパー
- `hooks/` — React hooks
- `stores/` — jotai atoms
- `lib/` — ユーティリティ
