## コード規約

- `@/lib/utils` の `cn()` のような自明な処理にコメントしない
- クラス結合は `cn(...)` 経由 (`twMerge(clsx(...))` の合成)
- shadcn コンポーネントは `bunx shadcn@latest add <name>` で追加。`src/components/ui/` 配下に入る
- パスエイリアス `@/*` は `src/*` を指す（`tsconfig.json` と `vite.config.ts` の両方で定義済み）

