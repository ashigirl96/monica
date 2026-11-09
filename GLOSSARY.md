# monica

私と AI エージェントが一緒に仕事を進めるための個人用 Agentic Workspace。旧 Monica の後継で、端末（Workbench・Terminal Session・ptyd）と Note を引き継ぎ、Task を作り直す。

## Language

### Task

**Task（作業）**:
1 つの Issue に対する私の作業。自分の状態は open / closed だけで、それ以外（着手済みか、Waiting か）は Display State として Run と Bench と Issue から導く。Issue と 1:1 で独自の番号を持たず、Issue の参照（`owner/repo#n`）で名指す。同じ Issue への再挑戦は Task の reopen で表す。
_Avoid_: work item, ticket

**Issue（課題）**:
GitHub Issue のローカルの写し（title、state、labels、sub-issue の数、parent、blocker）。body は写さない。Task が無くても存在できる（parent や Blocker として写しただけの issue）。open / closed は GitHub 側の事実で、Task の close とは独立。
_Avoid_: ExternalReference, external ref

**Blocker（妨げ）**:
Task の Issue を block している Issue。open な Blocker が 1 つでもあると、その Task では新しい Run を始められない。

**Issue Facts（課題の事実）**:
Run を起こすか、どう起こすか、Run Button に何を出すかを決めるときに当てる Issue の事実。Issue の state・labels・sub-issue の数、parent の labels と sub-issue の数、open な Blocker から成る。Issue の写しから取るか、GitHub から今読んだ答えから取り、手元で最も新しいほうを使う。どちらが新しいかは時刻ではなく、Sync が通ったかで決める。
_Avoid_: Issue Snapshot（Page Snapshot と紛れる）, Issue State（Issue の open / closed と紛れる）, 写し（Issue Facts は写しからも読んだ答えからも取る）

**Pull Request（変更の提案）**:
GitHub の Pull Request のローカルの写し（title、state、draft、head の branch と commit）。Task との対応は保存した事実ではなく、branch 名の一致か GitHub 上の closing reference から sync のたびに導いて記録したもの。手で繋ぐ操作は無い。
_Avoid_: PR ref, external ref

**Sync（引き直し）**:
GitHub から Issue と Pull Request の写しを引き直すこと。対象は open な Task の Issue と、その parent・Blocker・Pull Request まで。Pull Request と Task の対応もこのときに導き直す。closed な Task の写しは close した時点のまま残り、reopen で引き直す。
_Avoid_: refresh, fetch, 取り込み（track と紛れる）

**Repo（リポ）**:
`owner/repo` で識別する GitHub のリポジトリ。ローカルの checkout は ghq のレイアウトから一意に決まるので、登録や設定の実体を持たない。
_Avoid_: Project, repository

**Run（実行）**:
Task の上で動いた Agent Session 1 回分の対応。Bench の Tab にいる live な Agent Session は、どの Run でもなければその Bench の Task の Run になる（Bench の Tab で始まった時も、Tab を Bench に移した時も）。その Agent Session が終わるまで、Tab がどこに移っても Task に属し続ける。状態は持たず、agent の状態は Agent Session から導く。Run どうしに主従は無い。
_Avoid_: TaskRun, Main Run, primary run, side run

**Active Run（稼働中の実行）**:
live な Run（Agent Session が Ended でない Run）のうち、Agent Session が Terminating な Terminal Session にいないもの。強制でない Task の close を止める。Display State と Run Button は Terminating な Terminal Session にいる Run も live と読むので、live な Run は Active Run より広い。
_Avoid_: live な Run（Terminating な Terminal Session にいる Run も含む）

**Run Launch（実行の起動）**:
Run を起こすために claude の Tab を開いてから、その Tab の Agent Session が Run になるまでの間。1 つの Task に 1 つまでで、その Tab が無くなるか、しばらく Run にならなければ外れる。この間、Run Button は `Running` を出し、同じ Task への 2 本目の Run と強制でない Task の close を断る。まだ Run ではないので、Display State には現れない。
_Avoid_: launch（単独で使わない）, 起動中の Run（まだ Run ではない）

**Bench（作業台）**:
Task が 1 つ所有する Runspace。最初に開いた時か、Bench の無い Task に Attach した時に作られ、cwd（worktree か Repo の checkout か）はその後変えない。Workbench で最後の Tab を閉じるか、Jump Mode で Tab ごと消すと Task を close する。close の guard で止まったときと、Tab を外へ移したときは、Tab が無くても残る。guard で止まった Bench は、Workbench で止めた理由と、2 度押して強制で close する「Close anyway」を出す。止めた理由の無い Tab の無い Bench は、1 度押して強制でない close をやり直す「Close」を出す。Task を close すると壊れ（close を呼んだ Tab と、強制でない close の間にその Task の Run になった Tab だけは普通の Runspace に残る）、reopen すると作り直す。呼び手が自分の Tab も消すよう頼んだ close では、呼んだ Tab も残らない。Workbench（画面）とは別物。
_Avoid_: task runspace, bench runspace

**Attach（取り付け）**:
既にある Tab を Bench に移すこと。CLI と Tab のメニューの picker で行う。CLI は未 track の Issue を track してから移す。その Tab の live な Agent Session がどの Run でもなければ、その時点で Task の Run になる。既に別の Task の Run なら、CLI と picker の Attach は断る。

**Display State（表示状態）**:
Task で次に手を動かすのが誰か（私か、agent か、setup script か、誰でもないか）を、Run の Agent Session と Bench と Issue から導いた 1 語。保存しない。`closed`、`waiting`・`unobserved`・`running`（live な Run の Agent Session の Waiting・Unobserved・Running から）、`issue_closed`（片付け待ち。Issue は閉じたが Task は開いている）、`not_started`（未着手。Bench が無い）、`preparing`・`setup_failed`（準備中・準備失敗。Bench の準備）、`ended`（終了。Bench はあるが live な Run が無い）のどれか。
_Avoid_: DisplayStatus, status, Task の状態（Task 自身の状態は open / closed だけ）

### Workbench

**Workbench（作業場）**:
端末を扱う desktop の画面。Runspace を並べ、各 Runspace の Tab を表示する。
_Avoid_: Work Bench, terminal view

**Runspace（実行区画）**:
Workbench のサイドバーの 1 項目。新しい Tab が開く cwd を共有する Tab の束。環境変数は持たない。Bench 以外は常に Tab を 1 つ以上持ち、最後の Tab を閉じるか外へ移すと消える。一番左の Tab の cwd が Repo の checkout か worktree の中にあれば、その Repo を Runspace の Repo と呼ぶ（Bench は Task の Repo）。どの Repo にも属さない Runspace は Repo の外にある。
_Avoid_: workspace

**Tile（タイル）**:
Workbench の sidebar の左端の列（Rail）に並ぶ、Repo 1 つか Repo の外を表すボタン。選ぶと、その Repo の Runspace（Repo の外の Tile なら Repo の外の Runspace）を右の一覧に出す。pin された Tab を持つ Runspace はどの Tile にも入らない。
_Avoid_: Rail（Tile を並べた列の語）, 札

**Tab（端末画面）**:
Runspace 内の 1 枚の端末画面で、1 つの Terminal Session を表示する。Tab を閉じる（Close Tab）とその Terminal Session も終了し、shell が自分で終わると Tab も閉じる（pin された Tab を除く）。desktop が閉じている間や表示していない間に終わった shell も同じ。shell が起動できなかったときと、ptyd を失って Terminal Session が消えたときは閉じず、新しい shell を張り直すか閉じるかを私が選ぶ。
_Avoid_: close（単独では Task の close と紛れる）, Terminate, detach

**Pin（常駐の印）**:
Tab を常駐させる印。pin された Tab は閉じられず、その Terminal Session も終了させられず、shell が終わると新しい Terminal Session で張り直される（起動してすぐ終わった時は張り直さない）。pin された Tab は 1 つの Runspace に 1 つまでで、同じ Runspace の別の Tab を pin すると付け替わる。pin された Tab の無い Runspace（Bench を除く）にほかの Tab があれば、pin した Tab を新しい Runspace に切り出す。pin を外しても元の Runspace には戻らない。別の Runspace へ移すと外れる。Bench の Tab も pin できるが、Task を close すると他の Tab と同じく消える。
_Avoid_: 固定, pinned runspace（印は Tab に付く）

**Layout（画面の構成）**:
Workbench Ledger のうち、Runspace の並び、各 Runspace の Tab の並び、Pin、各 Tab が表示する Terminal Session を合わせたもの。Terminal Session と Agent Session の状態は含まない。
_Avoid_: 配置, 並び（単独で使わない）, arrangement

**Jump Mode（番号選択モード）**:
Workbench で、sidebar に見えている Runspace と、active な Runspace の Tab に番号を出し、番号で選ぶ間の状態。この間は Tab を閉じる・新しく開く・並べ替えることと、active な Runspace を Tab ごと消すこともできる。Bench を消すときは、Tab をすべて閉じてから強制でない Task の close を呼ぶ。pin された Tab のある Runspace は消さない。閉じる・消す操作は、live な Agent Session がいても 1 度で行う。選ぶか、表示する Tab が替わるか、Workbench をクリックするか、取り消すと抜ける。
_Avoid_: jump hint モード, ジャンプ, hint mode

**Terminal Session（疑似端末）**:
ptyd が持つ 1 つの PTY。app より長生きし、再 attach すると Terminal Session Transcript を replay する。生きている Terminal Session は、Terminating なものを除いて必ず 1 つの Tab が表示している。
_Avoid_: session（Agent Session と紛れる）, detached（Tab の無い Terminal Session は残さない）

**Terminating（終了待ち）**:
Tab を閉じた後、終わるのを待っている Terminal Session。Tab が無くなった時点でそうなる。Task の close は、Terminating な Terminal Session にいる Agent Session の Run を、close を止める理由に数えない。Agent Session の状態は変えないので、Display State と Run Button はその Run を終わるまで live と読む。
_Avoid_: 終わりかけ, detached（廃止した Detached と紛れる）, orphan（まだ Run でない Agent Session と紛れる）, ending（Agent Session の Ended と紛れる）

**Terminal Session Process（疑似端末のプロセス）**:
1 つの Terminal Session に属する process。session id がその Terminal Session の shell の pid と同じもので、shell から起こした job と、nohup で起こした process が入る。setsid で自分の session を作った process は、shell の子孫でも入らない。Terminal Session が終わると、残ったものは ptyd が止める。
_Avoid_: Tab の process（process を持つのは Terminal Session）, 子 process（shell の子孫のうち、setsid で抜けたものは入らない）

**Terminal Session Transcript（疑似端末の出力記録）**:
ptyd が Terminal Session の出力をそのまま書き残したもの。直近の分だけを持ち、再 attach ではその末尾を replay する。Terminal Session が終わると消える。
_Avoid_: Transcript（単独で使わない）, log（ptyd の診断の log と紛れる）, scrollback（xterm の語）

**Tab Connection（端末画面の接続）**:
Tab が、表示する Terminal Session の出力を受け、入力を送る経路。繋ぐとまず Terminal Session Transcript の末尾を replay し、その後に流れてくる出力へ切れ目なく続ける。Tab が Layout から消えると切れる。1 つの Tab に Tab Connection は 1 つまで。
_Avoid_: connection, session（Terminal Session と Agent Session と紛れる）, attach（繋ぐ手順の 1 歩の語）

**Agent Session（エージェントの会話）**:
Tab の中で動く agent が自分で名乗るセッション。同一性は agent の session_id で、resume と compact は同じ Agent Session の再開、fork は別の Agent Session。Terminal Session とは別物で、同じ Tab に両方が存在する。Tab の中の agent の状態の唯一の正本で、Task に紐づかない Tab でも観測する。状態は次の 4 つ。Running と Waiting には agent 自身の報告でだけ入る。Ended には Terminal Session の終わりでも入り、Unobserved には Backend の不在でだけ入る。

- **Running（動作中）**: agent が turn を進めているか、自分で起こした background の agent の仕事が終わるのを待っている（終われば agent が自分で次の turn を始める）。
- **Waiting（ユーザー待ち）**: agent がユーザーの行動を待っている。理由は 4 つ。**Idle（手空き）**（次の指示を待っている。起動直後と、turn が終わって background の agent の仕事も残っていない時）、**Question（質問）**（agent が訊いている）、**Permission（許可）**（tool の実行許可を求めている。subagent の分とプラン承認も含む）、**Error（失敗）**（API エラーで turn が終わった）。
- **Ended（終了）**: agent のプロセスが居ない。同じ Agent Session を resume すれば動作を再開できるので、終わりではなく「今は動いていない」。
- **Unobserved（未観測）**: Backend が居ない間に Running だった Agent Session の、次の報告が届くまでの状態。Terminal Session は生きているが、Running か Idle かが分からない。

1 つの Terminal Session で live な（Ended でない）Agent Session は 1 つだけ。
_Avoid_: session, agent status on Terminal Session, stopped（Idle と Ended が紛れる）, plan 待ち（Permission の一種）

**Agent Session Title（会話の題）**:
agent が Agent Session の会話に付ける短い名前。claude は Tab の title に出し、Agent Session Transcript にも残す。会話が進むと付け直され、短い会話には付かない。同じ repo で開いた複数の Tab のうち、どれの待ちかを Notification で見分けるのに使う。
_Avoid_: Tab の title（shell や claude 以外の program も出す、Tab の帯の表示）, session 名

**Agent Session Transcript（会話の記録）**:
agent が Agent Session の会話を書き残したもの。agent が書き、monica は読むだけ。claude は hook の payload の `transcript_path` でその file の path を渡す。Agent Session Title はここから読む。
_Avoid_: Transcript（単独で使わない）, 会話ログ

**Notification（通知）**:
Agent Session が Waiting に入ったことを知らせる macOS の通知。Question と Error はその理由の待ちに入るたびに出し、Permission は許可を求められるたびに出し（Permission の待ちの間に次の許可を求められても出す）、Idle は turn が終わった時だけ出す。claude の起動や resume の直後の Idle では出さない。Task に属する Agent Session は Task の Issue の参照と Agent Session Title で、それ以外は agent の cwd で呼ぶ。本文は待ちの理由に Agent Session Title を添え、Agent Session Title が無ければ理由だけにする。desktop が動いている間だけ出す。同じ Terminal Session の Notification は新しい Notification で置き換え、その Agent Session が Unread でなくなると取り下げる。クリックすると、出した時に Agent Session が居た Terminal Session を表示している Tab を選ぶ。その Tab が無ければ desktop を前面に出すだけになる。
_Avoid_: 待ち通知, alert

**Unread（未読）**:
Notification を出した Agent Session の待ちを、私がまだ見ていないこと。見たとは、desktop の窓が前面にあり、Workbench がその Agent Session の Tab を表示したこと。通知センターで Notification を消しても、見たことにはならない。見るか、待ちが解ける（Running か Ended になる）と Unread でなくなる。同じ待ちの間に Notification が何度出ても、1 つの Agent Session の Unread は 1 つと数える。
_Avoid_: 未観測（Unobserved の語）, unseen, 未確認

### Job

**Job（定期処理）**:
予定で繰り返し走る処理。monica が持つ system の Job（Sync など）と、ユーザーが登録して shell command を走らせる Job がある。Backend が動いている間だけ走り、予定の時刻に Backend が居なければその回は飛ばす。一度きりの裏の処理（Bench の準備など）は Job ではない。
_Avoid_: cron（claude の session cron と紛れる）, routine, schedule

**Job Execution（定期処理の各回）**:
Job の 1 回分。起こしてから終わるまでと、その結果（成功・失敗・timeout・中断）を指す。
_Avoid_: Execution（単独で使わない）, Job Run, Run（Task の語）, tick, 発火

### Note

**Note（文書）**:
本文を持つ 1 枚の文書。Daily・Essay・Repo Note・Scratch・Pad のどれか 1 つの種類に属し、種類も作った時点の Logical Date も後から変えない。削除すると一覧と Note Mention の候補から消え、その Note を指す Note Mention と Synced Block には削除されたと出る。削除した画面にいる間は取り消せる。Essay の一覧と編集は合わせて 1 つの画面、Repo Note は Repo ごとに 1 つの画面、Pad は 1 つの画面と数える。
_Avoid_: memo, journal, page, document, ノート

**Open Note（開いている文書）**:
画面が書くために出している 1 枚の Note。1 つの画面に同時に 1 枚までで、別の Note へ移るか画面を離れると Open Note でなくなる。書いた分の保存、削除、最新の読み込み、Essay の状態の切り替えは、Open Note に対して行う。
_Avoid_: 今の Note, 選択中の Note（サイドバーの選択と紛れる）, 開いているページ（Current Page の語）

**Base Version（基準版）**:
Open Note の編集が重なっている、その Note の版。保存は Base Version がまだ最新のときだけ通り、外で先に書き換わっていれば Note Conflict になる。保存が通るか、最新を読み込むと進み、戻ることは無い。Note Conflict の間は進まない。
_Avoid_: base, 元の版, 最新版（Backend の最新とは限らない）

**Note Conflict（競合）**:
Open Note の保存が、外で先に書き換わった版に阻まれ、手元の編集が行き場を失った状態。同じ編集を送り直しても通らないので、自動では送り直さない。最新を読み込んで手元の編集を捨てるか、その Note を削除すると解ける。外で書き換えた側の変更は失われない。
_Avoid_: conflict（単独で使わない）, 衝突, 保存エラー（送り直せば通る失敗の語）

**Daily（日ごとの文書）**:
Logical Date ごとに 1 つある Note。title を持たず、日付で名指す。開いた時に作られ、削除できない。未来の日付の Daily も作れる。
_Avoid_: 日記, journal

**Essay（随筆）**:
title を持ち、どの Repo にも属さない Note。状態は、書いている間の `writing` と書き終えた `finished` の 2 つ。

**Repo Note（リポの文書）**:
Repo に属し、title を持つ Note。1 つの話題について書く。
_Avoid_: project note

**Scratch（書き殴り）**:
Repo ごとに 1 つある、長く追記していく書き殴りの Note。title を持たず、Repo で名指す。開いた時に作られ、削除できない。
_Avoid_: primary note, pinned note（Pin は Tab の語）

**Pad（雑記帳）**:
どの Repo にも Logical Date にも属さず、全体でちょうど 1 つある Note。日をまたいで書き足し、書き消しを続ける。title を持たず、Pad と名指す。開いた時に作られ、削除できない。Daily の画面から開くが、Daily には属さない。
_Avoid_: memo, inbox, global scratch, Repo の無い Scratch

**Star（星印）**:
Essay と Repo Note に付ける印。Star の付いた Note は、それが属する一覧の上に出る。Note を削除して取り消しても、Essay の状態を変えても残る。
_Avoid_: Pin（Tab の語）, Favorite, お気に入り

**Logical Date（論理日付）**:
5 時を境目にした日付。0 時から 5 時までは前の日に数える。
_Avoid_: 日付（単独で使うと暦の日付と紛れる）

**Image（画像）**:
Note の本文に貼る画像。Note とは別に置き、本文から参照する。どの Note の本文からも参照されていない Image は、置いてから 2 日を過ぎると消える。削除した Note の本文からの参照も数える。
_Avoid_: asset, attachment

**Note Mention（文書への言及）**:
本文の文中に置き、Note を名指す印。参照先の今の名前（title・Logical Date・Repo）で表示する。
_Avoid_: Mention（単独で使わない）, wiki link, Note Link, backlink

**Synced Block（同期ブロック）**:
ある Note の block の並びを、別の場所に読み取り専用で映す block。映した側は元の今の中身を表示し、編集は元の Note でだけ行う。同じ Note の block も映せる。元の block が消えると、消えたと出る。
_Avoid_: transclusion, mirror, embed

### Study

**Study（学習）**:
1 つの Mission について、agent を先生にして学ぶ一続きの取り組み。学んだことを使う Repo を紐付けると、その Repo から引ける。紐付けた Repo は学習対象とは別で、学習対象は Mission に書く。
_Avoid_: Learning Bench（Bench と紛れる）, Course（決まった順路を連想させる）, Lesson

**Tutor（先生）**:
学習対象の種類ごとにある、先生としての振る舞い（教え方と学習対象への近づき方）。Study の agent は、Mission と会話の流れに合う Tutor を選んで演じ、話が逸れれば別の Tutor に移り、複数を重ねることもある。どれも合わなければ、Tutor を使わずに共通の教え方だけで教える。例えばリポジトリの Tutor は、ツールやライブラリを入れて一緒に使ってみる。
_Avoid_: persona, agent（単独で使わない。Agent Session と紛れる）

**Mission（学ぶ理由）**:
Study ごとに 1 つある、何をなぜ学ぶかを書いた文。学習対象（リポジトリの URL など）もここに書く。複数の学習対象を比べる学びも 1 つの Mission にできる。
_Avoid_: goal

**Learning Record（学習記録）**:
Study の中で、ユーザーが何を分かったか、前から何を知っていたか、どの誤解が直ったか、学んだ結果 Mission がどう変わったかを、その証拠が出たときに 1〜3 文で残す記録。触れただけのことや毎回の活動は書かない。
_Avoid_: Note（Note と紛れる）, log（経過の記録と紛れる）

**Learning Preference（学び方の好み）**:
全 Study に効く、ユーザーの教わり方の好み（説明の長さ、クイズの出し方、手を動かす順など）。ユーザーが会話で好みを言うと agent が書き足し、ユーザーも直せる。ある Study だけの希望は Mission に書く。
_Avoid_: NOTES（teach の、学ぶ題ごとのメモと紛れる）, Setting（monica の設定と紛れる）

**Playground（試し場）**:
Study ごとにある、道具を入れて試す場所。Tutor が道具を選んで入れ、ユーザーも中に入って手を動かす。後でまとめて消せるように置き場所が決まっていて、3 ヶ月触らなかった Study の Playground は自動で消える。
_Avoid_: Sandbox（書き込みや通信を囲う仕組みと紛れる）, 隔離環境（囲われていると誤解される）

**Prototype（試作）**:
Study の中で、学習対象を確かめるために作るコード。Playground が消えても、作り直すための定義と一緒に残る。
_Avoid_: Demo

### Browser

**Browser Tab（ブラウザのタブ）**:
ブラウザの 1 枚のタブ。Workbench の Tab とは別物。
_Avoid_: タブ（単独で使うと Tab と紛れる）

**Current Page（前面のページ）**:
ある window で、active な Browser Tab に開いているページ。
_Avoid_: 今のページ, 開いているページ（どの Browser Tab のことか曖昧）

**Chat（問答）**:
Chrome Extension の side panel で agent と交わす一続きの問答。side panel を開いた window ごとに 1 つだけあり、質問はそれぞれ、質問した時の Current Page について訊く。新しい Chat を始めるか side panel を閉じると終わり、どこにも残らない。Backend が居ない間は答えが返らないが、Chat は終わらない。Tab の外で動くので Agent Session ではない。
_Avoid_: 会話（単独では Agent Session の会話と紛れる）, session, conversation, thread

**Page Snapshot（ページの控え）**:
質問を送った時に Current Page から読み取った、そのページの URL・title・本文・選択範囲と、添えたならスクリーンショット。質問 1 つに 1 つある。読めなかったときは、読めなかったことと、その理由を持つ。
_Avoid_: ページの情報, page context, capture（スクリーンショットの撮影と紛れる）

**Run Button（実行ボタン）**:
Chrome Extension が GitHub の Issues の一覧の行と Issue の画面の header に差し込む、その Issue の Task の Run を起こすボタン。Task が closed なら、Run の代わりに Task を reopen する。出すか、どの prompt で起こすか、押せない理由は、Backend が GitHub の今の Issue と Task Ledger から決める。状態は、新しい Run を起こす（`Run`）、Ended の Run を resume する（`Resume`）、live な Run があるか、Run Launch の間で押せない（`Running`）、closed な Task を reopen するだけで Run は起こさない（`Reopen`）、規則が断り押せない（closed な Issue や open な Blocker などの理由を tooltip に出す）のどれか。closed な Issue と open な Blocker が止めるのは新しい Run だけで、live な Run や Ended の Run があれば `Running` か `Resume` になる。押した時に Backend の決める状態が、画面に出ていた状態と違えば、何もせずに今の状態に描き直す。GitHub から読めなかった Issue には出さない。
_Avoid_: Run（単独ではボタンを指さない）, 押せない Run（押せない状態の Run Button）

**Backend Unreachable（バックエンドに届かない）**:
Chrome Extension の呼び出しが、Backend の答えを受け取る前に Backend に届かなくなったこと。desktop が動いていない、起き直した Backend が前の呼び出しの資格を受け付けない、答えの途中で切れた、のどれも含む。Backend が受け取ったうえで断るか失敗したことは含まない。Chat と Run Button は同じ判定で、desktop が動いていないと出す。
_Avoid_: offline, 接続エラー, Backend が居ない（不在の一部しか指さない）

### Process

**Shell（殻）**:
Tauri の殻。窓、端末の中継、Backend の起動・監督と、OS への窓口（Notification を出して取り下げ、押された Notification を Workbench に渡す、Dock に Unread の数を出す、画像をクリップボードに置く、クリップボードからファイルの path を読む、URL を開く）だけを持ち、Task も Backend の中身も知らない。
_Avoid_: Rust 側, Tauri 側

**Backend（バックエンド）**:
Shell が起動し、desktop と同寿命の process。Task Ledger と Workbench Ledger と Job Ledger と Note Ledger と DB を唯一所有し、webview と CLI と notes の画面と Chrome Extension は HTTP で呼ぶ。desktop が閉じている間は存在しない。
_Avoid_: server, sidecar, monica-backend

**Chrome Extension（ブラウザ拡張）**:
Brave に読み込む monica のブラウザ拡張。side panel を持ち、Backend を HTTP で呼ぶ。
_Avoid_: 拡張（単独で使わない）, plugin（Skill を配る Claude Code の plugin と紛れる）, アドオン

**Task Ledger（作業の台帳）**:
Backend に 1 つだけある、Task・Issue・Pull Request・Run・Bench の記録の全体。1 件の Task ではない。
_Avoid_: 帳簿, books

**Workbench Ledger（作業場の台帳）**:
Backend に 1 つだけある、Runspace・Tab・Pin・Terminal Session・Agent Session の記録の全体。Workbench（画面）ではない。
_Avoid_: 帳簿, books

**Job Ledger（定期処理の台帳）**:
Backend に 1 つだけある、Job と Job Execution の記録の全体。1 つの Job ではない。
_Avoid_: scheduler, 帳簿

**Note Ledger（文書の台帳）**:
Backend に 1 つだけある、Note と Image の記録の全体。1 件の Note ではない。
_Avoid_: 帳簿

**ptyd（端末の常駐プロセス）**:
Terminal Session を管理する常駐 daemon。Backend が起動し、desktop より長生きする。socket 越しに使う。

### Usage

**Feature（呼び出し名）**:
Backend が受ける呼び出しの名前 1 つ（`task.run` など）。CLI の command は、それが呼ぶ Feature と同じものとして数える。Backend を通らない操作（端末の入出力、Shell が OS に頼むこと、Job が Ledger を直接触ること）は Feature ではない。
_Avoid_: 機能（Job も Skill も機能と呼べて広すぎる）、endpoint、command

**Caller（呼び手）**:
Feature を呼んだ入口。webview、CLI、Chrome Extension、notes の画面の 4 つ。CLI を私が打ったか agent が打ったかは区別しない。
_Avoid_: client、source、呼び出し元

**Usage（呼び出し回数）**:
ある日にある Caller がある Feature を呼んだ回数を、成功と失敗に分けて残した記録。消してよい Feature を探す拠り所で、ログではない。呼ばれなかった Feature は 0 回として数える。
_Avoid_: metrics、telemetry、analytics、利用ログ

### Skill

**Skill（手順書）**:
agent に渡す手順書。どの repo で動く agent にも配る。monica に触るときは `monica` の command を通す。Upstream から写したものと、この repo で書いたものがある。monica repo 自身を開発するための手順書は Skill に含めない。
_Avoid_: 製品 skill、plugin skill

**Upstream（写し元）**:
Skill の写し元にする、他人が書いた skill の repo（mattpocock/skills など）。
_Avoid_: 本家、元 repo

**Upstream Update（写し元の反映）**:
Upstream の新しい版を、Upstream から写した Skill に反映すること。Upstream から初めて Skill を写すことも含む。Upstream が意図を満たした Skill Patch は外してその Skill Patch Note も消し、ほかの Skill Patch は残す。
_Avoid_: Sync（GitHub の写しを引き直すこと）、取り込み

**Skill Patch（手直し）**:
Upstream から写した Skill に、この repo でだけ加えた変更。1 つの Skill の中で、1 つの理由のために変えた箇所の束を 1 つと数え、同じ理由で複数の Skill を変えたら Skill ごとに別の Skill Patch になる。Upstream が同じ意図を満たすまで、Upstream Update の後も残る。
_Avoid_: 改変、override、customization

**Skill Patch Note（手直しの記録）**:
Skill Patch ごとに、何をなぜ変えたかを書いたもの。Upstream Update でその Skill Patch を当て直すか外すかを決める拠り所になる。
_Avoid_: 改変記録、changelog
