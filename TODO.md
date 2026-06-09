# Monica Frontend Rebuild TODO

## Workboard v0

### Done

- [x] Kanban 6列レイアウト (Inbox / Ready / Running / Needs You / Interrupted / Done)
- [x] カラム定義をRust側 `BoardColumn` から取得
- [x] Task Card: タイトル + ID + ステータスストライプ + issue/PR/branchバッジ
- [x] Tauri コマンド `list_task_summaries` / `get_board_columns`
- [x] Jotai store (`workboard.ts`)
- [x] サイドバー非表示 (v0 non-goal)
- [x] issue/PRバッジをクリックでGitHubへ遷移 (`tauri-plugin-opener`)
- [x] カードの空カラム表示: empty state
- [x] Track Issue フロー: GitHub Issue URL を貼って Task を作成
- [x] Project filter: プロジェクトで絞り込み
- [x] Open Bench: Task → `_TaskToRunspace` → Workbench Runspace 遷移
- [x] `_TaskToRunspace` テーブル (V12 migration)
- [x] `open_bench` usecase + Tauri コマンド
- [x] `TerminalRunspace.taskId` でtask-bound runspace識別

### Card & Board の磨き込み

- [ ] ボードのデータ自動更新 (polling or Tauri event)
- [ ] specta `Option<i64>` → `number | null` の型生成修正

### Header

- [ ] Search: タイトル/ID で検索

### Workbench 接続（残り）

- [ ] Workbench sidebar に Task-bound group を表示（Task Runs / Shells の分離）
- [ ] Back to Board 導線 (Workbench → Workboard)
- [ ] Run & Open: TaskRun を開始し Runspace を作成して Workbench へ遷移
- [ ] Run in Background: TaskRun を開始するが Workbench には遷移しない

### v0 Non-goals (意図的にやらない)

- 複数 Board view
- drag-and-drop による status 変更
- file diff / editor / test result の Board 内表示
- TaskRun lineage の複雑な表現
