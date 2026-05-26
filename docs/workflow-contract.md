# Monica Workflow Contract (M0)

Monica の最初の核は **Issue Runner** である。すなわち、

```text
GitHub Issue
  → Worktree / Branch
  → Claude Code Session
  → Status 追跡
  → Review
  → PR
```

を、機械が扱えて人間が追跡できる作業単位にする薄い実行レイヤー。

この文書は、その実行レイヤーが従う**契約**を定義する。Kanban・Terminal UI・Slack・Wiki などはすべてこの契約の上に後から載る。逆にここが曖昧なまま UI から作ると「結局いつもの Terminal 運用のほうが速い」状態になるため、コードより先にここを固める。

> この文書自体が `[M0] Define Monica workflow contract for issue-driven agent development` の成果物である。

---

## 1. スコープ

### やること (M0)

> **1 つの GitHub Issue から、1 つの worktree と 1 つの Claude Code session を作り、状態を見て、PR 作成まで進められる。**

### やらないこと (Out of Scope)

- Kanban UI / リッチ GUI
- Slack 連携 / RSS / article intake
- LLM Wiki / repo 推薦 / 自動タスク分解
- 複数 agent による並列実行
- 完全自動 merge

M0 の価値は「全部できる」ではなく、**既存の issue-driven 開発を 1 段だけ強くする**ことに絞る。

---

## 2. アーキテクチャ決定 (ADR)

### 2.1 共有 Rust core + CLI + GUI

Monica は **共有 Rust core** を中心に、CLI と GUI をその薄い presentation 層として構築する。Cargo workspace 化し、すべての Rust crate を `crates/` 配下に揃える。

```text
Cargo.toml         ... workspace root（[workspace] members と [profile.*] を集約）
crates/
  monica-core/     ... domain logic (manifest, registry, git/gh adapter, status model)
  monica-cli/      ... binary `monica`（clap ベース）。core を呼ぶだけの薄い層
  monica-app/      ... Tauri desktop shell（現 src-tauri）。core へ依存し Tauri command 経由で公開
src/               ... フロントエンド（React）。配置は変えない
```

- domain logic は **必ず `monica-core` に置く**。CLI / GUI が同じ振る舞いを共有するため。
- `monica-cli` / `monica-app` は core の薄い presentation 層に徹する。

#### src-tauri → crates/monica-app 移行（実施済み）

workspace 再編で以下を行った（`git mv` だけでは壊れる箇所の記録）。

1. **profile の持ち上げ**: `[profile.release]`（Five Aces）と `[profile.dev]` はメンバー crate では無視されるため、**workspace root の `Cargo.toml` に集約**した。`docs/dev.md` の該当記述も更新済み。
2. **`frontendDist` の相対パス**: `tauri.conf.json` は自身のディレクトリ基準。`crates/monica-app/` へ移したので `../dist` → `../../dist` に調整。
3. **Tauri CLI の探索**: Tauri CLI の `resolve_tauri_dir` は ①`TAURI_APP_PATH` env → ②cwd / `src-tauri` 直下 → ③`walk_builder`（深さ ≤3）で `tauri.conf.json` を探索する。`crates/monica-app` は深さ2 で自動発見されるが、確実性のため `package.json` の `tauri` script と CI で `TAURI_APP_PATH=crates/monica-app` を明示設定した。
4. **CI / tooling のパス**: `ci.yml`（`rust-cache` `workspaces: .`・`tauri-action` env・bundle report path）、`dependabot.yml`（cargo `directory: /`）、`justfile`（clippy `--workspace` / bloat `-p monica-app` / install-local / size / clean）、`vite.config.ts` の watch ignore、`.gitignore` を新パスへ更新。
5. **crate 名**: package `monica` → `monica-app`、lib `monica_lib` → `monica_app_lib`。

> **3 crate（`monica-core` / `monica-cli` / `monica-app`）の skeleton と workspace 化はこの段階で完了している。** `monica-cli` は clap で M0 コマンド（`start` / `status` / `review` / `pr`）の枠を持ち、中身は未実装（`not yet implemented`）。`monica-core` は依存ゼロの空 lib。`[M0] Implement monica start`（#11）で、ロジックを `monica-core` に実装し `monica-cli` から呼ぶ。

### 2.2 git / gh は shell out

`git2` や `octocrab` などのライブラリを**リンクしない**。`git` と `gh` コマンドを subprocess で呼ぶ。

理由:

- **size-first 思想との整合**: 配布バイナリを膨らませない（後述）。
- 既存の `gh` 認証（`ashigirl96`、SSH）をそのまま利用できる。
- worktree・PR・Issue 取得はすべて `git worktree` / `gh issue` / `gh pr` で完結する。

### 2.3 size-first の適用範囲

repo の `docs/dev.md` が定める「配布バイナリのサイズを最優先」という制約は、**配布される Tauri bundle (.app)** に適用される。

`monica` CLI は配布 .app に含まれない **local dev tool** であるため、`clap` などの利便性ライブラリの利用は size 制約の対象外とする。ただし `monica-core` が将来 Tauri から使われる以上、core 側に重い依存を持ち込む場合は `just bloat` で確認する。

---

## 3. Issue モデル

Monica が「実行可能」とみなす Issue は、以下の構造を持つ（テンプレは `.github/ISSUE_TEMPLATE/monica_task.md`）。

| フィールド          | 必須 | 役割                                      |
| ------------------- | ---- | ----------------------------------------- |
| Context             | ✓    | なぜ必要か。背景・現状・前提。            |
| Goal                | ✓    | 完了時に何が true になっているべきか。    |
| Out of Scope        | ✓    | agent が勝手に広げないための境界。        |
| Acceptance Criteria | ✓    | チェックボックス形式の完了条件。          |
| Verification        |      | 確認方法（test command / manual check）。 |
| Agent Instructions  |      | Claude Code に守ってほしい進め方。        |
| Links               |      | 関連 Issue / PR / docs。                  |
| Monica Metadata     | ✓    | 後述の機械可読メタデータ。                |

### なぜ Out of Scope を必須にするか

Claude Code に作業させる Issue では、`Goal` と同じくらい `Out of Scope` が重要である。ここが弱いと agent が「ついでに良くしておきました」をやりやすくなり、scope が膨張する。Monica では Out of Scope を第一級フィールドとして必須化する。

### Monica Metadata

Issue 本文末尾の YAML ブロックで、機械が読むメタデータを持つ。

```yaml
kind: task # task | research | proposal
agent: claude-code # 担当 agent
requires_approval: true # PR 前に人間承認を要するか
status: ready # 後述の lifecycle のいずれか
```

---

## 4. Status Lifecycle

M0 では最小集合のみ扱う。

```text
Ready → Running → ┬→ Need Review     → PR Open → Done
                  └→ Need Intervention ┘
```

| Status              | 意味                                           | 遷移させる主体 (M0)             |
| ------------------- | ---------------------------------------------- | ------------------------------- |
| `Ready`             | 着手可能。worktree 未作成。                    | 人間（Issue 作成時）            |
| `Running`           | worktree が作られ、Claude Code が作業中。      | `monica start`                  |
| `Need Review`       | 実装が一段落し、人間の確認待ち。               | 人間（将来は Stop hook）        |
| `Need Intervention` | session が詰まった / 仕様を誤解 / 逸脱の疑い。 | 人間（将来は StopFailure hook） |
| `PR Open`           | PR が作成済み。                                | `monica pr`                     |
| `Done`              | merge 済み、cleanup 可能。                     | 人間                            |

- M0 の status 遷移は基本的に**人間とコマンドが行う**。Claude Code hook による自動遷移（`SessionStart → Running`、`Stop → Need Review` 等）は `[M1] Update Monica session status from Claude Code hooks` で扱う。
- `Inbox` / `Backlog` / `Planning` / `Archived` 等の status は narrative にあるが M0 では導入しない。状態遷移管理を重くしないため。

---

## 5. Branch / Worktree 命名規則

| 項目     | 規則                                                                                                           | 例                                            |
| -------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Slug     | Issue title を lowercase 化し、英数字以外を `-` に、連続 `-` を畳み、前後 `-` を除去。先頭 40 文字程度に切る。 | `Add search` → `add-search`                   |
| Branch   | `monica/<issue>-<slug>`                                                                                        | `monica/123-add-search`                       |
| Worktree | `<repo.path>/.worktrees/<issue>-<slug>`                                                                        | `~/.ghq/.../monica/.worktrees/123-add-search` |

- worktree は各 repo の `path` 配下の `.worktrees/` に作る（monica repo には既に `.worktrees/` が存在し、それを横展開する）。
- base branch は registry の `default_branch`（通常 `main`）。

---

## 6. Session Manifest

Issue・worktree・branch・Claude session・PR の対応関係を local state として記録する。

- 保存先: `~/.monica/sessions/<id>.json`
- `id`: `<owner>-<repo>-<issue>`（例 `ashigirl96-monica-1`）

### Schema

```json
{
  "id": "ashigirl96-monica-123",
  "repo": "ashigirl96/monica",
  "issue_number": 123,
  "issue_url": "https://github.com/ashigirl96/monica/issues/123",
  "status": "running",
  "branch": "monica/123-add-search",
  "worktree_path": "/Users/me/.ghq/src/github.com/ashigirl96/monica/.worktrees/123-add-search",
  "agent": "claude-code",
  "agent_session_id": null,
  "pr_number": null,
  "created_at": "2026-05-27T10:00:00+09:00",
  "updated_at": "2026-05-27T10:00:00+09:00"
}
```

| field              | 型             | 説明                                      |
| ------------------ | -------------- | ----------------------------------------- |
| `id`               | string         | 一意キー。`<owner>-<repo>-<issue>`。      |
| `repo`             | string         | `owner/repo`。                            |
| `issue_number`     | number         | Issue 番号。                              |
| `issue_url`        | string         | Issue の URL。                            |
| `status`           | string         | §4 の lifecycle のいずれか。              |
| `branch`           | string         | §5 の branch 名。                         |
| `worktree_path`    | string         | worktree の絶対パス。                     |
| `agent`            | string         | `claude-code` など。                      |
| `agent_session_id` | string \| null | agent 側 session id（M0 では基本 null）。 |
| `pr_number`        | number \| null | PR 番号。未作成なら null。                |
| `created_at`       | string         | ISO8601。                                 |
| `updated_at`       | string         | ISO8601。状態更新ごとに書き換える。       |

> **永続化方針**: 最初は JSON ファイルで十分。検索・集計が必要になってから SQLite 化を検討する（M0 では SQLite にしない）。

---

## 7. Repo Registry

Monica が管理対象とする repo を知るための config。

- 保存先: `~/.monica/config.yaml`

```yaml
repos:
  - name: monica
    owner: ashigirl96
    repo: monica
    path: ~/.ghq/src/github.com/ashigirl96/monica
    default_branch: main
```

| field            | 説明                                             |
| ---------------- | ------------------------------------------------ |
| `name`           | Monica 内での短縮名。                            |
| `owner` / `repo` | GitHub 上の owner / repo。                       |
| `path`           | ローカル clone の絶対パス。worktree 作成の基点。 |
| `default_branch` | base branch。                                    |

> **注意**: これは `docs/sources.json` / `docs/repos/`（Milkdown・codemirror-vim 等の**参照用に取得した repo**）とは別物である。あちらは将来のエディタ研究の Source であり、Issue Runner の管理対象 repo registry ではない。GitHub organization 全体の自動探索や multi-user 対応は M0 では行わない。

---

## 8. CLI コマンド契約

binary 名は `monica`。

| command                         | 役割                                                                           | M0 優先度 |
| ------------------------------- | ------------------------------------------------------------------------------ | --------- |
| `monica issue new`              | テンプレに沿った Issue を作成（`gh issue create`）。                           | 後        |
| `monica start <repo>#<issue>`   | Issue を取得し worktree/branch/manifest を作り、Claude Code 用 prompt を生成。 | **1**     |
| `monica status`                 | 全 session の状態を一覧表示。                                                  | **2**     |
| `monica open <repo>#<issue>`    | 対象 worktree を terminal/editor で開く。                                      | 後        |
| `monica review <repo>#<issue>`  | diff / 変更ファイル / test 提案 / PR 状態を表示。                              | **3**     |
| `monica pr <repo>#<issue>`      | push し PR を作成、manifest と Issue を更新。                                  | **4**     |
| `monica cleanup <repo>#<issue>` | worktree / branch / manifest を片付ける。                                      | 後        |

`<repo>#<issue>` は `owner/repo#123` 形式。registry の `name` 解決（`monica#123`）も許容する。

### 8.1 `monica start <repo>#<issue>`

```text
1. GitHub Issue を取得する（gh issue view --json）
2. Issue title / body を読む
3. slug → branch 名を生成する（§5）
4. git worktree を作る（git worktree add）
5. session manifest を作る（status = running）（§6）
6. Claude Code に渡す prompt を生成する（Issue 本文 + Out of Scope + Agent Instructions）
7. 必要なら terminal を開く
```

M0 では Claude Code の完全自動制御はしない。「prompt を生成して起動しやすくする」だけでもよい。

**M0 実装メモ**: repo registry（§7）は未実装のため、`monica start` は**対象 repo の中で**実行する（worktree は cwd の `git rev-parse --show-toplevel` 配下の `.worktrees/` に作る）。target は `#123` / `123`（current repo）、または current repo と一致する `owner/repo#123`。base branch は `origin/<default>` → `<default>` → `HEAD` の順で解決。prompt は `~/.monica/sessions/<id>.prompt.md` にも保存する。`monica#123`（registry 名）の解決は registry 実装後。

### 8.2 `monica status`

全 manifest を読み、一覧する。

```text
REPO     ISSUE  STATUS         BRANCH                 PR   WORKTREE
monica   #12    running        monica/12-runner       -    .worktrees/12-runner
monica   #14    need-review    monica/14-hook-events  -    .worktrees/14-hook-events
```

### 8.3 `monica review <repo>#<issue>`

人間がレビューしやすい情報を出すだけ（AI code review はしない）。

```text
- Issue summary
- current branch
- git diff summary / changed files
- uncommitted changes
- test command suggestion
- PR status
- agent notes (if available)
```

### 8.4 `monica pr <repo>#<issue>`

```text
1. current branch を push する
2. PR title / body を Issue から生成する
3. PR body に Fixes #<issue>（または Closes #<issue>）を含める
4. manifest に pr_number を保存し status = pr-open に更新
5. Issue に PR リンクをコメントする
```

自動 merge はしない。merge は人間が確認してから行う。

---

## 9. 失敗・中断・確認待ちの扱い

| 状況                               | status              | manifest 更新タイミング                           |
| ---------------------------------- | ------------------- | ------------------------------------------------- |
| 実装が一段落、人間の確認待ち       | `Need Review`       | 人間が `monica` で遷移（将来は Stop hook が自動） |
| session が詰まり / 仕様誤解 / 逸脱 | `Need Intervention` | 人間が遷移（将来は StopFailure hook）             |
| PR 作成済み                        | `PR Open`           | `monica pr` が自動更新                            |

`Need Intervention` の session は、人間が worktree に入り、terminal / log を見て、追加指示や session の fork で対応する。Monica は agent をブラックボックス化せず、いつでも中身を確認・介入できる状態を保つ。

---

## 10. サンプル Issue

`monica start` 実装 Issue を、本契約のテンプレ形式で書いた例。

````markdown
## Context

今は Issue を見て、手動で branch を切り、worktree を作り、Terminal を開き、Claude Code を起動している。この一連を `monica start` 1 コマンドにまとめたい。

## Goal

`monica start owner/repo#123` で、Issue 取得 → branch 生成 → worktree 作成 → session manifest 作成 → Claude Code 用 prompt 生成 まで自動で行える。

## Out of Scope

- Claude Code の完全自動制御（prompt 生成と起動補助まで）
- status の hook 連携（別 Issue）
- `monica status` / `review` / `pr` の実装（別 Issue）

## Acceptance Criteria

- [ ] `monica start owner/repo#123` で worktree と branch が作られる
- [ ] `~/.monica/sessions/<id>.json` が status=running で生成される
- [ ] Claude Code に渡す prompt が標準出力 or ファイルに生成される
- [ ] Issue が存在しない / 既に session がある場合に分かるエラーを返す

## Verification

```bash
monica start ashigirl96/monica#3
cat ~/.monica/sessions/ashigirl96-monica-3.json
git -C <worktree> status
```

## Agent Instructions

- 変更はこの Issue の scope に限定する。
- git / gh は shell out する（ライブラリを足さない）。
- domain logic は monica-core に置く。

## Links

- docs/workflow-contract.md

## Monica Metadata

```yaml
kind: task
agent: claude-code
requires_approval: true
status: ready
```
````
