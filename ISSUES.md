# Monica M0 Issue ドラフト

GitHub Issue を起点に worktree → Claude Code → 状態追跡まで支える Monica Issue Runner の M0 vertical slice。
着手順は **A → B → C → D → E → F → G**。各 issue は `.github/ISSUE_TEMPLATE/monica_task.md` に準拠。

共通方針:
- 内部モデルは `WorkItem`（CLI 表示は `issue`）。
- DB は SQLite（`rusqlite { features=["bundled"] }`）。size-first 原則の例外として DB のみサイズ許容。
- 全データは `~/monica/` 配下に集約（`MONICA_HOME` env で上書き可、デフォルト `~/monica`）。状態・設定とも `~/monica/db/monica.db`、run 成果物は `~/monica/runs/<run_id>/`。
- projects 設定も DB の `projects` テーブルに統合する。書き込みは `monica project ...` CLI に一本化し（人は直接書かず agent が更新）、論理的な「宣言 vs 状態」の分離は projects テーブルで保つ。`toml` crate は不要（ストアは rusqlite 一本）。
- panic/unwrap 禁止（`?` で伝播）。Rust 依存は原則 `default-features = false`（DB を除く）。

---

## A. [M0] monica-core: ストレージ基盤(SQLite) + WorkItem モデル + Monica ID 採番

### Context

`monica-core` は現在空で、CLI の全コマンドが依存する永続化レイヤーとドメインモデルが無い。DB は「10 年衰えない・Rust 相性・最速」の要件から **SQLite（rusqlite, bundled）** を採用する（SQLite は 2050 年まで公式サポート、ローカル組込み用途で最速、tokio 不要）。これは monica のサイズ最優先原則に対する明示的な例外で、DB に限ってサイズを許容する。ここが全 issue の土台になる。

### Goal

`monica-core` に、rusqlite ベースの DB 接続・migration・スキーマ、`WorkItem` / `Run` / `Event` / `ExternalRef` の型、`MON-<n>` 採番、最小の repository API（insert / get / list / update_status）が揃っている。

### Out of Scope

- CLI サブコマンドへの配線（B 以降で行う）。
- project registry、`gh` 連携、worktree、Claude 起動、hook（B〜G）。
- `Source` 専用テーブル（当面は `work_items.source_json` カラムで吸収）。
- Tauri/GUI 連携。
- 高度な migration ツールチェーン（最小構成で良い）。

### Acceptance Criteria

- [ ] `rusqlite { features = ["bundled"] }` を `monica-core` に追加し、bundled SQLite でビルドできる。
- [ ] DB は `~/monica/db/monica.db` を開く。base path は `MONICA_HOME` env で上書きでき、デフォルトは `~/monica`。
- [ ] migration が冪等に走り、`work_items` / `runs` / `events` / `external_refs` テーブルを作成する（`PRAGMA user_version` ベース等）。
- [ ] `WorkItem` 型に `id`(MON-12) / `kind` / `status` / `phase`(option) / `title` / `body` / `project_id`(option) / `labels` / `details_json` / `source_json`(option) / `created_at` / `updated_at` を持つ。
- [ ] status は `inbox / ready / setting_up / running / need_approval / stopped / failed / pr_open / done / archived` を表現できる（enum + 文字列変換）。
- [ ] `ExternalRef` を保存・取得できる（type / repo / number / url）。
- [ ] repository API: WorkItem の insert / get(by id) / list / update_status ができる。
- [ ] `MON-<number>` が単調増加で採番される（削除後も再利用しない）。
- [ ] panic/unwrap を使わず `Result` で伝播する。

### Verification

```bash
cargo test -p monica-core
```

- in-memory SQLite（`:memory:` または `MONICA_HOME` を tempdir に向ける）で migration → insert → list → update_status の round-trip をテストする。
- 採番テスト: 連続作成で `MON-1`, `MON-2`, ... と増えることを確認する。

### Links

- PROGRESS.md（Goal / 向かう先）
- docs/dev.md（size-first 原則と Rust 依存方針。DB はその例外）

---

## B. [M0] Project Registry（DB projects テーブル）

### Context

`issue run` は「どの repo で、どの branch 規則で worktree を作り、どの agent 設定で Claude を起動するか」を必要とする。project registry は単なる一覧ではなく **実行環境の定義**。人が直接ファイルを編集する前提は置かず、書き込みを `monica project ...` CLI（= agent からも叩ける）に一本化する。保存先は `monica.db` の `projects` テーブル（`toml` 依存を持たない）。1 project = 1 repo から始めるが、将来の複数 repo を見据えて名前は `project`。

### Goal

`monica project add owner/repo` / `set` / `list` / `show` が動き、`monica.db` の `projects` テーブルに実行環境設定を保存・読込できる。

### Out of Scope

- 1 project 複数 repo。
- repo の存在検証以上のバリデーション。
- 設定の TOML export/import（別マシン共有が要るようになったら別 issue）。
- run / worktree / Claude 起動（E 以降）。

### Acceptance Criteria

- [ ] migration で `projects` テーブルを追加する（Issue A の migration 基盤に v2 として積む）。
- [ ] `monica project add owner/repo` が projects を upsert する（既存は更新）。
- [ ] `monica project set owner/repo <key> <value>` で個別フィールドを更新できる（agent が叩ける粒度）。
- [ ] `monica project list` が登録済み project を表で出力する。
- [ ] `monica project show owner/repo [--json]` が 1 件の詳細を出力する（`--json` で機械可読）。
- [ ] 保存できるフィールド: `id` / `name` / `provider` / `repo` / `path` / `default_branch` / `worktree_root` / `branch_template` / `setup_timeout_sec` / `agent_default` / `agent_permission_mode` / `hooks_claude`。（setup スクリプトは規約 `.monica/setup.sh`、初期 prompt は規約 `.monica/prompt.md` 固定のため project 設定に持たない）
- [ ] 0 件時もエラーにせず空一覧/案内を出す。

### Verification

```bash
monica project add ashigirl96/monica
monica project set ashigirl96/monica setup_timeout_sec 600
monica project list
monica project show ashigirl96/monica --json
```

### Links

- Issue A（core 基盤 / migration / DB 接続）
- mvp ドキュメントの project config 例（フィールド定義の参考。保存先は `projects` テーブル）

---

## C. [M0] monica issue track owner/repo#123（GitHub Issue 取り込み）

### Context

既存の GitHub Issue を Monica で継続追跡したい。`new` ではなく `track` とするのは「既存 issue を指す」意味を明確にするため（mvp ドキュメントの指摘）。GitHub Issue は WorkItem 本体ではなく `external_ref` として保持する。

### Goal

`monica issue track owner/repo#123` で GitHub Issue を取り込み、`WorkItem`(kind=development, status=ready) と `ExternalRef`(github_issue) を作成し、`MON-<n>` を発行する。

### Out of Scope

- `issue new` / `--create-github`（新規 GitHub Issue 作成）。
- 双方向同期・ポーリング。
- run（E 以降）。

### Acceptance Criteria

- [ ] `owner/repo#123` をパースできる。
- [ ] `gh issue view <n> --repo owner/repo --json title,body,url,number` 等で title / body / url を取得する（`gh` CLI 前提）。
- [ ] `WorkItem`(kind=development, status=ready) を作成し `MON-<n>` を発行する。
- [ ] `ExternalRef`(type=github_issue, repo, number, url) を WorkItem に紐付ける。
- [ ] 同じ repo の project が registry にあれば `project_id` を紐付ける。
- [ ] 出力例: `Created MON-12 from owner/repo#123` / `Status: ready` / `Title: ...`。
- [ ] `gh` 未認証/失敗時に明確なエラーを返す。

### Verification

```bash
monica issue track ashigirl96/monica#9
# → Created MON-1 from ashigirl96/monica#9 / Status: ready / Title: ...
```

- Issue D 完了後は `monica issue status` で確認、未完なら DB を直接確認する。

### Links

- Issue A（WorkItem / ExternalRef モデル）
- Issue B（project 紐付け）

---

## D. [M0] monica issue status（一覧表示）

### Context

現状の最大の痛みは「どの Terminal で何が動いているか、どの Claude が終わったか、どれが確認待ちか分からない」こと。これを最初に解消するのが status 一覧。読むだけなので A の直後に着手でき、早期に価値が出る。

### Goal

`monica issue status` で WorkItem と紐づく run の状態を一覧表示できる（ID / PROJECT / GH ISSUE / STATUS / BRANCH / PR）。

### Out of Scope

- GUI / Kanban、interactive TUI、watch モード。
- status / project 以外の高度な filter。

### Acceptance Criteria

- [ ] `monica issue status` が WorkItem を表で出力する（ID / PROJECT / GH ISSUE / STATUS / BRANCH / PR）。
- [ ] `--status <S>` / `--project <P>` で filter できる。
- [ ] 最新 run の branch / PR 番号を表示できる。
- [ ] 0 件時に空状態メッセージを出す。
- [ ] 表整形は最小依存（手書き or 軽量 crate。size に配慮）。

### Verification

```bash
monica issue track ashigirl96/monica#9
monica issue status
monica issue status --status ready
```

### Links

- Issue A（モデル）
- Issue C（表示する実データの供給元）

---

## E. [M0] monica issue run MON-<id>（worktree + `.monica/setup.sh` 実行）

### Context

WorkItem を repo の実行環境へ接続する中核。worktree を作り、依存を入れて Claude がすぐ作業できる状態を作る。初期化は規約固定: 各 repo に `.monica/setup.sh` をコミットしておくと、`git worktree add` で HEAD のツリーが展開される際に worktree へ乗る。Monica は worktree 内の `.monica/setup.sh` を実行するだけでよく、project 設定にスクリプト path を持たせない（ゼロ設定）。

### Goal

`monica issue run MON-<id>` で、project 解決 → branch 生成 → git worktree 作成 → Run 記録 → `setting_up` → setup_script 実行 → 成功で `running` / 失敗で `failed`、setup.log を保存する。

### Out of Scope

- `--claude`（Claude 起動は F）。
- hook receiver（G）、PR 作成/検出。

### Acceptance Criteria

- [ ] `work_item.project_id` から project（repo path 等）を解決する。
- [ ] `branch_template` から branch 名を生成する（GH issue 有: `monica/gh-{gh}-mon-{n}-{slug}` / 無: `monica/mon-{n}-{slug}`）。
- [ ] `git worktree add` で worktree を作成する。
- [ ] `Run` レコードを作成し（agent / branch / worktree_path）、status を `setting_up` → `running`/`failed` と遷移させる。
- [ ] worktree 作成後、worktree 直下の `.monica/setup.sh` を worktree を cwd として実行する。`MONICA_ID` / `MONICA_RUN_ID` / `MONICA_PROJECT_ID` / branch 名 / worktree path を env で渡し、`setup_timeout_sec` を尊重する。
- [ ] `.monica/setup.sh` が無い repo は setup を skip して `running` にする（エラーにしない）。
- [ ] 出力を `runs/<run_id>/setup.log` に保存する。
- [ ] setup 失敗時は `failed` にし Claude を起動可能状態にしない（F の前提）。

### Verification

```bash
monica project add ashigirl96/monica
# 対象 repo に .monica/setup.sh がコミットされている前提
monica issue track ashigirl96/monica#9
monica issue run MON-1
ls ~/monica/runs/                     # run ディレクトリ
git -C <worktree.root> worktree list  # worktree 確認
monica issue status                   # status=running / branch 表示
```

### Links

- Issue A（Run モデル）
- Issue B（project / branch_template / setup_script）

---

## F. [M0] monica issue run MON-<id> --claude（`.monica/prompt.md` で Claude 起動）

### Context

`.monica/setup.sh` 成功後（または setup skip 後）、worktree 内の `.monica/prompt.md` の中身を初期 prompt として Claude Code を起動する。prompt も setup と同じく repo にコミットして worktree に乗せる規約方式（project 設定に prompt は持たない）。M0 の Monica は PR 作成を自前で持たず、`/tackle` に委ねる。

### Goal

`monica issue run MON-<id> --claude`（`--agent claude`）で、run ごとの `claude-settings.json` を生成し、env を付与して `claude --settings <path> "<.monica/prompt.md の中身>"` を起動、status を `running` にする。

### Out of Scope

- hook receiver の実装（G）。
- 複数 agent 同時起動、SDK 化、Terminal multiplexing。
- transcript 解析による状態自動分類。

### Acceptance Criteria

- [ ] `--claude` / `--agent claude` を受け付ける（内部的に `agent="claude"`）。
- [ ] run ごとに `runs/<run_id>/claude-settings.json` を生成する。settings には `SessionStart` / `Stop` / `StopFailure` / `SessionEnd` の command hook（`monica hook claude` を呼ぶ）を含める。
- [ ] `MONICA_ID` / `MONICA_RUN_ID` / `MONICA_PROJECT_ID` を env で渡す。
- [ ] worktree 内の `.monica/prompt.md` の中身を初期 prompt として `claude --settings <path> "<prompt>"` を worktree で起動する。`.monica/prompt.md` が無ければ prompt 無しで Claude を素の対話起動する。
- [ ] 実際に渡した prompt を `runs/<run_id>/prompt.txt` に保存し、`run.settings_path` を記録する。
- [ ] status を `running` にする。

### Verification

```bash
monica issue run MON-1 --claude
cat ~/monica/runs/<run_id>/claude-settings.json   # hook 設定を確認
cat ~/monica/runs/<run_id>/prompt.txt
# worktree で claude が .monica/prompt.md の中身で起動することを目視確認
```

### Links

- Issue E（worktree + setup_script が前提）
- Claude Code CLI `--settings` / hooks リファレンス

---

## G. [M0] Claude Hook Bridge（monica hook claude + issue mark）

### Context

Claude Code の hook から Monica の status を更新する。ただし `Stop` だけでは「承認待ち / 完了 / エラー」を区別できないため、`need_approval` などは hook 推測ではなく **Claude に `monica issue mark` を明示的に呼ばせる** signal を優先する（mvp ドキュメントの最重要修正）。

### Goal

`monica hook claude` が stdin の hook JSON と `MONICA_*` env を読んで event を記録し status を更新する。加えて `monica issue mark <MON-id> <status>` で明示的に status/phase を更新できる。

### Out of Scope

- transcript / last message の解析による自動分類（M1）。
- Slack / scheduler / GUI 連携。

### Acceptance Criteria

- [ ] `monica hook claude` が stdin JSON を受け取り、`MONICA_ID` / `MONICA_RUN_ID` を env から読む。
- [ ] event を `events` テーブルと `runs/<run_id>/hook-events.jsonl` に記録する。
- [ ] status を更新する: `SessionStart`→`running` / `Stop`→`stopped` / `StopFailure`→`failed` / `SessionEnd`→`stopped`。
- [ ] `monica issue mark MON-12 need-approval --note "..."` で status/phase を更新できる。
- [ ] `monica issue mark MON-12 pr-open --pr-url <url>` で PR 情報を記録できる。
- [ ] 未知の event / 不正 JSON でも落ちず、ログに残す。

### Verification

```bash
echo '{"hook_event_name":"Stop"}' | MONICA_ID=MON-1 MONICA_RUN_ID=run_x monica hook claude
monica issue status            # MON-1 が stopped
monica issue mark MON-1 need-approval --note "Plan ready"
monica issue status            # need_approval
```

### Links

- Issue F（settings.json が hook を呼ぶ）
- Claude Code hooks リファレンス（`SessionStart` / `Stop` / `StopFailure` / `SessionEnd`）
