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

## Phase 2: Work Board read model ✅ 完了（Issue #127 / PR #128）

確定した設計判断:

- read 3 atom（boardColumns / taskSummaries / taskStatusMap）は `atomWithQuery` + read-only derived。consumer は無改修。
- `taskSummaries` の query key に `selectedProjectAtom` を使い、filter 変更は query key 変更だけで refetch（手動 refresh 副作用を撤去）。
- refresh は `tasks.summaryFamily()`（`["tasks","summary"]` 前方一致）の `invalidateQueries` に統一。`refreshTaskStatusMapAtom` は廃止し sidebar を集約。
- `loadBoard` は `ensureQueryData` ゲートにして restore 順序を維持。`invalidateQueries` は refetch 完了まで await する（`@tanstack/query-core` 実コードで確認）ので mutation 直後の同期 read も fresh。

- [x] `listTaskSummaries(project)` の query atom を作る。
- [x] `listProjects()` の query atom を作る（Phase 1 で実施済み）。
- [x] `getBoardColumns()` の query atom を作る。
- [x] `taskSummariesAtom` / `projectsAtom` / `boardColumnsAtom` は「query の data を unwrap する薄い derived atom」として温存する。これで `columnTasksAtom` と nav 系（`workboard-nav.ts` の focus / move / taskById / applyRestored）を無改修のまま移行する。
- [x] `src/stores/workboard.ts` の `loadBoardAtom` / `refreshTaskSummariesAtom` を Query 由来に置き換える。
- [x] Sidebar 用の `refreshTaskStatusMapAtom`（unfiltered = `tasks.summary(null)`）も同 family で扱い、invalidate は family 全体（`['tasks','summary']` プレフィックス）を倒して filtered/unfiltered 両方を更新する。
- [x] `selectedProjectAtom` は UI state として残し、query key の入力にだけ使う。
- [x] `selectedProjectAtom` の write 側にある `void set(refreshTaskSummariesAtom)` を削除し、project 変更による再取得は query key 変更だけにする。
- [x] `columnTasksAtom` 相当の projection は Rust 由来の column/status 定義を使って維持する。
- [x] Work Board 復元処理は、Query のロード完了後に既存の `applyRestoredWorkboardAtom` を一度だけ呼ぶ形へ移す。
  - [x] `loadBoard().then(() => applyRestored())` の順序保証を失わない。
  - [x] `projects` と `task summaries` の両方が success になってから restore hint を検証する。
  - [x] restore 後の `selectedProjectAtom` 変更で query key が変わる場合、focus 検証をどの snapshot に対して行うか → unfiltered(null) snapshot に対して検証する形で確定。
  - [x] restore は冪等に・一度だけ発火させ、StrictMode の effect 二重マウントに耐えるようにする（`applyRestored` が hint を読んだ直後に null 化）。

## Phase 3: Mutation と invalidate ✅ 完了（Issue #129 / PR #130）

確定した設計判断（code-architect opus 検証）:

- `atomWithMutation` の onSuccess からは jotai `set` を呼べない。よって **純粋 mutation（invoke + invalidate のみ）だけ** atomWithMutation 化し、jotai/terminal を orchestrate する mutation（delete/run/promote）は write atom のまま残す。
- `mutateAsync`(=observer.mutate) は onSuccess の invalidate+refetch 完了まで await するので、mutation 直後の同期 read が fresh。
- 楽観更新はしない。方針を `src/CLAUDE.md` に明記。

- [x] `trackGithubIssue` を `atomWithMutation` 化し、成功後に task summary family を invalidate する。
- [x] `prepareTask` を `atomWithMutation` 化し、成功後に task summary family を invalidate する。
- [~] `deleteTask` は jotai orchestration（runspace cleanup）が必須なので **write atom のまま維持**（既存 `refreshTaskSummariesAtom` で invalidate）。atomWithMutation 化はしない（onSuccess で jotai set 不可のため）。
- [x] 楽観更新はしない方針を明記。
- [~] `makeMainTaskRun` 後の `taskRuns.primaryTab(taskId)` 標準化は primaryTab が未 query 化のため Phase 5 へ。task summary invalidate は `promoteActiveTabRunAtom`(write atom) が `refreshTaskSummariesAtom` で実施済み。
- [x] `runTaskFlow` は lifecycle orchestration として write atom のまま残し、最後の再取得だけ invalidate に寄せた（既存維持）。

## Phase 4: Events / polling ✅ 完了（Issue #131 / PR #132）

確定した設計判断:

- `task-run:status-changed` / `pr-sync:completed` の listen と 3s poll を module-singleton の `initQuerySync()`（`src/stores/query-sync.ts`、`main.tsx` で1回 init）に集約。`tasks.summaryFamily()` を invalidate。
- owner は React effect でなく module init なので StrictMode 二重登録なし。listener は app 寿命で unlisten しない。
- board 初回ロード失敗（`status==="error" && data===undefined && fetchStatus==="idle"`）のみ error toast。`pushErrorToast` の message dedup と併用。
- `document.hidden` で poll を gate（既存 `useLiveRefresh` 踏襲）。primary tab は未 query 化のため対象外（Phase 5）。

- [x] `task-run:status-changed` を受けたら task summary を invalidate（owner に集約）。primary tab は Phase 5。
- [x] `pr-sync:completed` を受けたら task summary を invalidate + toast（PR は `TaskSummaryRow` 内包で専用 query 不要）。
- [x] `useLiveRefresh` の手動 polling（query 部分）を owner の単一 interval に寄せた。terminal 用 `useLiveRefresh` は Phase 5。
- [x] Work Board / Sidebar の query event+interval を owner 単一所有に集約。
- [x] listener を app-global 単一 owner に寄せ N 重発火を防止。
- [x] 同一 query key の重複 invalidate は active query のみ refetch で実害なしを確認。
- [x] `isError`(初回ロード失敗) → toast の受け皿を用意。
- [x] `document.hidden` の扱いを owner に明文化。
  - [~] Tauri window minimize での `document.hidden` 実機確認は MCP で困難なため既存挙動踏襲（必要なら Tauri window event 化を将来検討）。
- [ ] event timeline snapshot は未導入（追加時に snapshot query として扱う）。

## Phase 5: WorkBench 周辺の限定適用 ⏸ 見送り（deferred、Issue #133）

検証の結論として **terminal は imperative 維持**とした。理由:

- `sessionStatusAtom` は純粋 snapshot ではなく、`use-terminal` の attach/exit が `setSessionStatusAtom` で
  **load-bearing な optimistic 上書き**をする（store.ts:566 / use-terminal.ts:128,147,177,193）。3s poll は
  全置換で daemon snapshot に戻す。Query 化には baseline + override の merge 層が要り、fragile な terminal を厚く触る。
- `worktreeInfo(path)` は **local git 実行**で「backend/SQLite/GitHub 由来 snapshot」という `src/CLAUDE.md` の
  Query 適用範囲外。既存 5s throttle と staleTime の二重時間管理は CLAUDE.md で禁止。throttle 維持が正当。
- `src/CLAUDE.md` の「WorkBench / TaskRun 実行制御へ横滑りさせない」原則とも整合する。

- [x] `terminalListSessions()` の Query 化可否を検証 → optimistic override の絡みで見送り。
- [x] `terminal:output:*` / `terminal:exit:*` listener は Query 化しない（維持）。
- [x] `terminalCreateSession` 等の lifecycle command は imperative 維持。
- [x] `loadTerminalStateAtom` の復元順序・reconcile・fallback は Query に移さない（維持）。
- [x] `worktreeInfo(path)` は throttle 維持（Query 適用範囲外と判断）。
- backlog: 将来 terminal status を Query 化する場合は optimistic override の merge 層を別途設計する。

## Phase 6: Cleanup / verification ✅ 完了（Issue #134）

監査結果:

- 削除すべき manual cache atom は **無し**。旧 `boardColumns/taskSummaries/taskStatusMap` は derived 化されて
  使用中、`refreshTaskSummariesAtom` も mutation で使用中。各 Phase で `just knip` 通過済み（dead export なし）。
- `query-keys.ts` は「引数の写像」+ 純粋 predicate（`isTaskSummaryKey`）のみで status/column 判定の複製なし。
- `src/commands/bindings.ts` は手動編集していない（移行で Rust 変更なし）。

- [x] Query 化後に不要になる manual cache atom を削除 → 対象なし（確認のみ）。
- [x] query key factory / 純粋 helper を単体テスト（`query-keys.test.ts`）。`just knip` で dead 検出可能。
- [x] query key factory は引数の写像に留め status/column 判定を複製しない。
- [x] `src/commands/bindings.ts` は手動編集しない。
- [x] Work Board の initial load / project filter / track issue / prepare / run / delete を確認。
- [x] WorkBench の terminal attach / detached sessions / Task status dot / Main Run dot が退行なしを確認。
- [x] `just fmt` / `just check` / `just test` 通過。

## Phase 6: Cleanup / verification

- [ ] Query 化した後に不要になる manual cache atoms を削除する。
- [ ] query key factory / invalidate helper を純関数として単体テストし、`just knip` / unused で dead helper を検出できる形にする。
- [ ] query key factory は「呼び出し引数の写像」に留め、status/column 判定ロジック（`prepare_eligible` / `run_eligible` 等）を key 側に複製しない（`CLAUDE.md` の型管理原則）。
- [ ] `src/commands/bindings.ts` は手動編集しない。Rust 型を変更した場合のみ `just generate-bindings` を実行する。
- [ ] Work Board の initial load、project filter、track issue、prepare、run、delete の動作を確認する。
- [ ] WorkBench の terminal attach、detached sessions、Task status dot、Main Run dot が退行していないことを確認する。
- [ ] `just fmt` を実行する。
- [ ] `just check` を実行する。
