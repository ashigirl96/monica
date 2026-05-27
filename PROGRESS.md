## Goal

GitHub Issue を起点に worktree → Claude Code session → 状態追跡 → review → PR まで支える薄い実行レイヤー（Monica Issue Runner）を作る。これが Monica（個人用 Agentic Workspace）の核。

## 向かう先

Issue Runner → Session Tracker → Status Dashboard → Kanban → Terminal/ADE → Multi-repo → Slack/Wiki/RSS の順に広げる。実装形態は共有 Rust core + `monica` CLI で、GUI は後で同じ core を Tauri command 経由で利用する。

## Todo

着手順 A→G（依存順）。詳細は ISSUES.md。

- [ ] #17 issue status（一覧表示）
- [ ] #18 issue run（worktree + .monica/setup.sh）
- [ ] #19 issue run --claude（.monica/prompt.md で起動）
- [ ] #20 Claude Hook Bridge（hook claude + issue mark）

## Timeline

- 2026-05-27 PROGRESS.md を新設。開発環境が整い、ここを機能追加の起点とする。
- 2026-05-27 最初の機能を Monica Issue Runner に決定（narrative の核）。docs/workflow-contract.md と issue template を作成し、M0 Issue #9/#10/#11 を起票。
- 2026-05-27 Cargo workspace 化。src-tauri を crates/monica-app へ移し、profile を root に集約（将来の monica-core/monica-cli と並べる構成にするため）。
- 2026-05-27 monica-core（空 lib）と monica-cli（clap で M0 コマンドの枠）の skeleton を追加。以後は機能追加だけで進められる土台にした。
- 2026-05-27 just dev で monica CLI を debug ビルドして repo 直下 ./monica に作成、just install-local で release CLI を ~/.local/bin にも配置するようにした。
- 2026-05-27 M0 vertical slice を ISSUES.md に整理し A〜G を Issue #14-#20 として起票（DB=rusqlite/SQLite、設定も DB 統合、setup/prompt は .monica/ 規約）。
- 2026-05-27 #14 monica-core にストレージ基盤を実装。rusqlite(bundled)+rusqlite_migration+WorkItem/Run/Event/ExternalRefモデル+MON-ID採番+repository API（A 完了、B 以降の土台）。
- 2026-05-27 #15 project registry を実装。projects テーブル(v2) + monica project init/set/list/show（B 完了）。init は git remote 検出・path 補完・.monica/ 雛形生成と DB 登録を兼ねる（add から改名）。
- 2026-05-27 #16 monica issue track を実装。owner/repo#123 をパースし gh issue view から WorkItem(ready)+ExternalRef(github_issue) を作成、registry に project があれば project_id を紐付け（C 完了）。gh/パースは CLI 層、DB は core API を再利用。
