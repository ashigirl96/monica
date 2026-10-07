# tania

私と AI エージェントが一緒に仕事を進めるための個人用 Agentic Workspace。monica の後継で、端末（Workbench・Terminal Session・ptyd）と Note を引き継ぎ、Task を作り直す。

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
GitHub の Pull Request のローカルの写し（title、state、draft、head の branch と commit）。Task との対応は保存した事実ではなく、branch 名の一致か GitHub 上の closing reference から sync のたびに導いて記録したもの。手で繋ぐ操作は無い。
_Avoid_: PR ref, external ref

**Sync**:
GitHub から Issue と Pull Request の写しを引き直すこと。対象は open な Task の Issue と、その parent・Blocker・Pull Request まで。Pull Request と Task の対応もこのときに導き直す。closed な Task の写しは close した時点のまま残り、reopen で引き直す。
_Avoid_: refresh, fetch, 取り込み（track と紛れる）

**Repo**:
`owner/repo` で識別する GitHub のリポジトリ。ローカルの checkout は ghq のレイアウトから一意に決まるので、登録や設定の実体を持たない。
_Avoid_: Project, repository

**Run**:
Task の上で動いた Agent Session 1 回分の対応。Bench の Tab にいる live な Agent Session は、どの Run でもなければその Bench の Task の Run になる（Bench の Tab で始まった時も、Tab を Bench に移した時も）。その Agent Session が終わるまで、Tab がどこに移っても Task に属し続ける。状態は持たず、agent の状態は Agent Session から導く。Run どうしに主従は無い。
_Avoid_: TaskRun, Main Run, primary run, side run

**Bench**:
Task が 1 つ所有する Runspace。最初に開いた時か、Bench の無い Task に Attach した時に作られ、cwd（worktree か Repo の checkout か）はその後変えない。Workbench で最後の Tab を閉じると Task を close する。close の guard で止まったときと、Tab を外へ移したときは、Tab が無くても残る。Task を close すると壊れ（close を呼んだ Tab だけは普通の Runspace に残る）、reopen すると作り直す。Workbench（画面）とは別物。
_Avoid_: task runspace, bench runspace

**Attach**:
既にある Tab を Bench に移すこと。CLI でも picker でも、Tab を Bench へ drag しても同じ。その Tab の live な Agent Session がどの Run でもなければ、その時点で Task の Run になる。既に別の Task の Run なら、CLI と picker の Attach は断る。

**表示状態**:
Task で次に手を動かすのが誰か（私か、agent か、setup script か、誰でもないか）を、Run の Agent Session と Bench と Issue から導いた 1 語。保存しない。closed、ユーザー待ち・未観測・動作中（live な Run の Agent Session から）、片付け待ち（Issue は閉じたが Task は開いている）、未着手（Bench が無い）、準備中・準備失敗（Bench の準備）、終了（Bench はあるが live な Run が無い）のどれか。
_Avoid_: DisplayStatus, status, Task の状態（Task 自身の状態は open / closed だけ）

### Workbench

**Workbench**:
端末を扱う desktop の画面。Runspace を並べ、各 Runspace の Tab を表示する。
_Avoid_: Work Bench, terminal view

**Runspace**:
Workbench のサイドバーの 1 項目。新しい Tab が開く cwd を共有する Tab の束。環境変数は持たない。Bench 以外は常に Tab を 1 つ以上持ち、最後の Tab を閉じるか外へ移すと消える。一番左の Tab の cwd が Repo の checkout か worktree の中にあれば、その Repo を Runspace の Repo と呼ぶ（Bench は Task の Repo）。どの Repo にも属さない Runspace は Repo の外にある。
_Avoid_: workspace

**Tile**:
Workbench の sidebar の左端の列（Rail）に並ぶ、Repo 1 つか Repo の外を表すボタン。選ぶと、その Repo の Runspace（Repo の外の Tile なら Repo の外の Runspace）を右の一覧に出す。pin された Tab を持つ Runspace はどの Tile にも入らない。
_Avoid_: Rail（Tile を並べた列の語）, 札

**Tab**:
Runspace 内の 1 枚の端末画面で、1 つの Terminal Session を表示する。Tab を閉じる（Close Tab）とその Terminal Session も終了し、shell が終わると Tab も閉じる（pin された Tab を除く）。
_Avoid_: close（単独では Task の close と紛れる）, Terminate, detach

**Pin**:
Tab を常駐させる印。pin された Tab は閉じられず、その Terminal Session も終了させられず、shell が終わると新しい Terminal Session で張り直される（起動してすぐ終わった時は張り直さない）。pin された Tab は 1 つの Runspace に 1 つまでで、同じ Runspace の別の Tab を pin すると付け替わる。pin された Tab の無い Runspace（Bench を除く）にほかの Tab があれば、pin した Tab を新しい Runspace に切り出す。pin を外しても元の Runspace には戻らない。別の Runspace へ移すと外れる。Bench の Tab も pin できるが、Task を close すると他の Tab と同じく消える。
_Avoid_: 固定, pinned runspace（印は Tab に付く）

**Terminal Session**:
ptyd が持つ 1 つの PTY。app より長生きし、再 attach すると Terminal Session Transcript を replay する。生きている Terminal Session は必ず 1 つの Tab が表示している。
_Avoid_: session（Agent Session と紛れる）, detached（Tab の無い Terminal Session は残さない）

**Terminal Session Transcript**:
ptyd が Terminal Session の出力をそのまま書き残したもの。直近の分だけを持ち、再 attach ではその末尾を replay する。Terminal Session が終わると消える。
_Avoid_: Transcript（単独で使わない）, log（ptyd の診断の log と紛れる）, scrollback（xterm の語）

**Agent Session**:
Tab の中で動く agent が自分で名乗るセッション。同一性は agent の session_id で、resume と compact は同じ Agent Session の再開、fork は別の Agent Session。Terminal Session とは別物で、同じ Tab に両方が存在する。agent の状態の唯一の正本で、Task に紐づかない Tab でも観測する。状態は次の 4 つ。動作中とユーザー待ちには agent 自身の報告でだけ入る。終了には Terminal Session の終わりでも入り、未観測には Backend の不在でだけ入る。

- **動作中**: agent が turn を進めているか、自分で起こした background の agent の仕事が終わるのを待っている（終われば agent が自分で次の turn を始める）。
- **ユーザー待ち**: agent がユーザーの行動を待っている。理由は 4 つ。**手空き**（次の指示を待っている。起動直後と、turn が終わって background の agent の仕事も残っていない時）、**質問**（agent が訊いている）、**許可**（tool の実行許可を求めている。subagent の分とプラン承認も含む）、**エラー**（API エラーで turn が終わった）。
- **終了**: agent のプロセスが居ない。同じ Agent Session を resume すれば動作を再開できるので、終わりではなく「今は動いていない」。
- **未観測**: Backend が居ない間に動作中だった Agent Session の、次の報告が届くまでの状態。Terminal Session は生きているが、動作中か手空きかが分からない。

1 つの Terminal Session で live な（終了でない）Agent Session は 1 つだけ。
_Avoid_: session, agent status on Terminal Session, stopped（手空きと終了が紛れる）, plan 待ち（許可の一種）

**Agent Session の title**:
agent が Agent Session の会話に付ける短い名前。claude は Tab の title に出し、Agent Session Transcript にも残す。会話が進むと付け直され、短い会話には付かない。同じ repo で開いた複数の Tab のうち、どれの待ちかを通知で見分けるのに使う。
_Avoid_: Tab の title（shell や claude 以外の program も出す、Tab の帯の表示）, session 名

**Agent Session Transcript**:
agent が Agent Session の会話を書き残したもの。agent が書き、tania は読むだけ。claude は hook の payload の `transcript_path` でその file の path を渡す。Agent Session の title はここから読む。
_Avoid_: Transcript（単独で使わない）, 会話ログ

**通知**:
Agent Session がユーザー待ちに入ったことを知らせる macOS の通知。質問とエラーはその理由の待ちに入るたびに出し、許可は許可を求められるたびに出し（許可待ちの間に次の許可を求められても出す）、手空きは turn が終わった時だけ出す。claude の起動や resume の直後の手空きでは出さない。Task に属する Agent Session は Task の Issue の参照と title で、それ以外は agent の cwd で呼ぶ。本文は待ちの理由に Agent Session の title を添え、title が無ければ理由だけにする。desktop が動いている間だけ出し、待ちが解けても取り下げない。クリックすると、出した時に Agent Session が居た Terminal Session を表示している Tab を選ぶ。その Tab が無ければ desktop を前面に出すだけになる。
_Avoid_: 待ち通知, alert

**未読**:
通知を出した Agent Session の待ちを、私がまだ見ていないこと。見たとは、desktop の窓が前面にあり、Workbench がその Agent Session の Tab を表示したこと。見るか、待ちが解ける（動作中か終了になる）と未読でなくなる。同じ待ちの間に通知が何度出ても、1 つの Agent Session の未読は 1 つと数える。
_Avoid_: 未観測（Backend の不在の語）, unseen, 未確認

### Job

**Job**:
予定で繰り返し走る処理。tania が持つ system の Job（Sync など）と、ユーザーが登録して shell command を走らせる Job がある。Backend が動いている間だけ走り、予定の時刻に Backend が居なければその回は飛ばす。一度きりの裏の処理（Bench の準備など）は Job ではない。
_Avoid_: cron（claude の session cron と紛れる）, routine, schedule

**Job Execution**:
Job の 1 回分。起こしてから終わるまでと、その結果（成功・失敗・timeout・中断）を指す。
_Avoid_: Execution（単独で使わない）, Job Run, Run（Task の語）, tick, 発火

### Note

**Note**:
本文を持つ 1 枚の文書。Daily・Essay・Repo Note・Scratch のどれか 1 つの種類に属し、種類も作った時点の Logical Date も後から変えない。削除すると一覧と Note Mention の候補から消え、その Note を指す Note Mention と Synced Block には削除されたと出る。削除した画面にいる間は取り消せる。
_Avoid_: memo, journal, page, document, ノート

**Daily**:
Logical Date ごとに 1 つある Note。title を持たず、日付で名指す。開いた時に作られ、削除できない。未来の日付の Daily も作れる。
_Avoid_: 日記, journal

**Essay**:
title を持ち、どの Repo にも属さない Note。状態は、書いている間の `writing` と書き終えた `finished` の 2 つ。

**Repo Note**:
Repo に属し、title を持つ Note。1 つの話題について書く。
_Avoid_: project note

**Scratch**:
Repo ごとに 1 つある、長く追記していく書き殴りの Note。title を持たず、Repo で名指す。開いた時に作られ、削除できない。
_Avoid_: primary note, pinned note（Pin は Tab の語）

**Logical Date**:
5 時を境目にした日付。0 時から 5 時までは前の日に数える。
_Avoid_: 論理日付, 日付（単独で使うと暦の日付と紛れる）

**画像**:
Note の本文に貼る画像。Note とは別に置き、本文から参照する。どの Note の本文からも参照されていない画像は、置いてから 2 日を過ぎると消える。削除した Note の本文からの参照も数える。
_Avoid_: asset, attachment

**Note Mention**:
本文の文中に置き、Note を名指す印。参照先の今の名前（title・Logical Date・Repo）で表示する。
_Avoid_: Mention（単独で使わない）, wiki link, Note Link, backlink

**Synced Block**:
ある Note の block の並びを、別の場所に読み取り専用で映す block。映した側は元の今の中身を表示し、編集は元の Note でだけ行う。同じ Note の block も映せる。元の block が消えると、消えたと出る。
_Avoid_: transclusion, mirror, embed

### Process

**Shell**:
Tauri の殻。窓、端末の中継、Backend の起動・監督と、OS への窓口（通知を出し、押された通知を Workbench に渡す、Dock に未読の数を出す、画像をクリップボードに置く、クリップボードからファイルの path を読む、URL を開く）だけを持ち、Task も Backend の中身も知らない。
_Avoid_: Rust 側, Tauri 側

**Backend**:
Shell が起動し、desktop と同寿命の process。Task Ledger と Workbench Ledger と Job Ledger と Note Ledger と DB を唯一所有し、webview と CLI とブラウザは HTTP で呼ぶ。desktop が閉じている間は存在しない。
_Avoid_: server, sidecar, tania-backend

**Task Ledger**:
Backend に 1 つだけある、Task・Issue・Pull Request・Run・Bench の記録の全体。1 件の Task ではない。
_Avoid_: 帳簿, books

**Workbench Ledger**:
Backend に 1 つだけある、Runspace・Tab・Pin・Terminal Session・Agent Session の記録の全体。Workbench（画面）ではない。
_Avoid_: 帳簿, books

**Job Ledger**:
Backend に 1 つだけある、Job と Job Execution の記録の全体。1 つの Job ではない。
_Avoid_: scheduler, 帳簿

**Note Ledger**:
Backend に 1 つだけある、Note と画像の記録の全体。1 件の Note ではない。
_Avoid_: 帳簿

**ptyd**:
Terminal Session を管理する常駐 daemon。Backend が起動し、desktop より長生きする。socket 越しに使う。

### Skill

**Skill**:
agent に渡す手順書。`tania` の command を呼ぶことでだけ tania に触り、どの repo で動く agent にも配る。tania repo 自身を開発するための手順書は Skill に含めない。
_Avoid_: 製品 skill、plugin skill
