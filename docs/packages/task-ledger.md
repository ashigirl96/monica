# Task Ledger

`packages/task` の contract と写しの規則。table は #15、sync の契機は #18、表示状態は #17 の resolution にある。

## contract（root は `task`）

```
track       { ref } → { ref, title, alreadyTracked, closed }                                cli
sync        { ref? } → { synced, missing }                                                  cli
list        { closed? } → { tasks: ListItem[], backgroundSyncError: { at, message } | null }  cli
run         { ref, inPlace?, force? } → { ref, cwd, mode, benchCreated, warnings,               cli
              tabId, terminalSessionId, resumed }  errors: BLOCKED { blockers }
current     { terminalSessionId? } → { ref, title, displayState, agentSessionId, source }   cli
attach      { ref, terminalSessionId? } → { ref, title, benchCreated, runCreated,               cli
              agentSessionId }
close       { ref, force?, terminalSessionId? } → { ref, removedWorktree, deletedBranch,        cli
              spared, warnings }  errors: CLOSE_REFUSED { reasons }
reopen      { ref } → { ref, title, warnings }                                               cli
bench.list  → { runspaceId, ref, title, setupState }[]
changes     → { type: "task", ref } | { type: "synced" }
```

- ref は `owner/repo#n` と `https://github.com/owner/repo/issues/n`（後ろの `?…` と `#…` は捨てる）だけを受ける。CLI では位置引数にする（zod の `.meta({ positional: true })`）。
- `ListItem` の `displayState` は純関数 `displayState(task, issue, bench, runs)` が TS で導く（#17 の表）。`runs` はその Task の Run の Agent Session。live な Run があれば `waiting`（`reason`、許可なら `tool`、エラーなら `errorType`）/ `unobserved` / `running` に `since`（`state_changed_at`）と `liveRuns` を付け、無ければ `closed` / `issue_closed` / `not_started` / `preparing` / `setup_failed` / `ended` の 1 語にする。`liveRuns` は代表を先頭に集約の順で並べる。`ListItem` の `cwd` は Bench の cwd。
- 人間向けの STATE の 1 マスは `waiting:permission(Bash) 12m +1`（理由、許可なら tool 名、`since` からの経過、他の live な Run の件数）。経過は 60 秒未満が `s`、60 分未満が `m`、24 時間未満が `h`、それ以上が `d` で、切り捨てる。
- `current` は呼び手の Terminal Session の live な Agent Session が Run ならその Task を返し（`source: run`、`agentSessionId` はその Agent Session）、そうでなければ Tab → Runspace → Bench の Task を引く（`source: bench`、`agentSessionId` は null）。`terminalSessionId` が無ければ `BAD_REQUEST`、どちらでも引けなければ `NOT_FOUND`。
- Bench の行の変化（作成、準備の終わり）と、Run の Agent Session の変化（Run になったときを含む）は `{ type: "task", ref }` で知らせる。表示状態は Run の Agent Session から導くので、`task.changes` だけで `list` を描き直せるようにする。

## Run

`GLOSSARY.md` の Run を不変条件で保つ。「Bench の Runspace にある Tab の live な（`agent_session.state != 'ended'`）Agent Session で、どの Run でもないものは、その Bench の Task の Run になる」（ADR-0005）。

- Task Ledger は `start()` で Workbench Ledger の `events` を listener で購読し、`agentSession` の合図が来たらその Agent Session に不変条件を当てる。async iterator の購読は溜まった合図を 100 件で捨てるので使わない。Workbench Ledger は transaction の中でも publish するので、読み直しは `queueMicrotask` で commit の後に回す。`stop()` で購読を外す。
- `start()` は購読を張った後に、全件に 1 回当てる。Backend の更新より前から Bench の Tab に居た Agent Session と、commit から購読の microtask までの間に Backend が止まった分を拾う。Backend が居ない間の hook は CLI が捨てるので、不在中に始まった claude の行は起動後の最初の hook で生まれ、購読の経路で Run になる。
- 全件は workbench の reconcile を待たずに当てるので、不在中に Terminal Session が終わった Agent Session も、終了になる前に Run になることがある。Backend が止まる前に Bench の Tab で動いていた agent なので、Task の Run にして差し支えない。
- どちらの経路も `origin = started` で insert する。一度 Run になった Agent Session は、Tab がどこに移っても、終わるまでその Task の Run のまま（`run.agent_session_id` の UNIQUE が守る）。closed な Task には Bench が無いので、Run は生まれない。
- `layout` の合図（Tab の移動）でも、同じく commit の後に当てる。合図はどの Tab が動いたかを持たないので、Bench の Tab すべてに当てる。この経路で生まれる Run は Tab ごと Bench に入った Agent Session なので `origin = attached` にする（GUI の drag）。Bench の Tab で始まった claude の Run は、hook の commit と同じ同期の区間で積まれた `agentSession` の合図の microtask が先に作るので、この経路に横取りされない。
- task のテストは、Tab を workbench の router で開き（shell の起動は fake の ptyd が受ける）、hook は workbench の `agentSession.recordHook` に渡す（`testing.ts` の `openTab`・`openTabOutsideBench`・`hook`）。Tab・Terminal Session・Agent Session の行と合図を Backend と同じ経路で作るため。

## Attach

`GLOSSARY.md` の Attach。CLI の `tania task attach <ref>` は呼び手の Tab を、Tab のメニューの picker は選んだ Tab を、同じ `attach` で移す。GUI の drag は `tab.move` で移し、Run は「Run」の節の `layout` の経路が作る。

- `terminalSessionId` が無ければ `BAD_REQUEST`、未 track は `NOT_FOUND`、closed な Task は `BAD_REQUEST`（`run` と同じ）。
- 1 つの transaction で次の順に進める。
  1. その Terminal Session を表示している Tab を引く。無ければ（detached、または Workbench Ledger に無い）`BAD_REQUEST`。
  2. その Terminal Session の live な Agent Session が別の Task の Run なら `CONFLICT`。message にはその Task の ref を出す。GUI の drag はこれを断らず、Tab だけが移る。
  3. Tab が既にその Bench に居れば、何も変えずに返す（`moveTab` は同じ Runspace でも末尾へ並べ替えるので呼ばない）。
  4. Bench が無ければ、in_place の Bench を作る（`createRunspace` を含む）。cwd は Repo の checkout（`$(ghq root)/github.com/<owner>/<repo>`）で、setup は走らせず、`setup_state` は最初から `ready`（`prepared_at` は作った時刻）。checkout が無いか ghq root が引けなければ `BAD_REQUEST`。attach は network を使わないので clone しない。ghq root は async なので transaction の前に引き、transaction の中で Bench がまだ無いときだけ使う。待つ間に `run` が Bench を作っていれば、そちらに移す。checkout の path は transaction の中で引き直した repo の名前から作る。待つ間に sync が repo の改名を写すと、前に引いた名前の path は古い checkout を指すか、clone されていないことになるため。
  5. `moveTab(tx, tabId, bench.runspaceId)`。pin は外れる。
  6. live な Agent Session がどの Run でもなければ、Run を `origin = attached` で insert する。agent の居ない Tab も移せて、その後その Tab で起こした claude は「Run」の節の不変条件で Run になる。
- commit の後の `layout` の合図では、Agent Session が既に Run なので何も起きない。
- Tab を移したら `{ type: "task", ref }` で知らせる。Run を作らない移動でも `current` の output は変わるため。
- CLI の text は、Bench を作ったこと、Tab がどの Task の Bench に居るか、Tab の claude がその Task の Run になったか（agent が居なければ、次に起こした claude が Run になること）を 1 行ずつ出す。

## Bench

`run` の前半。Bench を確保し、準備が終わるのを待つ。後半は「Run の起動」の節。

- `run` は open な Task だけを受ける（closed は `BAD_REQUEST`、未 track は `NOT_FOUND`）。Bench が無ければ、tx で Task が open かを引き直してから `bench` の行（`preparing`）と `workbenchLedger.createRunspace(tx, { cwd })` を作って commit し（`--in-place` の ghq root を待つ間に close が走り終えることがあるため。Tab を開く tx も同じく引き直す）、準備を Backend の中で始める。準備中の Bench は sidebar にすぐ出る。
- cwd は作る前に決め、その後は変えない。worktree は `$TANIA_HOME/worktrees/<owner>/<repo>/issue-<n>`、`--in-place` は `$(ghq root)/github.com/<owner>/<repo>`。`--in-place` で ghq root が引けなければ、Bench を作らずに `PRECONDITION_FAILED`。worktree の Bench に `--in-place` を打つと `BAD_REQUEST`、flag の無い `run` は今の Bench の mode に従う。
- 準備: in-place は、checkout（cwd）が無ければ `ghq get <owner>/<repo>` して終わる。ghq は repo の今の名前の場所に clone するので、改名の後で cwd に来なければ失敗にする。worktree は、cwd が linked worktree ならそのまま使う。repo が改名されても、作った worktree は作った時の checkout に登録されているので、checkout を引き直さない。cwd が worktree でなければ、checkout が無いときに `ghq get` する。ただし、改名の前に作った worktree が消えていたら（cwd が今の名前の path と違えば）失敗にする。元の branch は改名前の checkout にしか無く、新しい名前の clone から作り直すと黙って別の branch になるため。そのうえで、path が消えていればその登録だけを `git worktree remove <path>` で外し（`prune` は外付けの disk の上の worktree のような、関係の無い登録まで外すので使わない）、branch `issue-<n>` があれば `git worktree add <path> issue-<n>`。無ければ default branch（`refs/remotes/origin/HEAD`、取れなければ `git remote set-head origin --auto` を 1 回）を求め、`git fetch origin <default>` を best-effort で打ってから `git worktree add -b issue-<n> <path> origin/<default>`。fetch の失敗は output の `warnings` に載せる。git と ghq には `GIT_TERMINAL_PROMPT=0` を渡す。Backend が端末から起こされていると、git は認証を /dev/tty で尋ねて止まるため。
- setup は `<worktree>/.tania/setup.sh` を直接 exec する（shebang と実行権限が要る）。無ければ ready。cwd は worktree、stdin は null、env は Backend の env から `TANIA_*`・`CLAUDECODE`・`CLAUDE_CODE_*` を落としたもの。自分の process group（`detached`）で起こし、600 秒で group に SIGTERM を送り、group が空になるか 2 秒たったら SIGKILL を送る。script が先に抜けても、後始末をしている子孫に猶予を残すため。env の除外は workbench の `inheritableEnv()` を ptyd と共有する。
- log は `$TANIA_HOME/logs/setup/<owner>/<repo>/issue-<n>.log` に試行ごとに上書きで書く。setup の stdout と stderr のほかに、失敗の理由を `tania: <理由>` の 1 行で足す。
- log は、system の Job `task.setup-log-cleanup` が起動時と 24 時間おきに `cleanSetupLogs()` で消す。消すのは、最後に書かれて（mtime）から 14 日たった log のうち、Bench の無い Task の log で、close した Task の log と、Task に対応しない log（repo の改名で path が変わった古い log など）が当たる。14 日は ptyd の log（`crates/logfile`）の保持にそろえる。Bench のある Task の log は古くても残す。準備に失敗した `run` は log の path を返すので、それを指したまま消えないようにするため。Bench の Task の log かは、今の repo の名前から作った path と小文字にそろえて比べる。repo の名前の大小だけを変えた改名の後も、macOS の file system では同じ log を指すため。
- 最後に書かれた時刻は消す直前に見る。掃除は同期の fs で 1 回で走らせる。reopen の後の `run` は Bench を作り直して log を書き直すので、掃除を async にすると、Bench の有無を見てから消すまでの間に書き直された log を消すため。Bench の準備は Bench の行を書いてから log を空にするまでを同期で進めるので、掃除はその間に割り込まない。log を消した後、空になった `<owner>/<repo>` と `<owner>` の directory も消す。消せなかった log か directory があれば、残りを消してから reject する。Job Execution は `failed` になり、エラーの 1 行に理由が出る。
- 成功したら `ready` と `prepared_at`、失敗したら `failed` と `setup_error`（`exit 1`、`timed out after 600s`、`spawn failed: <message>`、git の失敗の最後の行）を書く。`run` は `PRECONDITION_FAILED` で `setup_error` と log の path を出す。
- `failed` の Bench への `run` は同じ手順をやり直す。worktree が残っていれば setup だけが走る。準備中の Bench への `run` は同じ準備の完了を待つ。CLI を Ctrl-C しても準備は続く。
- `start()` は `preparing` のまま残った行を `failed`（`the Backend stopped while preparing`）にする。`stop()` は setup の group に SIGKILL を送り、その後の準備の結果は書かない。

## Run の起動

`run` の後半。Bench の新しい Tab で素の `claude` を起こすか、終わった claude を resume する。Run の行は「Run」の節の不変条件が作る。

- Bench があり live な Run があれば、`CONFLICT` で断る。message には live な Run の Agent Session と状態（`s-1 waiting:idle`）を並べ、並行して agent を足すなら Bench に Tab を開いて `claude` を打てば Run になる、と案内する。
- resume の候補は、今の Bench を作った後に始まった Run（`run.started_at >= bench.created_at`）のうち、Agent Session が最後に動いた（`last_event_at` が新しい）もの。live な Run が無いので、その Agent Session は終わっている。候補があれば sync も Blocker gate もせずに resume する。resume は新しい Run ではないため（#18）。
  - Bench より前の Run は reopen の前の挑戦なので、resume せず新しい会話から始める。
  - `transcript_path` の file が無い Agent Session は候補から外す。claude は最初の prompt まで transcript を書かず、prompt を送らずに抜けた Agent Session の `--resume` は `No conversation found` で終わるため。外さないと、その Run がいつまでも候補に残り、`run` で新しい claude を起こせなくなる。path を持たない Agent Session は候補に残す。
- 新しい Run は、Task を sync（5 秒）してから Blocker gate を確かめる。`--force` でも sync する。GitHub に届かないか Issue が返らなければ手元の写しで判定し、`warnings` に理由と写しの古さ（分）を載せて続ける。sync は repo の改名を写すので、Task は名前でなく行の id で引き直す。
- open な Blocker があれば、`.errors()` で宣言した `BLOCKED`（`data.blockers` に ref の一覧）で断る。`--force` なら越える。gate を通ったら Bench を確保して準備する（「Bench」の節。CLI は準備を待つ）。
- tx で `openTab(tx, { runspaceId, cwd, input })` を呼び、commit したら返る。`input` は `claude\r`（resume なら `claude --resume '<id>'\r`）。workbench が commit の後に 24×80 で Create し、通ったらすぐに input を Write する（ADR-0015）。表示されていない Tab の shell は attach の resize で追いつく。shell の起動は待たない。起動前に書いた入力が捨てられないことは #13 で確かめた。ptyd に繋がらない間も `run` は返り、Tab は starting のまま残る。shell の失敗は Tab の failed / lost で見える。Tab は前面に出さない。
- cwd は、新しい Run なら Bench の cwd、resume ならその Agent Session の cwd（その directory が無ければ Bench の cwd）。Agent Session の id は hook の payload から来るので、single quote で囲んで打つ。

## close と reopen

`GLOSSARY.md` の Bench と、ADR-0012 の close の順序。

- `close` は Task を引き（未 track は `NOT_FOUND`、closed は `BAD_REQUEST`）、返るまでその Task を Backend の memory で予約する。予約の間は、同じ Task への `close`、`run`（Bench を開く・準備をやり直す・Tab を開く直前）、`attach` と `reopen`（transaction の中）を `CONFLICT` で断る。git を待つ間に準備や Tab が片付ける Bench に入らないように、また close の呼び手が閉じた結果を受け取るようにするため。Bench の準備が走っていれば、close も `--force` でも `CONFLICT` で断る。準備は worktree と Bench の行を書き続け、走っている準備は reopen の後の `run` にも待たれるため。
- Task を sync（5 秒。`--force` でも sync）してから、行の id で引き直す。GitHub に届かなければ手元の写しで続け、`warnings` に載せる（`run` と同じ `syncOrUseCopy`）。
- guard は当たったものをすべて集め、`.errors()` で宣言した `CLOSE_REFUSED`（`data.reasons`）で返す。`--force` なら見ない。
  - ActiveRun: Task の live な Run。呼び手の Terminal Session の Agent Session の Run は除く。Bench が無くても見る。reopen の前に close を頼んだ claude が残っていることがあるため。
  - UncommittedChanges（worktree の Bench だけ）: `git -C <worktree> status --porcelain --untracked-files=normal` が空でない。untracked を含め、ignored は含めない。worktree が無ければ当たらない。
  - UnpublishedCommits（worktree の Bench だけ）: `git -C <checkout> rev-list --max-count=1 --ignore-missing refs/heads/<branch> --not --remotes <head>…` が commit を返す。`<head>` は、sync が `source = branch` で対応に入れた merged な PR の head の commit。fetch しないので、push 済みなら merge されていなくても止めない。squash merge で remote の branch が消えても、merged な PR の head から辿れる commit は止めないので、`--force` 無しで close できる。merge の後や reopen の後に同じ branch へ積んだ commit は head から辿れないので止める。closing reference だけの merged な PR は別の branch の仕事なので数えない（ADR-0004）。手元に無い head（GitHub の画面で足して fetch していない commit）は無視するので、そのときは `--force` が要る。branch が無ければ当たらない。
- #15 は branch 一致の merged な PR があれば UnpublishedCommits を免除するとしていたが、それでは reopen の後の新しい `issue-<n>` や merge の後に積んだ commit まで免除し、`branch -D` で消すので、`pull_request` に head の commit（`head_oid`）を足して免除を head から辿れる commit に絞った。
- checkout は、worktree があればその `--git-common-dir` の親を使う。repo の改名の後も、作った時の checkout に当たる。worktree が無ければ今の名前の ghq の checkout を使い、それも無ければ git は何もしない。別の Task の Bench が同じ cwd を持てば、worktree にも branch にも触らない。repo の改名の後に旧名を別の repo が使うと、その repo の同じ番号の Task の worktree が同じ path にできるため。
- worktree の Bench は `git -C <checkout> worktree remove <path>` → `git -C <checkout> branch -D <branch>` を実行する。`--force` の close だけが `worktree remove --force` にする。素の `worktree remove` は ignored の file を通し、untracked と変更のある worktree を断るので、guard の後に書かれた変更も git が守る。`branch -D` の前には remote に無い commit を見直し（merged な PR の head から辿れる commit は UnpublishedCommits と同じく数えない）、あれば branch を残して `warnings` に載せ、close は続ける。worktree を外した後は、その branch に commit が積まれないため。path が消えていれば、その登録だけを `worktree remove --force` で外す（失敗は無視する）。消えた worktree の登録が残っていると、その branch を消せないため。`prune` は関係の無い登録まで外すので使わない（「Bench」の節）。git か ghq が失敗したら `PRECONDITION_FAILED` で、DB を何も変えずに止まる。in_place の Bench は checkout も branch も触らない。
- tx で Task を引き直して ref を作り直す。`closed_at` を入れ、`bench` の行を消し、`removeRunspace(tx, runspaceId, { spare })` を呼ぶ。`spare` は呼び手の Terminal Session と、`--force` でなければ git を待つ間に Bench の Tab で起こした claude（hook から Run になっている）の Terminal Session。後者も呼び手と同じく所有を解いた Runspace に残し、`warnings` に載せる。guard の後に見つけたものは、壊した後で断らずに守ったまま close を終えるため。output の `spared` は呼び手の Tab が残ったかどうか。commit の後に `{ type: "task", ref }` で知らせて返る。消した Tab の Terminal Session は、close を待たせずに workbench が終わらせる（ADR-0015）。
- Run の行は残す。close を頼んだ claude は、終わるまで closed な Task の Run のままで、`current` もその Task を返す。
- CLI は拒否を、1 行目の `CLOSE_REFUSED: <ref> stays open:`、理由を 1 行ずつ、最後の `pass --force to close anyway` で出し、exit 1 にする。Skill は stderr の 1 行目で失敗を読むので、1 行目は `CODE: message` の形を保つ。
- `reopen` は closed な Task だけを受ける（open は `BAD_REQUEST`）。sync（5 秒。届かなければ警告）してから `closed_at` を NULL に戻し、`{ type: "task", ref }` で知らせる。Bench は作らないので、表示状態は `not_started`（Issue が closed なら `issue_closed`）。次の `run` か `attach` が Bench を作り直す。`run` は close で消えた branch `issue-<n>` を origin の default branch から作り直し、Bench より前の Run は resume しない（「Run の起動」の節）。

## sync

- GitHub client（`github.ts`）は repo ごとに 1 本の GraphQL で最大 50 件を alias（`i<number>`）で引く。null の alias（削除・transfer・PR の番号）は写しを消さずに `missing` に回し、`errors` があっても返った alias は書く。`repository` ごと null なら（削除・権限の喪失）その repo の失敗にする。新しい Issue の `track` だけは、打ち間違いを GitHub の障害に見せないよう `NOT_FOUND` にする。多くは gh のアカウント違いや SSO による権限の喪失で、`missing` にすると背景 sync の警告に出ず、写しが黙って古くなるため。
- Pull Request は 2 つの経路で引く。各 Issue からは closing reference の PR（`closedByPullRequestsReferences(first: 10, includeClosedPrs: true)`、手動のリンクを含む）を引き、parent と Blocker の node からは引かない。worktree の Bench を持つ Task には、同じ repo の query に `pr<n>: pullRequests(headRefName: "<Bench の branch>", states: [OPEN, CLOSED, MERGED], first: 10)` の alias を足す。Bench が無いか in_place の Bench なら、head が一致する branch も無いので、alias を足さずに branch の経路を空とする。
- PR の写しは小文字の repo と番号で照らして upsert し、repo は GitHub の今の名前に書き直す。state は GraphQL の値を小文字にし、head は branch の名前と commit（`headRefOid`）を写す。行は消さない。repo の改名で旧名の行が残っても、対応は sync のたびに置き換えるのでどこからも指されない。
- `task_pull_request` は Task ごと・経路（`branch` / `closing_reference`）ごとに delete → insert で置き換え、両方に当たる PR は 2 行になる。GitHub が答えなかった経路（null の alias や connection）、Issue が返らなかった Task、失敗した repo の分は置き換えず、前の行を残す。reopen した Task は Bench を作り直すまで branch の対応を持たない。`track` は Task の行を足してから対応を書く。closed な Task は背景と全件の sync で引かないので、対応も close した時点のまま残る。
- token は sync のたびに取り直す。`gh auth token` の失敗は 0 件成功にせず、sync の失敗にする。
- timeout は sync 1 回の全体（token と全 query）にかかる。`track` / `sync` / 背景は 30 秒。`stop()` は走っている request を切る。
- 範囲（open な Task すべて、または 1 つの Task）ごとに走る sync を 1 つにし、後から来た要求はその完了を自分の timeout まで待つ。5 秒の直前の sync が 30 秒の sync に合流しても 5 秒で返すため。
- 背景の sync は `TaskLedger` の `syncInBackground()` で、open な Task すべてを sync する。起動時と 5 分おきに呼ぶのは system の Job `task.sync`（`docs/packages/job-ledger.md`）で、task は timer を持たない。失敗した repo があるか throw したら reject し、Job Execution の結果は `failed` になる。retry と backoff は持たず、次の回がやり直す。
- repo ごとに引けた分をその都度 1 transaction で書く。失敗した repo は `owner/repo: 理由` で並べ、`sync` は `BAD_GATEWAY` を投げ、背景は stderr の 1 行と `list` の `backgroundSyncError` に出す。背景の次の回が成功すれば消える。`backgroundSyncError` は job の記録から読まずに task の memory に置く。読み出しを job に移すと task → job の依存が生まれるため（ADR-0016）。`stop()` の後に終わった回は記録しない。
- 写しの行が同じ issue かは、GitHub の node ID（`issue.node_id`）で決める。node ID で見つからなければ、node ID の無い行（node ID を足す前に書いた行）を `(lower(repo), number)` で照らす。Task の Issue は、query に渡した ref（改名前の名前のこともある）の行を先に照らす。Task が指すのはその行だから。どれでも見つからなければ足す。見つけた行の repo と番号は、GitHub の今の値に書き直す。同じ node ID か、書き直す先の `(repo, number)` に別の行があれば、同じ issue の写しが 2 つあるので、その repo の sync の失敗にする。
- repo の query 1 本分の写しを書くときは、parent や Blocker を書く前に、その batch の Task の Issue の行に node ID と今の名前を付ける。改名した repo の Task が同じ batch の別の Task の parent や Blocker として先に出てきても、Task の行に当たるようにするため。別の repo の Task の parent や Blocker として先に写った場合は 2 行になり、失敗になる（node ID を足す前に書いた行が残る DB で、repo を改名したときだけ）。
- 同じ `(repo, number)` に node ID の違う行があれば、その番号は GitHub で別の issue に使われている（repo を消して作り直したときなど）。黙って付け替えず、その repo の sync の失敗にする。#15 は node ID を保存しないと決めていたが、repo の改名で GitHub は旧名の query にも新しい名前で答え、parent や Blocker の node は新しい名前でしか来ないので、repo と番号だけでは同じ issue の行が 2 つに分かれる。
- `track` が既に track 済みかは、Task の行の insert が重なったかで決める。改名した repo の issue は旧名でも新しい名前でも引けるので、入力の ref の名前では決められない。
- 新しい Issue の `track` は写しと Task の行を同じ transaction で書くので、失敗か `missing` なら何も書かない。
- `syncTask` は 1 つの Task を sync し、成否を投げずに `{ synced, missing, failures }` で返す。`run` / `close` / `reopen` の直前の 5 秒の sync はこれを呼ぶ。
