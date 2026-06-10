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
- [x] Main Run を切り替えると TaskCard の表示 status / branch が切り替わる。
  - MVP 3 の `make_main_task_run` (cmd+g) で切り替え可能。

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
- [ ] `Prepare` 後に `Open` すると、worktree cwd のターミナルが開く。（実装済み・動作未検証）

### 0-4. Open Bench の cwd を worktree に合わせる

- [x] `BenchRepository` に `update_bench_cwd` を追加する。
- [x] `execute_run` で worktree 完成後に bench の cwd を更新する。
- [x] `createTaskRunspaceAtom` で既存 runspace の cwd が変わっていたら tab cwd を更新する。
- [x] Open Bench だけの場合は既存 cwd を尊重する。
- [x] `open_bench` で bench 新規作成時に、既存 TaskRun の worktree_path があればそれを cwd にする。

Acceptance（実装済み・動作未検証）:

- [ ] Prepare 後に Open すると terminal は対象 worktree で起動する。
- [ ] 既存 Bench を開くだけなら cwd が意図せず変わらない。

---

## MVP 1: Run ボタン + Claude Code 自動フック注入

> 2026-06-10 時点: `feat/run-task` マージで実装完了。残りは end-to-end の動作検証のみ。

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

- [x] `start_run()` に active run guard を追加する。
  - `done` タスクは reject。
  - primary run が `setting_up` / `running` / `waiting_for_user` の場合は reject。
  - ⚠️ 設計変更: primary run が `prepared` の場合も error で reject（message で Run の使用を案内）。既存 prepared run への自動誘導はしない。
  - `stopped` / `failed` は新規 Prepare を許可する。
- [x] `execute_run()` の失敗時に DB が `setting_up` に残らないようにする。
  - worktree 作成失敗、setup 失敗、bench cwd 更新失敗のすべてで `Failed` にする。
  - `update_bench_cwd()` は `Prepared` 遷移前に実行する。

Acceptance:

- [x] 二重 Prepare / active run 中の Prepare が backend で拒否される。
- [x] setup 前の失敗でも TaskRun が `failed` になる。

### 1-1. PTY に env 注入機能を追加する

- [x] `SpawnRequest` に `env: Option<Vec<(String, String)>>` を追加する。
- [x] `PtyManager::spawn()` で `req.env` を `CommandBuilder::env()` に適用する。
- [x] `pty_spawn` Tauri command に `env` パラメータを追加する。
- [x] `ptySpawn` TS wrapper に `env` 引数を追加する。

Acceptance:

- [x] 既存 PTY テストが `env: None` で通る。
- [x] env 付き spawn で `MONICA_TASK_RUN_ID` が shell から見える。

### 1-2. Claude wrapper と hook command 解決を実装する

- [x] ⚠️ 設計変更: `RunArtifacts` trait には `prepare_run_env()` ではなく `prepare_task_shell_env()` を追加した。
  - `TaskShellEnv { env, settings_path, wrapper_path }` を返す。
  - `task_run_id: Option<&str>` を取り、TaskRun なし（Bench を開くだけ）の shell env 生成にも使える。
- [x] `<task_shell_dir>/bin/claude` wrapper script を生成する。
  - real `claude` を PATH から探す（自身の directory を除外）。
  - `MONICA_CLAUDE_SETTINGS_PATH` がなければ pass-through。
  - `claude mcp` / `config` / `api-key` は pass-through。
  - `--settings` は常に注入する（Claude Code はアディティブにマージする）。
  - `--dangerously-skip-permissions` を注入する。
  - 実装で追加: `--session-id` を自動生成して注入する。
- [x] hook command 解決: `MONICA_HOOK_COMMAND` → `MONICA_CLI_PATH` → PATH 上の `monica` → error。
- [x] 返す env: `MONICA_TASK_ID`, `MONICA_TASK_RUN_ID`, `MONICA_ID`, `MONICA_RUN_ID`, `MONICA_PROJECT_ID`, `MONICA_CLAUDE_SETTINGS_PATH`, `PATH`（wrapper bin を prepend）。
  - 実装で追加: `MONICA_HOME`, `MONICA_CLAUDE_WRAPPER`, `ZDOTDIR`。

Acceptance:

- [x] wrapper が実行可能で、real `claude` を再帰的に自分へ解決しない。
- [x] `monica` CLI が PATH になく `MONICA_CLI_PATH` も未設定の場合、Run が明示的に失敗する。

### 1-3. `run_task` Tauri command を追加する

- [x] `prepare_claude_for_run()` usecase: prepared primary run から launch env + bench open を行う。
  - TaskRun が `Prepared` でなければ error。
  - `prepare_task_shell_env()` で settings + wrapper + env を生成。
  - `set_task_run_settings_path()` を実行。
  - bench を open/create し、cwd を worktree に更新。
  - `Running` にはしない（hook の `SessionStart` に任せる）。
- [x] `RunTaskResult { task_id, task_run_id, runspace_id, cwd, env, initial_command }` を返す。
- [x] `run_task` Tauri command を `collect_commands!` に登録。

Acceptance:

- [x] non-prepared primary run では `runTask` が error。
- [x] `runTask` 後も DB status は `prepared` のまま。
- [x] env に `PATH` / `MONICA_*` / settings path が含まれる。

### 1-4. Workboard の Run flow と TaskCard に Run ボタンを追加する

- [x] `runTaskAtom`: 未 prepared なら `prepareTask` → 完了待ち → `runTask` → Workbench 遷移。
- [x] `waitForPreparedOrFailed()`: event listener + polling のハイブリッド。timeout 120 秒。
- [x] TaskCard に Run ボタン追加。表示: `inbox`, `ready`, `prepared`, `stopped`, `failed`。
- [x] Run ボタンは `setting_up`, `running`, `waiting_for_user`, `done` で非表示。

Acceptance:

- [x] ready タスクで Run → prepare 完了後に Workbench へ遷移。
- [ ] failed prepare は Workbench を開かず error。（実装済み・動作未検証）

### 1-5. Terminal launch intent を一回限りで消費する

- [x] `TerminalLaunchIntent { env, initialCommand }` 型を追加する。
- [x] `TerminalTab` に `launch?: TerminalLaunchIntent` を追加する（永続化しない）。
- [x] `createTaskRunspaceAtom` に `launch` が渡された場合は、既存 runspace 内に新規 tab を作る。
- [x] `useTerminal` で env 付き `ptySpawn` + spawn 後に `initialCommand + "\r"` を一度だけ書き込む。
- [x] command 書き込み後に launch intent を消す。

Acceptance:

- [x] prepared タスクで Run → 新規 tab が作られ、env 付き shell で `claude` が起動する。
- [ ] 同じタスクで再度 Run → 既存 tab に割り込まず新規 tab が作られる。（実装済み・動作未検証）
- [ ] Bench ボタン → 既存挙動のまま。（実装済み・動作未検証）
- [x] app restart 後に launch intent が残らない（snapshot 永続化対象から除外済み）。

### 1-6. Hook による lifecycle 確認

- [x] wrapper 経由で起動した Claude の hook event が `hook-events.jsonl` に追記される。
- [x] `record_claude_hook()` が TaskRun status を `prepared` → `running`（SessionStart）に更新する。
- [x] `PreToolUse AskUserQuestion` / `ExitPlanMode` で `waiting_for_user` になる。
- [x] `Stop` / `SessionEnd` で `stopped` になる。
- 実装で追加（TODO 記載外）:
  - `UserPromptSubmit` → `running`、`PostToolUse`（AskUserQuestion/ExitPlanMode）→ `running` 復帰、`StopFailure` → `failed`。
  - `claim_primary_run()`: hook event に task_run_id がない場合、prepared な primary run を claim して紐づける（MVP 2-2 の一部を先取り）。

Acceptance:

- [x] Run → Claude 起動 → TaskCard が `running` → `waiting_for_user` → `stopped` と hook 経由で遷移する。（side run でも同遷移を実機確認）
- [ ] Workboard reload でも表示が追従する。（実装済み・動作未検証）

---

## MVP 2: plain `claude` 起動の side run 化

Runspace 内で追加起動した plain `claude` を、Main Run とは別の side run として扱えるようにする。

用語: 「plain `claude`」= ユーザーが打つコマンドとしては素の `claude`。runspace shell は PATH 先頭に wrapper bin が入っているため、実際に実行されるのは wrapper 経由の claude（hook 注入済み）。wrapper を通らない裸の claude のことではない。

設計変更（旧: `monica claude` subcommand 方式）:

- 当初は hook 注入の正式導線として `monica claude` subcommand を想定していたが、MVP 1 の wrapper 方式（`prepare_task_shell_env` が PATH に wrapper bin を prepend）により、**Bench の通常タブで plain `claude` を打つだけで hook が注入される状態が既に成立している**。
- よって `monica claude` は作らない。side run は plain `claude` の hook event から **backend が遅延生成**する。
- run の identity は wrapper が自動生成する `--session-id`（hook の `provider_session_id`）で決める。
- run の所在（どのタブで動いているか）は、PTY spawn 時に注入するタブ識別子 env で決める。Make Main（MVP 3）が「active tab の run を昇格」できるのはこのため。
- `--main` 的な起動 option は不要。昇格は MVP 3 の Make Main に一本化する。

### 2-1. Runspace shell に Monica context env を注入する

- [x] PTY spawn に env 指定を追加する。（MVP 1-1 で実装済み）
- [ ] Runspace shell には TaskRun 固有ではなく Runspace/Task context を入れる。
  - ⚠️ 実装判断: `MONICA_CONTEXT` / `MONICA_RUNSPACE_ID` / `MONICA_WORKTREE` / `MONICA_BRANCH` / `MONICA_MAIN_TASK_RUN_ID` は**今回見送り**。MVP 2/3 に必要なのは tab_id だけで、WORKTREE/BRANCH/MAIN_TASK_RUN_ID は alive shell に後入れできず stale になる。消費者が現れたら再検討。
- [x] タブごとの shell env に `MONICA_TERMINAL_TAB_ID=<tab_id>` を注入する。
  - `use-terminal.ts` の ptySpawn で launch/runspace env に append。claude は shell の子プロセスとして env を継承し、hook がこれを読んで TaskRun に tab_id を刻む（V14: `task_runs.terminal_tab_id`）。
- [x] 通常 shell には `MONICA_TASK_RUN_ID` を常時入れない。（Bench shell は `task_run_id=None` で生成され、`MONICA_TASK_RUN_ID` は Run の launch env のみ）

Acceptance:

- [ ] shell から Task/Runspace context を解決できる。（`MONICA_TASK_ID` / `MONICA_TERMINAL_TAB_ID` で可。runspace 固有 env は見送り）
- [x] 追加 Claude が誤って Main Run の `MONICA_TASK_RUN_ID` に紐づかない。
- [x] 各タブの shell から自分の `MONICA_TERMINAL_TAB_ID` が見える。（cmd+g が tab → run を解決できたことで実機確認）

### 2-2. hook 駆動で side run を自動生成する

> 実装済み: `claim_primary_run` は `resolve_hook_run`（record_claude_hook.rs）に拡張され、上から順の状態機械として動く: R1 明示 run id → R4 session 追従 → R5 Prepared primary claim → R6 遅延生成（SessionStart/UserPromptSubmit + session_id あり + task が done でない場合のみ。primary 未設定/dangling なら primary 化、それ以外は side run）→ R7 素通り。

- [x] hook event の `provider_session_id` で既存 TaskRun を検索できるようにする（`find_task_run_by_session(task_id, session_id)`）。
- [x] `claim_primary_run` を拡張する（→ `resolve_hook_run` に改名）:
  - primary が `Prepared` → claim（現状どおり）。
  - 同一 session → 追従（現状どおり）。
  - session に対応する既存 side run があれば → それに紐づける。
  - primary が別 session で稼働中 → **新しい TaskRun を side run として作る**。worktree_path は hook payload の `cwd`、setup phase なし。
  - primary 未設定（または dangling）→ 新しい TaskRun を作って primary にする。
  - 実装で追加: done task では run を生成しない（`start_task_run` の副作用で task が in_progress に巻き戻る事故を防止）。
  - 実装で追加: 生成は SessionStart / UserPromptSubmit に限定（野良 Stop/SessionEnd で run が生えない）。
- [x] side run 生成/claim 時に `MONICA_TERMINAL_TAB_ID` を TaskRun に記録する。（`HookContext` 経由、observation の COALESCE update）
- [x] resume (`claude -c` / `--resume`) の扱いを決める。session_id が変わるため新 side run が生える。初期実装はそれを許容し、問題になったら transcript 連続性での同一 run 化を検討する。

Acceptance:

- [x] Runspace 内の plain `claude` が Task ID 指定なしで side run として追跡される。
- [x] 既存 Main Run がある場合、追加 run は TaskCard の status source を奪わない。
- [x] side run の status が hook 経由で `running` / `waiting_for_user` / `stopped` と遷移する。

### 2-3. side run indicator を TaskCard に追加する

- [x] TaskSummary に side run の集計情報を追加する。
  - `side_runs_running` / `side_runs_waiting_for_user` / `side_runs_failed`
  - 実装判断: failed count は `provider_session_id IS NOT NULL` の run のみ数える。claude セッションを持たない過去の Prepare 失敗 run が永久に badge に出るのを防ぐ。
- [x] TaskCard の column/status は Main Run のまま維持する。
- [x] side run に `waiting_for_user` / `failed` があれば小さな badge を出す。（`SideRunBadges`: waiting=amber / failed=red / running=無彩色寄りの控えめ表示）

Acceptance:

- [x] side run が waiting になっても TaskCard の列は Main Run 由来のまま。（SQL が primary 優先のため構造的に保証）
- [x] side run の注意喚起はカード上で見える。

---

## MVP 3: Make Main（active tab ベース）

複数 TaskRun がある Task で、どの run を主線にするかを Workbench から切り替えられるようにする。

設計変更（旧: Run selector 方式）:

- Header の selector 一覧から選ぶのではなく、**いまフォーカスしている claude のタブをショートカット（例: cmd+g）で一発昇格**する UX を主線にする。
- 想定フロー: Run で primary の claude が立ち上がる → 別タブで plain `claude` を立てて調査 → こっちが本命だと思ったら cmd+g → active tab に対応する TaskRun が primary になり、TaskCard の status/branch source が即座に切り替わる。元の primary は side run に降格するが、プロセスは両方動き続ける。
- tab → TaskRun の解決は 2-1/2-2 で TaskRun に刻んだ tab_id（`MONICA_TERMINAL_TAB_ID`）を使う。
- selector 一覧（run の俯瞰表示）は廃止ではなく、優先度を下げて 3-2 に残す。

### 3-1. cmd+g: active tab の run を Make Main する

- [x] `find_task_run_by_terminal_tab(tab_id)` lookup を追加する。（最新 run 優先の ORDER BY。tab_id だけで run → task が引けるため、make_main の引数は tab_id のみ）
- [x] `make_main_task_run(tab_id)` Tauri command を追加する。（usecase は `make_main_by_terminal_tab` → `Changed | AlreadyMain | NotFound`）
- [x] Workbench に keybinding cmd+g を追加し、active tab → TaskRun → make_main を実行する。（`use-shortcuts.ts`。xterm の hidden textarea があるため editable ガードより前に配置）
- [x] 昇格後に `task-run:status-changed` イベントを発行し、TaskCard の status/branch source を即座に切り替える。（Changed のときのみ emit）
- [x] edge case:
  - active tab に対応する TaskRun がない（shell のまま / claude 未起動）→ NotFound で no-op。
  - 同じタブで claude を終了して再起動 → 新 session の hook が同じ tab_id を上書きするので「そのタブの最新の run」が昇格対象。
  - 既に primary のタブで cmd+g → AlreadyMain で no-op（イベントも出さない）。
- [x] 追加実装: Workbench タブの Main Run indicator。
  - `primary_tab_id(task_id)` Tauri command + `primaryTabByTaskAtom`。
  - header で event listen + 3 秒 polling（hook 由来の claim はイベントが飛ばないため）。
  - Main Run のタブに emerald ドットを常時表示。

Acceptance:

- [x] side run のタブで cmd+g → TaskCard の column/status/branch が新 Main Run に基づいて変わる。
- [x] 旧 primary の claude は止まらず、side run として hook 追跡が続く。
- [x] shell のみのタブで cmd+g しても何も壊れない。

既知の制約: side run を primary 化すると TaskCard の branch badge が消える（side run の branch は None。将来 worktree_path から git branch を解決して改善）。

### 3-2. Run 一覧の俯瞰表示（優先度低・今回スコープ外）

- [ ] Task に紐づく TaskRun 一覧を取得する API を追加する。
- [ ] Runspace Header などで run の role/status/created_at/branch を確認できるようにする。
- [ ] Main Run がどれか一目で分かる。
- [ ] 一覧から任意の run を Make Main できるようにする（cmd+g の補完。tab が閉じた run の昇格はこちらでしかできない）。

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

### P-4. plain `claude` auto-wrap opt-in（方針逆転により解消）

> MVP 1 の wrapper 方式で plain `claude` の auto-wrap が**デフォルトの現実**になったため、「`monica claude` を正式導線にして auto-wrap を opt-in にする」という前提は逆転した。`monica claude` は作らない（MVP 2 冒頭の設計変更を参照）。

- [ ] auto-wrap が効いていること（wrapper 経由であること）を Workbench Header に明示表示する。
- [ ] 必要になったら project/runspace 設定で auto-wrap を opt-out できるようにする。
