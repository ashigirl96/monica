## Goal

GitHub Issue を起点に worktree → Claude Code session → 状態追跡 → review → PR まで支える薄い実行レイヤー（Monica Issue Runner）を作る。これが Monica（個人用 Agentic Workspace）の核。

## 向かう先

Issue Runner → Task/TaskRun Tracker → Status Dashboard → Kanban → Terminal/ADE → Multi-repo → Slack/Wiki/RSS の順に広げる。実装形態は共有 Rust core + `monica` CLI で、GUI も同じ core を Tauri command 経由で利用する。

## Todo

着手順 A→G（依存順）。詳細は ISSUES.md。

## Timeline

- 2026-05-27〜28 M0 縦串を完走。Cargo workspace 化と monica-core/monica-cli skeleton を土台に、rusqlite ストレージ・project registry・`issue track/status/run/--claude`・Claude Hook Bridge を A〜G として実装し、setup.sh 実行から hook 経由の status 遷移まで CLI で一通り回るようにした。
- 2026-05-29〜30 観測 UI と状態モデルを整備。Mission Control ダッシュボードを Tauri に追加し、WorkItem/Run を Task/TaskRun へ改名・状態責務を分離（inbox/ready/in_progress/done＋TaskRun に waiting_for_user/soft delete）、AgentSession を統合して data integrity を補強した。
- 2026-05-31 Claude hook に waiting tools の PostToolUse を追加して回答後に running へ復帰させ、Dashboard に矢印/Ctrl+N/P の focus 移動・Enter/Esc の details 開閉・⌘D 削除確認のキーボード操作を実装した。
- 2026-05-31 Dashboard keyboard review を反映。Enter が通常ボタン操作を奪わないようにし、削除確認に worktree/branch cleanup の警告を追加した。
- 2026-05-31 削除確認 modal に focus trap を追加。Tab/Shift+Tab が Cancel/Delete の間だけを移動するようにした。
- 2026-05-31 Modal primitive を追加。dialog の focus restore/initial focus/Tab trap を共通化し、個別 modal が中身だけを書けるようにした。
- 2026-05-31 PR lazy sync worker を追加。Dashboard の一覧取得から GitHub 通信を切り離し、保存済み PR を一覧と詳細に表示できるようにした。
