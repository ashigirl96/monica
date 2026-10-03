# tania

私と AI エージェントが一緒に仕事を進めるための個人用 Agentic Workspace。monica の後継で、Workbench（端末）を引き継ぎ、Task を作り直す。

## Language

### Task

**Task**:
1 つの Issue に対する私の作業。自分の状態は open / closed だけで、それ以外（着手済みか、ユーザー待ちか）は表示状態として Run と Bench と Issue から導く。Issue と 1:1 で独自の番号を持たず、Issue の参照（`owner/repo#n`）で名指す。同じ Issue への再挑戦は Task の reopen で表す。
_Avoid_: work item, ticket

**Issue**:
GitHub Issue のローカルの写し（title、state、labels、parent、blocker）。body は写さない。Task が無くても存在できる（parent や Blocker として写しただけの issue）。open / closed は GitHub 側の事実で、Task の close とは独立。
_Avoid_: ExternalReference, external ref

**Blocker**:
Task の Issue を block している Issue。open な Blocker が 1 つでもあると、その Task では新しい Run を始められない。

**Pull Request**:
GitHub の Pull Request のローカルの写し（title、state、draft、head branch）。Task との対応は保存した事実ではなく、branch 名の一致か GitHub 上の closing reference から sync のたびに導いて記録したもの。手で繋ぐ操作は無い。
_Avoid_: PR ref, external ref

**Sync**:
GitHub から Issue と Pull Request の写しを引き直すこと。対象は open な Task の Issue と、その parent・Blocker・Pull Request まで。Pull Request と Task の対応もこのときに導き直す。closed な Task の写しは close した時点のまま残り、reopen で引き直す。
_Avoid_: refresh, fetch, 取り込み（track と紛れる）

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

**表示状態**:
Task で次に手を動かすのが誰か（私か、agent か、setup script か、誰でもないか）を、Run の Agent Session と Bench と Issue から導いた 1 語。保存しない。closed、ユーザー待ち・未観測・動作中（live な Run の Agent Session から）、片付け待ち（Issue は閉じたが Task は開いている）、未着手（Bench が無い）、準備中・準備失敗（Bench の準備）、終了（Bench はあるが live な Run が無い）のどれか。
_Avoid_: DisplayStatus, status, Task の状態（Task 自身の状態は open / closed だけ）

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
ptyd が持つ 1 つの PTY。app より長生きし、再 attach すると transcript を replay する。どの Tab も表示していない生きている Terminal Session を detached と呼び、Tab で開き直す（reattach）か終了させるまで残る。
_Avoid_: session（Agent Session と紛れる）

**Agent Session**:
Tab の中で動く agent が自分で名乗るセッション。同一性は agent の session_id で、resume と compact は同じ Agent Session の再開、fork は別の Agent Session。Terminal Session とは別物で、同じ Tab に両方が存在する。agent の状態の唯一の正本で、Task に紐づかない Tab でも観測する。状態は次の 4 つで、agent 自身の報告だけで遷移する。

- **動作中**: agent が turn を進めている。
- **ユーザー待ち**: agent がユーザーの行動を待っている。理由は 4 つ。**手空き**（次の指示を待っている。起動直後と turn 完了後）、**質問**（agent が訊いている）、**許可**（tool の実行許可を求めている。プラン承認もこれ）、**エラー**（API エラーで turn が終わった）。
- **終了**: agent のプロセスが居ない。同じ Agent Session を resume すれば動作を再開できるので、終わりではなく「今は動いていない」。
- **未観測**: Backend が居ない間に動作中だった Agent Session の、次の報告が届くまでの状態。Terminal Session は生きているが、動作中か手空きかが分からない。

1 つの Terminal Session で live な（終了でない）Agent Session は 1 つだけ。
_Avoid_: session, agent status on Terminal Session, stopped（手空きと終了が紛れる）, plan 待ち（許可の一種）

### Process

**Shell**:
Tauri の殻。窓と端末の中継と Backend の起動・監督だけを持ち、Task も Backend の中身も知らない。
_Avoid_: Rust 側, Tauri 側

**Backend**:
Shell が起動し、desktop と同寿命の process。Task と Workbench の帳簿と DB を唯一所有し、webview と CLI は HTTP で呼ぶ。desktop が閉じている間は存在しない。
_Avoid_: server, sidecar, tania-backend

**ptyd**:
Terminal Session を管理する常駐 daemon。Backend が起動し、desktop より長生きする。socket 越しに使う。

### Skill

**Skill**:
agent に渡す手順書。`tania` の command を呼ぶことでだけ tania に触り、どの repo で動く agent にも配る。tania repo 自身を開発するための手順書は Skill に含めない。
_Avoid_: 製品 skill、plugin skill
