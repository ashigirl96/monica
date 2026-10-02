# tania

私と AI エージェントが一緒に仕事を進めるための個人用 Agentic Workspace。monica の後継で、Workbench（端末）を引き継ぎ、Task を作り直す。

## Language

### Task

**Task**:
1 つの Issue に対する私の作業。自分の状態は open / closed だけで、それ以外（着手済みか、ユーザー待ちか）は Run と Bench と Issue から導く。Issue と 1:1 で独自の番号を持たず、Issue の参照（`owner/repo#n`）で名指す。同じ Issue への再挑戦は Task の reopen で表す。
_Avoid_: work item, ticket

**Issue**:
GitHub Issue のローカルの写し（title、state、labels、parent、blocker）。body は写さない。Task が無くても存在できる（parent や Blocker として写しただけの issue）。open / closed は GitHub 側の事実で、Task の close とは独立。
_Avoid_: ExternalReference, external ref

**Blocker**:
Task の Issue を block している Issue。open な Blocker が 1 つでもあると、その Task では新しい Run を始められない。

**Pull Request**:
GitHub の Pull Request のローカルの写し（title、state、draft、head branch）。Task との対応は保存した事実ではなく、branch 名の一致か GitHub 上の closing reference から sync のたびに導いて記録したもの。手で繋ぐ操作は無い。
_Avoid_: PR ref, external ref

**Repo**:
`owner/repo` で識別する GitHub のリポジトリ。ローカルの checkout は ghq のレイアウトから一意に決まるので、登録や設定の実体を持たない。
_Avoid_: Project, repository

**Run**:
Task の上で動いた Agent Session 1 回分の対応。Bench の Tab で Agent Session が始まった時か Attach した時に生まれ、その Agent Session が終わるまで、Tab がどこに移っても Task に属し続ける。状態は持たず、agent の状態は Agent Session から導く。Run どうしに主従は無い。
_Avoid_: TaskRun, Main Run, primary run, side run

**Bench**:
Task が 1 つ所有する Runspace。最初に開いた時に作られ、cwd（worktree か Repo の checkout か）はその後変えない。Task を close すると壊れ、reopen すると作り直す。Workbench（画面）とは別物。
_Avoid_: task runspace, bench runspace

**Attach**:
既にある Tab を Bench に移すこと。その Tab の Agent Session はその時点で Task の Run になる。

### Workbench

**Workbench**:
端末を扱う desktop の画面。Runspace を並べ、各 Runspace の Tab を表示する。
_Avoid_: Work Bench, terminal view

**Runspace**:
Workbench のサイドバーの 1 項目。cwd と環境変数を共有する Tab の束。
_Avoid_: workspace

**Tab**:
Runspace 内の 1 枚の端末画面。閉じても Terminal Session は止まらず detach されるだけ。

**Terminal Session**:
ptyd が持つ 1 つの PTY。app より長生きし、再 attach すると transcript を replay する。
_Avoid_: session（Agent Session と紛れる）

**Agent Session**:
Tab の中で動く agent が自分で名乗るセッション。同一性は agent の session_id で、resume と compact は同じ Agent Session の再開、fork は別の Agent Session。Terminal Session とは別物で、同じ Tab に両方が存在する。agent の状態（動作中 / ユーザー待ちとその理由 / 終了）の唯一の正本で、Task に紐づかない Tab でも観測する。
_Avoid_: session, agent status on Terminal Session

### Process

**Shell**:
Tauri の殻。窓と端末の中継と Backend の起動・監督だけを持ち、Task も Backend の中身も知らない。
_Avoid_: Rust 側, Tauri 側

**Backend**:
Shell が起動し、desktop と同寿命の process。Task と Workbench の帳簿と DB を唯一所有し、webview と CLI は HTTP で呼ぶ。desktop が閉じている間は存在しない。
_Avoid_: server, sidecar, tania-backend

**ptyd**:
Terminal Session を管理する常駐 daemon。desktop より長生きし、socket 越しに使う。

### Skill

**Skill**:
agent に渡す手順書。`tania` の command を呼ぶことでだけ tania に触り、どの repo で動く agent にも配る。tania repo 自身を開発するための手順書は Skill に含めない。
_Avoid_: 製品 skill、plugin skill
