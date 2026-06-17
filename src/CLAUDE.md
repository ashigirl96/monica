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

## TanStack Query 方針

導入理由は Tauri `invoke` を隠すことではない。`commands/` の型付き invoke wrapper は境界として残し、
TanStack Query は backend/SQLite/GitHub 由来の非同期 snapshot を cache / invalidate / polling する層として使う。
適用範囲は Work Board の read model（Task / Project / Board column の snapshot）に限る。WorkBench topology・
terminal lifecycle・TaskRun 実行制御へは広げない（terminal status は `use-terminal` の optimistic override が
あり imperative 維持。将来 Query 化するなら baseline + override の merge 層を別設計する）。
既存の Jotai 境界に合流するデータは `jotai-tanstack-query` + `@tanstack/query-core` を第一候補にし、
component-local な都合が強い場合だけ React hooks 直利用を検討する。
QueryClient は singleton。render 前に `main.tsx` の bootstrap で `getDefaultStore().set(queryClientAtom, queryClient)`
を呼び default store に注入する（`<Provider>` / `useHydrateAtoms` は store 二重化・StrictMode 二重ハイドレートを
避けるため不採用）。

Do:

- Tauri invoke wrapper の上に `atomWithQuery` / `atomWithMutation` を置く
- Task / Project / TaskRun / PR / event timeline の snapshot 取得に使う
- mutation 後の invalidate を標準化する
- polling を Query 側に寄せる
- Rust 由来の `DisplayStatus` / column 定義はそのまま使う
- Query key と invalidate helper を共有し、feature ごとの手書き refresh を増やさない
- Tauri app 向けに `retry` / `refetchOnWindowFocus` / `staleTime` / `refetchInterval` の default を明示する
- Work Board 復元は `loadBoard()`（`ensureQueryData`）成功後に一度だけ行う（`loadBoard().then(applyRestored)` の順序保証を保つ）
- 派生 atom（`atomWithQuery(...).data` を unwrap する read atom）は cache 更新を `notifyManager` の `setTimeout(0)` で1拍遅れて反映する。`await ensureQueryData` / `await invalidateQueries` の直後に同期で必要な値は、派生 atom でなく `client.getQueryData(key)`（cache 直読み・同期で fresh）から取る
- `tasks.summary(project)` は `project: string | null` を同じ query family として扱い、Sidebar 用の unfiltered read は `null` key に寄せる
- Query key で再取得する state setter から、手動 refresh 副作用を残さない
- 純粋な mutation（invoke + invalidate のみ）は `atomWithMutation` にし、onSuccess で query family を invalidate する
- 楽観更新はしない（invalidate → refetch で表示を更新する）

Don't:

- jotai/terminal を orchestrate する mutation（runspace cleanup・navigate・primaryTab refresh 等）を `atomWithMutation` 化する。`atomWithMutation` の onSuccess からは jotai の `set` を呼べないため、これらは write atom のまま残し既存の invalidate helper を呼ぶ

- TanStack Query を domain state の source of truth にする
- TaskRun lifecycle を Query cache で進める
- Terminal/PTY stream を Query で扱う
- local UI state まで Query に寄せる
- Tauri store や SQLite が owner の永続状態を Query cache persistence で置き換える
- 生成された `commands/bindings.ts` を Query 化のために手動編集する
- 既存 throttle と Query `staleTime` / polling を二重に持つ
