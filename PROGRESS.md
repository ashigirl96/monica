## Goal

GitHub Issue を起点に worktree → Claude Code session → 状態追跡 → review → PR まで支える薄い実行レイヤー（Monica Issue Runner）を作る。これが Monica（個人用 Agentic Workspace）の核。

## 向かう先

Issue Runner → Session Tracker → Status Dashboard → Kanban → Terminal/ADE → Multi-repo → Slack/Wiki/RSS の順に広げる。実装形態は共有 Rust core + `monica` CLI で、GUI は後で同じ core を Tauri command 経由で利用する。詳細は [`docs/workflow-contract.md`](./docs/workflow-contract.md)。

## Todo

- [ ] #11 `monica start <repo>#<issue>` を実装する（ロジックを `monica-core` に書き `monica-cli` から呼ぶ）

## Timeline

- 2026-05-27 PROGRESS.md を新設。開発環境が整い、ここを機能追加の起点とする。
- 2026-05-27 最初の機能を Monica Issue Runner に決定（narrative の核）。docs/workflow-contract.md と issue template を作成し、M0 Issue #9/#10/#11 を起票。
- 2026-05-27 Cargo workspace 化。src-tauri を crates/monica-app へ移し、profile を root に集約（将来の monica-core/monica-cli と並べる構成にするため）。
- 2026-05-27 monica-core（空 lib）と monica-cli（clap で M0 コマンドの枠）の skeleton を追加。以後は機能追加だけで進められる土台にした。
- 2026-05-27 just dev で monica CLI を debug ビルドして repo 直下 ./monica に作成、just install-local で release CLI を ~/.local/bin にも配置するようにした。
