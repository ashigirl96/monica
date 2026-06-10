# Monica Frontend Rebuild TODO

## Workboard / Workbench: TaskRun-aware Prepare & Open

この TODO は、Workboard の TaskCard から Workbench / Runspace / TaskRun / Claude Code を段階的に統合していくための修正単位です。

前提方針:

- `Open` / `Prepare` / `Run` は独立した操作。
  - `Open` (Bench): 既存 Runspace を開く。新しい TaskRun は作らない。Workbench へ遷移。
  - `Prepare`: TaskRun を作り、worktree/setup を非同期実行。**Workboard に留まる。** agent は起動しない。
  - `Run`: Prepare（必要なら）+ Workbench 遷移 + Claude Code 自動起動を一連で行う。
- TaskCard の表示 status は「最新 TaskRun」ではなく「Main Run」を優先して決める。
- UI 上の呼び名は `Active Run` より **Main Run** を使う。
- TaskRunStatus は段階を正確に表現する。
  - `setting_up`: worktree 作成 + setup.sh 実行中。
  - `prepared`: worktree + setup 完了、agent 未起動。
  - `running`: agent (Claude Code) が実行中（hook の `SessionStart` で確定）。
- `setup script` は Claude Code なしでも実行できる。
- `template prompt` / `continue` / `fork` / Claude settings は Claude Code 起動時だけ有効にする。
- Run 経由の PTY では、nori 方式の `claude` wrapper script で hook 設定を自動注入する。

---

## MVP 0: Prepare (async) + Open (独立)

Claude Code 起動なしで、Workboard から Task の worktree/setup を非同期実行し、TaskCard でリアルタイムに status を追える状態を作る。

### 0-1. Main Run 概念をデータモデルに追加する

- [x] Task ごとに Main Run を参照できる永続データを追加する。
  - `tasks.primary_task_run_id` (V13 migration)
- [x] 既存データでは Main Run が未設定でも動くようにする。
- [x] Main Run 未設定時は従来どおり latest TaskRun を fallback として扱う。
- [x] Main Run 設定/変更用の repository API を追加する (`set_primary_task_run`)。

Acceptance:

- [x] Main Run がある Task は、その TaskRun を status source にできる。
- [x] Main Run がない既存 Task は壊れない。

### 0-2. TaskCard / TaskSummary の status source を Main Run 優先に変更する

- [x] `list_task_summaries` の latest run join を `COALESCE(primary_task_run_id, latest)` に変更する。
- [x] `TaskSummaryRow` の `task_run_status`, `task_run_wait_reason`, `branch` は Main Run 由来にする。
- [x] Main Run 未設定時だけ latest run を fallback にする。
- [x] `DisplayStatus::from_task_and_run` の既存ルールは維持する。

Acceptance:

- [x] side/future run が追加されても、Main Run がある限り TaskCard の列は変わらない。
- [ ] Main Run を切り替えると TaskCard の表示 status / branch が切り替わる。

### 0-3. `Prepare` ボタンと非同期実行 flow を追加する

- [x] 現在の `openBench` は「開くだけ」の責務として維持する。
- [x] 新しい `prepare_task` Tauri command を追加する。
- [x] TaskCard に `Prepare` ボタンと `Bench` ボタンを独立して表示する。
- [x] `Prepare` は Workboard に留まり、Workbench に遷移しない。
- [x] Backend を2段階に分割する。
  - `start_run`: 即座に TaskRun (SettingUp) 作成 + Main Run 設定 → UI に即返却。
  - `execute_run`: バックグラウンドスレッドで worktree 作成 + setup 実行 → status 更新。
- [x] `run_issue.rs` の `setup_phase` / `latest_github_issue_number` を `pub(crate)` に昇格して再利用する。
- [x] `execute_run` 完了時に `app.emit("task-run:status-changed", ...)` で Tauri イベントを発行する。
- [x] Workboard content でイベントを購読し、`listTaskSummaries` をリフレッシュする。
- [x] setup 結果に応じて TaskRun を `prepared` または `failed` に更新する。
- [x] bench レコードを作成/更新し、cwd を worktree path にする。
- [x] `TaskRunStatus::Prepared` / `DisplayStatus::Prepared` を追加する。

Acceptance:

- [x] `Prepare` クリック後、TaskCard が即座に `setting_up` (pulse) に変わる。
- [x] 数秒後、バックグラウンド完了で `prepared` / `failed` に自動遷移する。
- [x] `Open Bench` では TaskRun が増えない。
- [ ] `Prepare` 後に `Open` すると、worktree cwd のターミナルが開く。

### 0-4. Open Bench の cwd を worktree に合わせる

- [x] `BenchRepository` に `update_bench_cwd` を追加する。
- [x] `execute_run` で worktree 完成後に bench の cwd を更新する。
- [x] `createTaskRunspaceAtom` で既存 runspace の cwd が変わっていたら tab cwd を更新する。
- [x] Open Bench だけの場合は既存 cwd を尊重する。
- [x] `open_bench` で bench 新規作成時に、既存 TaskRun の worktree_path があればそれを cwd にする。

Acceptance:

- [ ] Prepare 後に Open すると terminal は対象 worktree で起動する。
- [ ] 既存 Bench を開くだけなら cwd が意図せず変わらない。

---

## MVP 1: Run ボタン + Claude Code 自動フック注入

Workboard の TaskCard から **Run** を押すと、Prepare（必要なら）+ Workbench 遷移 + Claude Code 自動起動を行う。
PTY 内で `claude` を打った場合も、nori 方式の wrapper script で Monica の hook 設定が自動注入される。

方針:

- `Run` は `Prepare` + `Open` + Claude 起動を一連で行う操作。`Prepare` / `Open` は引き続き独立して使える。
- `run_task` backend command は Prepare を背負わない。prepared の primary run に対する launch env 生成だけ。
- `TaskRunStatus::Running` への遷移は Claude hook の `SessionStart` が source of truth。backend で推測しない。
- hook command は Tauri app 実行ファイルではなく、`monica hook claude` を処理できる CLI を明示的に解決する。
- 既存 alive PTY には env を後入れできない。Run は launch env 付きの新規 terminal tab を作る。
- `initialCommand` / `env` は永続化しない。一回限りの launch intent として消費する。

### 1-0. Prepare 側の状態遷移を固める

- [ ] `start_run()` に active run guard を追加する。
  - `done` タスクは reject。
  - primary run が `setting_up` / `running` / `waiting_for_user` の場合は reject。
  - primary run が `prepared` の場合は新規 run を作らず、既存 prepared run を誘導。
  - `stopped` / `failed` は新規 Prepare を許可する。
- [ ] `execute_run()` の失敗時に DB が `setting_up` に残らないようにする。
  - worktree 作成失敗、setup 失敗、bench cwd 更新失敗のすべてで `Failed` にする。
  - `update_bench_cwd()` は `Prepared` 遷移前に実行する。

Acceptance:

- [ ] 二重 Prepare / active run 中の Prepare が backend で拒否される。
- [ ] setup 前の失敗でも TaskRun が `failed` になる。

### 1-1. PTY に env 注入機能を追加する

- [ ] `SpawnRequest` に `env: Option<Vec<(String, String)>>` を追加する。
- [ ] `PtyManager::spawn()` で `req.env` を `CommandBuilder::env()` に適用する。
- [ ] `pty_spawn` Tauri command に `env` パラメータを追加する。
- [ ] `ptySpawn` TS wrapper に `env` 引数を追加する。

Acceptance:

- [ ] 既存 PTY テストが `env: None` で通る。
- [ ] env 付き spawn で `MONICA_TASK_RUN_ID` が shell から見える。

### 1-2. Claude wrapper と hook command 解決を実装する

- [ ] `RunArtifacts` trait に `prepare_run_env()` を追加する。
- [ ] `<task_run_dir>/bin/claude` wrapper script を生成する。
  - real `claude` を PATH から探す（自身の directory を除外）。
  - `MONICA_CLAUDE_SETTINGS_PATH` がなければ pass-through。
  - `claude mcp` / `config` / `api-key` は pass-through。
  - `--settings` は常に注入する（Claude Code はアディティブにマージする）。
  - `--dangerously-skip-permissions` を注入する。
- [ ] hook command 解決: `MONICA_HOOK_COMMAND` → `MONICA_CLI_PATH` → PATH 上の `monica` → error。
- [ ] 返す env: `MONICA_TASK_ID`, `MONICA_TASK_RUN_ID`, `MONICA_ID`, `MONICA_RUN_ID`, `MONICA_PROJECT_ID`, `MONICA_CLAUDE_SETTINGS_PATH`, `PATH`（wrapper bin を prepend）。

Acceptance:

- [ ] wrapper が実行可能で、real `claude` を再帰的に自分へ解決しない。
- [ ] `monica` CLI が PATH になく `MONICA_CLI_PATH` も未設定の場合、Run が明示的に失敗する。

### 1-3. `run_task` Tauri command を追加する

- [ ] `prepare_claude_for_run()` usecase: prepared primary run から launch env + bench open を行う。
  - TaskRun が `Prepared` でなければ error。
  - `prepare_run_env()` で settings + wrapper + env を生成。
  - `set_task_run_settings_path()` を実行。
  - bench を open/create し、cwd を worktree に更新。
  - `Running` にはしない（hook の `SessionStart` に任せる）。
- [ ] `RunTaskResult { task_id, task_run_id, runspace_id, cwd, env, initial_command }` を返す。
- [ ] `run_task` Tauri command を `collect_commands!` に登録。

Acceptance:

- [ ] non-prepared primary run では `runTask` が error。
- [ ] `runTask` 後も DB status は `prepared` のまま。
- [ ] env に `PATH` / `MONICA_*` / settings path が含まれる。

### 1-4. Workboard の Run flow と TaskCard に Run ボタンを追加する

- [ ] `runTaskAtom`: 未 prepared なら `prepareTask` → 完了待ち → `runTask` → Workbench 遷移。
- [ ] `waitForPreparedOrFailed()`: event listener + polling のハイブリッド。timeout 120 秒。
- [ ] TaskCard に Run ボタン追加。表示: `inbox`, `ready`, `prepared`, `stopped`, `failed`。
- [ ] Run ボタンは `setting_up`, `running`, `waiting_for_user`, `done` で非表示。

Acceptance:

- [ ] ready タスクで Run → prepare 完了後に Workbench へ遷移。
- [ ] failed prepare は Workbench を開かず error。

### 1-5. Terminal launch intent を一回限りで消費する

- [ ] `TerminalLaunchIntent { env, initialCommand }` 型を追加する。
- [ ] `TerminalTab` に `launch?: TerminalLaunchIntent` を追加する（永続化しない）。
- [ ] `createTaskRunspaceAtom` に `launch` が渡された場合は、既存 runspace 内に新規 tab を作る。
- [ ] `useTerminal` で env 付き `ptySpawn` + spawn 後に `initialCommand + "\r"` を一度だけ書き込む。
- [ ] command 書き込み後に launch intent を消す。

Acceptance:

- [ ] prepared タスクで Run → 新規 tab が作られ、env 付き shell で `claude` が起動する。
- [ ] 同じタスクで再度 Run → 既存 tab に割り込まず新規 tab が作られる。
- [ ] Bench ボタン → 既存挙動のまま。
- [ ] app restart 後に launch intent が残らない。

### 1-6. Hook による lifecycle 確認

- [ ] wrapper 経由で起動した Claude の hook event が `hook-events.jsonl` に追記される。
- [ ] `record_claude_hook()` が TaskRun status を `prepared` → `running`（SessionStart）に更新する。
- [ ] `PreToolUse AskUserQuestion` / `ExitPlanMode` で `waiting_for_user` になる。
- [ ] `Stop` / `SessionEnd` で `stopped` になる。

Acceptance:

- [ ] Run → Claude 起動 → TaskCard が `running` → `waiting_for_user` → `stopped` と hook 経由で遷移する。
- [ ] Workboard reload でも表示が追従する。

---

## MVP 2: Runspace context と side run

Runspace 内で追加起動した Claude を、Main Run とは別の side run として扱えるようにする。

### 2-1. Runspace shell に Monica context env を注入する

- [ ] PTY spawn に env 指定を追加する。
- [ ] Runspace shell には TaskRun 固有ではなく Runspace/Task context を入れる。
  - `MONICA_CONTEXT=runspace`
  - `MONICA_PROJECT_ID`
  - `MONICA_TASK_ID`
  - `MONICA_RUNSPACE_ID`
  - `MONICA_WORKTREE`
  - `MONICA_BRANCH`
  - `MONICA_MAIN_TASK_RUN_ID`
- [ ] 通常 shell には `MONICA_TASK_RUN_ID` を常時入れない。

Acceptance:

- [ ] shell から Task/Runspace context を解決できる。
- [ ] 追加 Claude が誤って Main Run の `MONICA_TASK_RUN_ID` に紐づかない。

### 2-2. `monica claude` を Runspace context 対応にする

- [ ] `MONICA_TASK_ID` / `MONICA_RUNSPACE_ID` から対象 Task を解決する。
- [ ] Main Run がない場合は新しい TaskRun を Main Run にする。
- [ ] Main Run がある場合はデフォルトで side run として TaskRun を作る。
- [ ] `--main` / `--make-main` のような明示 option で Main Run にできるようにする。

Acceptance:

- [ ] Runspace 内の `monica claude` は Task ID 指定なしで起動できる。
- [ ] 既存 Main Run がある場合、追加 run は TaskCard の status source を奪わない。

### 2-3. side run indicator を TaskCard に追加する

- [ ] TaskSummary に side run の集計情報を追加する。
  - waiting count
  - failed count
  - running count
- [ ] TaskCard の column/status は Main Run のまま維持する。
- [ ] side run に `waiting_for_user` / `failed` があれば小さな badge を出す。

Acceptance:

- [ ] side run が waiting になっても TaskCard の列は Main Run 由来のまま。
- [ ] side run の注意喚起はカード上で見える。

---

## MVP 3: Run selector / Make Main

複数 TaskRun がある Task で、どの run を主線にするかを Workbench から切り替えられるようにする。

### 3-1. Runspace Header に Run selector を追加する

- [ ] Runspace Header に Main Run と selected run を表示する。
- [ ] Task に紐づく TaskRun 一覧を取得する API を追加する。
- [ ] run の role/status/created_at/branch/agent を表示する。

Acceptance:

- [ ] Workbench で TaskRun 一覧を確認できる。
- [ ] Main Run がどれか一目で分かる。

### 3-2. Make Main action を追加する

- [ ] 任意の TaskRun を Main Run に設定する action を追加する。
- [ ] Make Main 後、TaskCard の status source が即座に変わる。
- [ ] Runspace Header の Main Run 表示も更新する。

Acceptance:

- [ ] side run を Main Run に昇格できる。
- [ ] 昇格後、Workboard の column/status が新 Main Run に基づいて変わる。

---

## Post-MVP: Project defaults / Run profiles

### P-1. Project default RunProfile

- [ ] Project ごとに default run profile を保存できるようにする。
- [ ] TaskCard に `Run Default` を追加する。
- [ ] profile に以下を含める。
  - setup policy
  - agent kind
  - prompt policy
  - permission mode
  - hooks enabled

### P-2. Run profiles UI

- [ ] `Prepare only`
- [ ] `Claude Plan`
- [ ] `Claude Implement`
- [ ] `Ask Claude`
- [ ] `Continue Claude`
- [ ] `Fork Claude`

### P-3. AgentSession / TerminalSession 分離

- [ ] TaskRun と Claude Code conversation/process を分離する。
- [ ] AgentSession に provider session id / transcript / settings / prompt を持たせる。
- [ ] TerminalSession に tab/cwd/env/status を持たせる。

### P-4. plain `claude` auto-wrap opt-in

- [ ] 最初は `monica claude` のみを正式導線にする。
- [ ] 将来的に project/runspace 設定で plain `claude` auto-wrap を opt-in できるようにする。
- [ ] auto-wrap 有効時は Workbench Header に明示表示する。
