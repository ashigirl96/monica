# Monica Frontend Rebuild TODO

## Workboard v0

### Done

- [x] Kanban 6列レイアウト (Inbox / Ready / Running / Needs You / Interrupted / Done)
- [x] カラム定義をRust側 `BoardColumn` から取得
- [x] Task Card: タイトル + ID + ステータスストライプ + issue/PR/branchバッジ
- [x] Tauri コマンド `list_task_summaries` / `get_board_columns`
- [x] Jotai store (`workboard.ts`)
- [x] サイドバー非表示 (v0 non-goal)

### Card & Board の磨き込み

- [ ] issue/PRバッジをクリックでGitHubへ遷移 (`tauri-plugin-opener`)
- [ ] Open Bench ボタンを有効化 (Workbench Runspace接続後)
- [ ] カードの空カラム表示: empty state のビジュアル
- [ ] ボードのデータ自動更新 (polling or Tauri event)
- [ ] specta `Option<i64>` → `number | null` の型生成修正

### Header

- [ ] Track Issue フロー: GitHub Issue URL を貼って Task を作成
- [ ] Project filter: プロジェクトで絞り込み
- [ ] Search: タイトル/ID で検索

### Workbench 接続

- [ ] Open Bench: Task に紐づく Runspace を active にして Workbench へ遷移
- [ ] Run & Open: TaskRun を開始し Runspace を作成して Workbench へ遷移
- [ ] Run in Background: TaskRun を開始するが Workbench には遷移しない
- [ ] Workbench 側の Runspace rail に Task-bound group を表示
- [ ] Back to Board 導線 (Workbench → Workboard)

### v0 Non-goals (意図的にやらない)

- 複数 Board view
- drag-and-drop による status 変更
- file diff / editor / test result の Board 内表示
- TaskRun lineage の複雑な表現
