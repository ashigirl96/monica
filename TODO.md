# Monica Frontend Rebuild TODO

## Workboard / Workbench: TaskRun-aware Prepare & Open

この TODO は、Workboard の TaskCard から Workbench / Runspace / TaskRun / Claude Code を段階的に統合していくための修正単位です。

前提方針:

- `Open` と `Prepare` は独立した操作。
  - `Open` (Bench): 既存 Runspace を開く。新しい TaskRun は作らない。Workbench へ遷移。
  - `Prepare`: TaskRun を作り、worktree/setup を非同期実行。**Workboard に留まる。** agent は起動しない。
- TaskCard の表示 status は「最新 TaskRun」ではなく「Main Run」を優先して決める。
- UI 上の呼び名は `Active Run` より **Main Run** を使う。
- TaskRunStatus は段階を正確に表現する。
  - `setting_up`: worktree 作成 + setup.sh 実行中。
  - `prepared`: worktree + setup 完了、agent 未起動。
  - `running`: agent (Claude Code) が実行中。
- `setup script` は Claude Code なしでも実行できる。
- `template prompt` / `continue` / `fork` / Claude settings は Claude Code 起動時だけ有効にする。
- 最初は plain `claude` の自動 wrap はしない。明示的な `monica claude` / UI 起動を優先する。

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

## MVP 1: Claude Code launch option

worktree/setup の flow が安定してから、Claude Code 起動を option として追加する。

### 1-1. Run launch sheet を追加する

- [ ] TaskCard の `Prepare` から簡易 launch sheet を開く（または別途 `Run` ボタンを追加する）。
- [ ] 最初の options は以下に絞る。
  - `Run setup script`
  - `Start Claude Code`
  - `Use template prompt`
- [ ] `Use template prompt` は `Start Claude Code` が off のとき disabled にする。
- [ ] `Use template prompt` は Claude launch mode が `new` のときだけ有効にする。

Acceptance:

- [ ] Claude off の状態で prompt option を選べない。
- [ ] setup only / setup + Claude の両方を選べる。

### 1-2. Claude launch artifact を Prepare/Run flow に接続する

- [ ] Claude enabled のときだけ `claude-settings.json` と `prompt.txt` を生成する。
- [ ] Claude process env に以下を注入する。
  - `MONICA_TASK_ID`
  - `MONICA_TASK_RUN_ID`
  - `MONICA_ID`
  - `MONICA_RUN_ID`
  - `MONICA_PROJECT_ID`
- [ ] setup failed の場合は Claude を起動しない。
- [ ] settings path を TaskRun に保存する。
- [ ] Claude 起動時に TaskRunStatus を `prepared` → `running` に遷移する。

Acceptance:

- [ ] Claude hook event が対象 TaskRun に記録される。
- [ ] setup failed では Claude 起動が発生しない。

### 1-3. Claude を Workbench 内で見える形で起動する

- [ ] 短期方針を選ぶ。
  - Option A: shell tab に command を queue/write する。
  - Option B: PTY が program/args/env を直接 spawn できるようにする。
- [ ] MVP では実装が軽い方を採用してよいが、TaskRun lifecycle の source of truth は backend に置く。
- [ ] Agent tab / terminal tab 上で Claude 起動状態を見られるようにする。

Acceptance:

- [ ] Prepare 後、Claude enabled なら Workbench 上で Claude Code が見える。
- [ ] Claude の hook によって TaskRun が `running` / `waiting_for_user` / `stopped` / `failed` に遷移する。

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
