# TanStack Query Migration TODO

## 方針

- `commands/` の Tauri invoke wrapper は残し、その上に `atomWithQuery` / `atomWithMutation` を置く。
- TanStack Query は backend/SQLite/GitHub 由来の snapshot cache として使う。
- Jotai は local UI state、navigation、WorkBench topology、terminal lifecycle の owner として残す。
- 既存の Jotai 境界に合流する read model は `jotai-tanstack-query` + `@tanstack/query-core` を第一候補にする。
- Rust 由来の `DisplayStatus`、`BoardColumn`、command bindings を single source of truth として維持する。

## Phase 1: Query 基盤 ✅ 完了（Issue #125 / PR #126）

確定した設計判断:

- 注入方式: render 前に `getDefaultStore().set(queryClientAtom, queryClient)`（`<Provider>` / `useHydrateAtoms` は不採用）。
- `atomWithQuery`（非 Suspense）を採用（restore timing を変えない・`.data ?? []` で同期 unwrap）。
- 実消費は `projects.list` のみを PoC として Query 化。`projectsAtom` は query data を unwrap する read-only derived atom。
- `loadBoard` は `ensureQueryData` で同一 key の cache を温めてから restore が走る順序を保証（退行なし実証）。

- [x] `jotai-tanstack-query@0.11.0` と `@tanstack/query-core@5.101.0` を追加する。
- [x] 依存追加前に peer 要件を照合する。
  - [x] `jotai-tanstack-query@0.11.0` は `jotai >=2.0.0` / React 18 or 19 を満たす。
  - [x] `@tanstack/react-query` は optional peer なので、未追加で型・bundle・runtime が通るか確認する。
  - [x] optional peer を入れない場合でも docs / code comment に意図を残す。
- [x] `QueryClient` を作り、Jotai 側から同じ client を参照できる初期化を `src/main.tsx` 近辺に追加する。
- [x] 最小 PoC で QueryClient 注入方式を決める → `getDefaultStore().set(queryClientAtom, queryClient)` を render 前に呼ぶ方式に確定。
  - [x] `<Provider>` 追加は避ける（既存 `getDefaultStore()` と同一 store に統一して store 二重化を回避）。
  - [x] `useHydrateAtoms` は使わない（StrictMode で二重ハイドレートする）。
- [x] `@tanstack/react-query` は component-local hook が必要になった場合だけ追加を検討する（Phase 1 では未追加）。
- [x] Monica 向け default を決める。
  - [x] Tauri command の失敗を過剰 retry しない（`retry: 1`）。
  - [x] window focus refetch は原則無効にする（`refetchOnWindowFocus: false`）。
  - [ ] fresh/stale はイベント invalidate と明示 polling を中心にする（Phase 4 で確定）。
- [x] Query cache persistence は導入しない。
  - [x] UI intent は Tauri store のまま維持する。
  - [x] WorkBench topology / terminal session は SQLite と Jotai の既存境界を維持する。
- [x] query key の命名規則を作る（`src/stores/query-keys.ts`）。
  - [x] `tasks.summary(project: string | null)`
  - [x] Work Board の filtered read と Sidebar の unfiltered read は同じ query family で扱い、unfiltered は `project: null` にする。
  - [x] `projects.list`
  - [x] `board.columns`
  - [x] `taskRuns.primaryTab(taskId)`
  - [ ] `prs.syncState` / `eventTimeline.snapshot` は実装時に追加する。
- [x] query key を共有 module に集約する（invalidate helper は消費者が出る Phase 3 で追加）。
- [x] `atomWithQuery` と `atomWithSuspenseQuery` のどちらを使うか → 非 Suspense の `atomWithQuery` に確定。
  - [x] 既存の `<Suspense>` 境界は lazy component 用なので、Query の Suspense 化で表示や restore timing が変わらないか確認する。
  - [x] Work Board restore の success 状態を明示的に扱いやすい方を選ぶ。

## Phase 2: Work Board read model

- [ ] `listTaskSummaries(project)` の query atom を作る。
- [ ] `listProjects()` の query atom を作る。
- [ ] `getBoardColumns()` の query atom を作る。
- [ ] `taskSummariesAtom` / `projectsAtom` / `boardColumnsAtom` は「query の data を unwrap する薄い derived atom」として温存する。これで `columnTasksAtom` と nav 系（`workboard-nav.ts` の focus / move / taskById / applyRestored）を無改修のまま移行する。
- [ ] `src/stores/workboard.ts` の `loadBoardAtom` / `refreshTaskSummariesAtom` を Query 由来に置き換える。
- [ ] Sidebar 用の `refreshTaskStatusMapAtom`（unfiltered = `tasks.summary(null)`）も同 family で扱い、invalidate は family 全体（`['tasks','summary']` プレフィックス）を倒して filtered/unfiltered 両方を更新する。
- [ ] `selectedProjectAtom` は UI state として残し、query key の入力にだけ使う。
- [ ] `selectedProjectAtom` の write 側にある `void set(refreshTaskSummariesAtom)` を削除し、project 変更による再取得は query key 変更だけにする。
- [ ] `columnTasksAtom` 相当の projection は Rust 由来の column/status 定義を使って維持する。
- [ ] Work Board 復元処理は、Query のロード完了後に既存の `applyRestoredWorkboardAtom` を一度だけ呼ぶ形へ移す。
  - [ ] `loadBoard().then(() => applyRestored())` の順序保証を失わない。
  - [ ] `projects` と `task summaries` の両方が success になってから restore hint を検証する。
  - [ ] restore 後の `selectedProjectAtom` 変更で query key が変わる場合、focus 検証をどの snapshot に対して行うか PoC で決める。
  - [ ] restore は冪等に・一度だけ発火させ、StrictMode の effect 二重マウントに耐えるようにする（`set(selectedProjectAtom)` → key 変更 → refetch → restore 判定 の循環を起こさない）。

## Phase 3: Mutation と invalidate

- [ ] `trackGithubIssue` を `atomWithMutation` 化し、成功後に task/project 関連 query を invalidate する。
- [ ] `prepareTask` を `atomWithMutation` 化し、成功後に task summary を invalidate する。
- [ ] `deleteTask` を `atomWithMutation` 化し、既存の WorkBench runspace cleanup を維持したまま task summary を invalidate する。
  - [ ] `removeRunspaceAtom(..., "terminate")` 相当の cleanup を await 可能にし、必要な terminate / session refresh が settle してから invalidate する。
  - [ ] task summary と terminal/session snapshot の invalidate 順序を分ける必要があるか PoC で確認する。
- [ ] 楽観更新はしない（invalidate による再取得で表示を更新する）方針を明記する。
- [ ] `makeMainTaskRun` 後の `taskRuns.primaryTab(taskId)` と task summary invalidate を標準化する。
- [ ] `runTaskFlow` は lifecycle orchestration として残し、最後の再取得だけ Query invalidate に寄せる。

## Phase 4: Events / polling

- [ ] `task-run:status-changed` を受けたら task summary / primary tab query を invalidate する helper を作る。
- [ ] `pr-sync:completed` を受けたら task summary / PR snapshot query を invalidate する helper を作る。
- [ ] `useLiveRefresh` の手動 polling を Query の `refetchInterval` または invalidate helper に寄せる。
- [ ] Work Board / WorkBench Sidebar / WorkBench Header が同じ event + interval を個別に持たないよう購読を集約する。`layout.tsx` の persistent space で WorkBench は unmount されず常時共存する点に注意する。
- [ ] event listener は mount 寿命・module singleton QueryClient は全寿命というライフサイクル非対称を踏まえ、listener を app-global な単一 owner に寄せて invalidate の N 重発火を防ぐ。
- [ ] 同一 query key の重複 invalidate/refetch が実害を出さないか PoC で確認する。
- [ ] retry を絞ることで一過性 backend エラーが board 空表示になる退行を防ぐため、`isError` → toast 連携の受け皿を用意する。
- [ ] document hidden 時の扱いを Query 側の設定として明文化する。
  - [ ] Tauri window blur / focus / minimize で `document.hidden` が期待通り変わるか実機確認する。
  - [ ] `document.hidden` が使えない場合は Tauri window event か mounted-space 単位の polling に寄せる。
- [ ] event timeline snapshot を追加する場合は、append-only event stream ではなく snapshot query として扱う。

## Phase 5: WorkBench 周辺の限定適用

- [ ] `terminalListSessions()` は detached session/status snapshot としてのみ Query 化できるか検証する。
- [ ] `terminal:output:*` / `terminal:exit:*` listener は Query 化しない。
- [ ] `terminalCreateSession` / `terminalAttach` / `terminalWrite` / `terminalResize` / `terminalTerminate` は imperative command のまま維持する。
- [ ] `loadTerminalStateAtom` の復元順序、daemon reconcile、fallback 挙動は Query cache に移さない。
- [ ] `worktreeInfo(path)` cache は Query 化してもよいが、既存の 5 秒 throttle と title 更新の意味を保つ。
  - [ ] Query 化する場合は既存の module-scope throttle と Query `staleTime` のどちらか一方に寄せる。

## Phase 6: Cleanup / verification

- [ ] Query 化した後に不要になる manual cache atoms を削除する。
- [ ] query key factory / invalidate helper を純関数として単体テストし、`just knip` / unused で dead helper を検出できる形にする。
- [ ] query key factory は「呼び出し引数の写像」に留め、status/column 判定ロジック（`prepare_eligible` / `run_eligible` 等）を key 側に複製しない（`CLAUDE.md` の型管理原則）。
- [ ] `src/commands/bindings.ts` は手動編集しない。Rust 型を変更した場合のみ `just generate-bindings` を実行する。
- [ ] Work Board の initial load、project filter、track issue、prepare、run、delete の動作を確認する。
- [ ] WorkBench の terminal attach、detached sessions、Task status dot、Main Run dot が退行していないことを確認する。
- [ ] `just fmt` を実行する。
- [ ] `just check` を実行する。
