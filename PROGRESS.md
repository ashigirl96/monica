## Goal

GitHub Issue を起点に worktree → Claude Code session → 状態追跡 → review → PR まで支える薄い実行レイヤー（Monica Issue Runner）を作る。これが Monica（個人用 Agentic Workspace）の核。

## 向かう先

Issue Runner → Session Tracker → Status Dashboard → Kanban → Terminal/ADE → Multi-repo → Slack/Wiki/RSS の順に広げる。実装形態は共有 Rust core + `monica` CLI で、GUI は後で同じ core を Tauri command 経由で利用する。

## Todo

着手順 A→G（依存順）。詳細は ISSUES.md。

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
- 2026-05-28 `just build`/`install-local` でも `RUSTC_WRAPPER` を空にして、wrapper 付き環境でも Tauri ビルドが落ちないようにした。
- 2026-05-28 #17 monica issue status を実装。core で WorkItem+最新 run を一覧化し、CLI で status/project filter と `gh pr list` 補完による BRANCH/PR 表示を追加した（D 完了）。
- 2026-05-28 monica に `completions` サブコマンド(clap_complete)を追加。`.envrc`(direnv)で repo 内だけ ./monica を `monica` として PATH に乗せ、dev-cli が ~/.zsh/completions/\_monica を再生成して補完を効かせる。
- 2026-05-28 `.claude/skills/codex` を追加し、`codex-rpc` ではなくローカル `codex exec` を直接使う設計/レビュー用スキルを整備した（このリポジトリ運用に合わせるため）。
- 2026-05-28 `narrative.md` の CLI メモを現行実装に合わせて更新。`project add`/`issue new`/`issue run` 案を `project init`/`issue track`/未実装の `start` 系へ整理した。
- 2026-05-28 `.claude/skills/codex` と `tackle` の Codex 呼び出しを `--output-last-message` 前提へ更新。Claude Code に中間 session を返さず、最終レビュー結果だけ返す運用に寄せた。
- 2026-05-28 #18 monica issue run を実装。core に Run CRUD(run_counter v3 採番)+branch 生成+setup.sh 実行(timeout/log)+run_issue orchestration を置き、status を setting_up→running/failed と原子的に遷移、CLI は表示のみ（E 完了）。
- 2026-05-28 #18 のリリース安定化: setup timeout で setup.sh の子プロセスを process group 単位で kill するようにしてリークを防止し、run_id の latest 取得を数値ソートで安定化（`run-9`/`run-10` 逆転を回避）。
- 2026-05-28 `issue run` の既定 worktree 生成先を `MONICA_HOME/worktrees` から `project.path/.worktrees` へ変更。Claude Code などが main checkout と同じ設定/メモリ文脈を見つけやすくするため。
- 2026-05-28 #35 branch 名の命名規則を撤廃。projects.branch_template とテンプレート機構を migration v4 で削除し、run が issue 紐づけ有→`issue-<n>`／無→`mon-<n>` を直接生成するようにした（`monica issue status` 等での視認性向上）。
- 2026-05-28 #19 monica issue run --claude を実装。setup 成功後に runs/<run_id>/claude-settings.json（SessionStart/Stop/StopFailure/SessionEnd の command hook）を生成し、.monica/prompt.md を初期 prompt に claude --settings を worktree で foreground 起動、settings_path 記録・status=running（F 完了）。
- 2026-05-28 #20 Claude Hook Bridge を実装。core に hook receiver(`record_claude_hook`)＋events/`hook-events.jsonl` 記録＋status 遷移(SessionStart→running 等)、`monica issue mark`(status/phase/PR ref) を置き、CLI は stdin/env 読取と exit 0 保証のみ。env 由来の run_id は path 安全性と work item 所有を検証して誤更新と FK 違反を防止（G 完了、migration なし）。
- 2026-05-28 monica-core の大型ファイルを責務別モジュールへ分割した（保守性向上）
