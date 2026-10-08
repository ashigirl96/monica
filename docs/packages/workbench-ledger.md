# Workbench Ledger

`packages/workbench` の contract と行の規則。table の下書きは #22 の resolution、Agent Session の遷移表は #36 の resolution にある。

## contract（root は `workbench`）

```
terminalSession.list       → TerminalSession[]（tabId を join）                               cli
layout.get                 → { runspaces: [{ id, cwd, sortOrder, owned,
                                 tabs: [{ id, cwd, sortOrder, terminalSessionId, pinned }] }] }
runspace.create            { cwd?, index?, rows, cols } → { runspaceId, tab }
runspace.remove            { id }                      中の Tab の session を terminate
runspace.move              { id, index }
tab.open                   { runspaceId, cwd?, index?, rows, cols } → Tab
tab.respawn                { id, rows, cols } → Tab
tab.close                  { id } → { emptiedRunspaceId }  session を terminate
tab.move                   { id, runspaceId, index }
tab.setCwd                 { id, cwd }
tab.pin / tab.unpin        { id }
agentSession.recordHook    { terminalSessionId, payload } → void
agentSession.list          → (AgentSession & { unread })[]                                     cli
agentSession.markSeen      { sessionId, notifiedAt } → void
repo.of                    { cwd } → { repo, path, branch }
editor.resolve             { cwd, candidates } → (string | null)[]
editor.open                { path } → void
changes                    → { type: "layout" } | { type: "terminalSession", id }
                             | { type: "agentSession", sessionId } | { type: "reconciled" }
```

- 各 procedure の規則は下の節と、`tab.open` / `tab.respawn` / `terminalSession.list` は #22 の resolution、`recordHook` は `docs/packages/tab-env-and-shim.md`、`repo.*` / `editor.*` は `docs/packages/desktop.md` にある。
- `recordHook` の CLI は手書きの `monica workbench hook claude`。`agentSession.list` の CLI（`monica workbench agent-session list`）は、画面無しで観測を確かめるためにある。
- `owned` は他の domain が `createRunspace(tx, { cwd })` で作った Runspace の印（ADR-0012）。規則は「Runspace と Tab」と「pin」の節にある。
- `terminal_session.shell` は Backend の起動時に 1 回決める。`$SHELL`、無ければ `os.userInfo().shell`、それも無ければ `/bin/zsh`。

## Runspace と Tab

所有されていない Runspace は常に Tab を 1 つ以上持ち、Backend がそれを守る（`GLOSSARY.md` の Runspace）。所有された Runspace（Bench）は Tab が 0 でも残り、Workbench の操作では消えない。`runspace.remove` は `CONFLICT` で断り、GUI に remove は無い。消すのは作った側の `removeRunspace`（Task の close、slice 5）だけ（ADR-0012）。webview で Bench の最後の Tab を閉じたときも、workbench は消さず、slot で task に Task の close を頼むだけ（下の項目）。

- `sort_order` は、Runspace と Tab を足す・移す・消すたびに、同じ transaction の中で兄弟を 0..n-1 に振り直す。`runspace.create` と `tab.open` の `index` を省けば末尾に足す。webview は active の次を渡し（旧 Monica どおり）、CLI と Task は省く。
- Tab の title は Workbench Ledger に持たない。OSC 0/2 の title は webview の memory にだけ持ち、再 attach のときは Terminal Session Transcript の replay に含まれる OSC で戻る。表示は旧 Monica どおり title、無ければ cwd の末尾、それも無ければ `Terminal`。title はよくある zsh の theme なら command のたびに変わり、Workbench Ledger に書くとそのたびに `changes` と `layout.get` が往復するため。
- 再 attach の replay は Terminal Session Transcript の末尾 256 KB だけを流す。そこから落ちたモード（alt screen、マウス、bracketed paste、kitty keyboard の stack など）は、ptyd が replay の前に流し直す。追うモードと理由は `crates/terminal-daemon` の `TerminalModes` の module doc にある。webview の parser がそのモードの CSI を握りつぶすと、この流し直しも効かない。webview の xterm が CSI をどう扱うか（同じモードを送り直したときや、kitty keyboard の stack が buffer ごとにあること）は、webview が動かす版の source の `packages/workbench/node_modules/@xterm/xterm/src/common/InputHandler.ts` で確かめる。RIS と DECSTR が既定に戻す状態（kitty keyboard を含む）は、同じ directory の `services/CoreService.ts` の `reset` にある。
- Shell が出力を読み遅れても、ptyd は接続を切らず、送り損ねた分を後から Terminal Session Transcript から送る（ADR-0020）。Shell と webview は何もせず、出力が遅れて届くだけになる。Terminal Session Transcript の保持を超えて遅れた分は届かず、ptyd は続きの先頭で xterm の buffer を合わせ、追いついて live に戻る前に今のモードをすべて言い直す。
- `tab.respawn` は exited / lost / failed の Tab に新しい session を結び直す。overlay の「New shell in …」と「Retry」が呼ぶ（旧 Monica どおり）。
- `tab.cwd` は最後に分かった cwd。webview は OSC 7 の cwd が前の値と変わったときだけ `tab.setCwd` を呼ぶ（OSC 7 は prompt のたびに来る）。OSC 7 を出さない shell のため、OSC 0/2 の title が `/` で始まるか `~`・`~/…` なら、それも cwd の知らせとして扱う（旧 Monica どおり。`~user` や zsh の named directory は Backend が絶対 path にできないので取らない）。ただし一度でも OSC 7 を出した Tab では title を cwd に使わない（title の `~/repo` と OSC 7 の `/Users/…/repo` が交互に「変わった」ことになるため）。`tab.setCwd` は `~` を home に展開して絶対 path で持つ。Terminal Session の行の cwd は起動したときの cwd のままで、CLI の `terminal-session list` の CWD 列はそれを出す。Backend の張り直し（「pin」の節）と `tab.respawn` はこの cwd で始め、sidebar の Runspace の Repo と行（`repo.of`）も再起動の直後はこれを使う。

- `runspace.create { cwd?, rows, cols } → { runspaceId, tab }` は、Runspace・Tab・`starting` の Terminal Session を 1 transaction で作り、commit 後に Create する（`tab.open` と同じ形）。cwd を省けば `$HOME`。空の Runspace を作ってから `tab.open` を呼ぶ 2 段にすると、間で webview の reload や Backend の再起動が起きたときに空の Runspace が残り、消す規則が無いため。
- `tab.open` の cwd を省けば、新しい Terminal Session は Runspace の cwd で始める。
- Task の close の後に残った Runspace と Tab の cwd は、消えた worktree を指すことがある。ptyd は cwd が directory でなければ shell を `$HOME` で起こす（portable-pty の `CommandBuilder` がそうする）ので、Backend は cwd を確かめずに渡す。Tab の cwd は OSC 7 で追いつく。
- `tab.close` と `tab.move` は、Tab が抜けて 0 になった所有されていない Runspace を同じ transaction で消す。CLI の Attach のように webview の無い経路でも、空の Runspace が残らない。所有された Runspace は 0 になっても残す。
- layout が空になったら、webview が `runspace.create` で 1 つ作る（旧 Monica の `initialState()`）。
- webview は header の Tab を sidebar の Runspace の行に drop すると、`tab.move` でその Runspace の末尾へ移す（旧 Monica に無い操作）。
- 手前に見えていた Tab が、layout を読み直したら別の Runspace に居れば、画面も移った先へついていく。drop、pin の切り出し、Attach（CLI と picker）のどれで移っても同じ。CLI の `monica task attach` は手前の Tab で打つことが多く、ついていかないと打った端末が画面から消えるため。
- Tab を閉じる（Close Tab）経路は、shell の終了（下の Exit）と Ctrl+T → d の 2 つ（ADR-0023）。× と Tab のメニューの Close・Terminate は持たない。終わった Terminal Session の overlay の「Close tab」も `tab.close` を呼ぶが、終了させる shell はもう無い。
  - Ctrl+T → d は、active な Tab を `tab.close` で閉じる。その Tab の Terminal Session に live な Agent Session（`agentSession.list` にある行）があれば、すぐには閉じず、header のその Tab の label を「d again to close tab」に替えて jump モードに留まる。もう一度 d を押したら閉じ、ほかのキーなら閉じずに jump モードを抜ける。d は c（新しい Tab）の隣のキーなので、打ち損じで claude を消さないため。live かは、最初の d のときに Backend の `agentSession.list` を読んで決める。webview の一覧は合図の後に読み直すまで古く、起動の直後は空なので、それで決めると確かめずに claude を閉じるため。読む間に jump モードを抜けていたら閉じない。長押しの自動の繰り返し（`repeat` の keydown）は 2 度目の d に数えない。尋ねた Tab が待つ間に shell の終了で閉じていたら、2 度目の d は手前に来た別の Tab を閉じずに jump モードを抜ける。待つ間は jump hint とキーの一覧を出さず、押したキーは端末に届かない。jump モードを抜けると、どの経路でも待ちを忘れる。
  - pin された Tab と、Tab の無い Bench では、d は何もせずに jump モードを抜ける。
- `tab.close` は Tab の行を消し、その Terminal Session の Terminate を transaction の後に予約する（`removeRunspace` と同じ形。ADR-0015）。webview は終了も detach も頼まない。呼び手を 1 つ忘れるだけで Tab の無い Terminal Session ができるため（ADR-0023）。
- shell が終わった Tab は webview が閉じる。接続中の Tab で Shell の Exit を受けたら、webview が `tab.close` を呼ぶ（旧 Monica どおり）。Backend は行を exited にするだけで、Tab を閉じない。exit の時点で接続していなかった Tab と、lost / failed の Tab は、overlay を出したまま `tab.respawn` か `tab.close` を待つ。pin された Tab は例外で、webview は閉じず、Backend が張り直す（「pin」の節）。
- `tab.close` の `emptiedRunspaceId` は、その close で Tab が 0 になって残った所有された Runspace の id で、それ以外は null。webview は Tab を閉じ（Ctrl+T → d、接続中の Tab の Exit、overlay の「Close tab」）、`emptiedRunspaceId` があれば、layout を読み直した後でその id を `Workbench` の slot `onLastTabClosed` に渡す。0 になったかを close の transaction で決めるのは、読み直した layout では、close の後で読み直す前に Tab を外へ移した分（CLI の Attach など）と区別できないため。渡すのは、Backend がその Terminal Session の Exit を記録して一覧から消すのを待ってから（`terminalSession.list` を 50ms おきに、最大 3 秒）にする。Agent Session は Exit の記録で終わるので、その前に Task の close を頼むと、終わらせた claude が live な Run に見えて guard に止められるため。task の ui がそれを Task の close にする（`docs/packages/task-ledger.md` の「close と reopen」）。Tab を別の Runspace へ移して 0 になったとき（header の drag、CLI と picker の Attach）は呼ばない。閉じたのではないため。Backend の `changes` からは判定しない。`layout` の合図は Tab がどの経路で減ったかを持たず、`run` と `attach` は Bench を作ってから Tab を開く・移すので、Tab の 0 は普段の操作でも起きるため。
- active な Runspace に Tab が無ければ、webview は content に「New shell in <cwd の末尾>」のボタンを Tab の overlay と同じ見た目で出し、押すと Runspace の cwd で `tab.open` する。所有されていない Runspace は常に Tab を持つので、この画面は Bench にだけ出る。close の guard で残った Bench と、close が終わるまでの間に見える。

## Terminal Session の起動と終了

ptyd への Create・Write・Terminate は、行を書いた transaction の後に workbench が送る（ADR-0015）。

- `runspace.create`・`tab.open`・`tab.respawn`、pin の張り直し、他の domain の `openTab` は、`starting` の行を commit したら返り、ptyd を待たない。shell の失敗は Tab の failed / lost で見える。
- `runspace.remove`、`tab.close`、他の domain の `removeRunspace` も、Terminate を後ろで送って返る。Terminate は接続が切れても繋ぎ直した ptyd に送り直し、失敗は stderr に出す。
- 終了には ptyd の Terminate（shell の pid に SIGHUP）を使い、SIGKILL は足さない。前面の claude は shell と別の process group にいても SIGHUP を受け、SessionEnd を送ってから終わる（ADR-0023）。
- reconcile は、ptyd にだけある live な session を取り込まずに Terminate し、Tab に指されていない live な行も Terminate する（ADR-0023）。後者は、Tab を閉じた後で Terminate を送る前に Backend が止まった shell。どちらも Exit を受けて Reap し、後者の行は exited になる。Tab の無い Terminal Session を残さないため。
- reconcile は、Create をまだ送っていない行を、ptyd の List に無くても lost にしない（ADR-0011 の規則の例外）。Create を送った後で応答の前に接続が切れた行は、ADR-0011 どおり reconcile が決める。
- webview は Terminal Session が `starting` の間は attach せず、`running` になった合図（`{ type: "terminalSession", id }`）で attach する。ptyd に session が無いうちに attach すると失敗し、lost と表示して繋ぎ直さないため。

## pin

`GLOSSARY.md` の Pin を Workbench Ledger で守る。Workbench Ledger に置く理由は ADR-0014。

- `tab.pinned`（既定 false）に `(runspace_id) WHERE pinned` の部分 unique index を張り、`layout.get` の Tab に載せる。
- `tab.pin { id }`: Runspace に pin された別の Tab があれば、pin をこの Tab に付け替える。無ければ、所有されていない Runspace にほかの Tab があるとき、新しい Runspace（cwd は Tab の cwd、並びは末尾）を作って Tab を移してから立てる。それ以外はその場で立てる。所有された Runspace（Bench）は、ほかの Tab があっても切り出さない。切り出すと Tab が Task の Bench から外れるため。
- `tab.unpin { id }`: 印を外すだけで、元の Runspace には戻さない。
- `tab.close` と `runspace.remove` は、pin された Tab が対象か中にあれば `CONFLICT` で断る。
- `tab.move` と `moveTab`（Attach）は、Tab を別の Runspace へ移したら同じ transaction で pin を外す。同じ Runspace の中の並べ替えでは外さない。
- `removeRunspace`（Task の close）は pin を見ない。Bench の pin された Tab も他の Tab と同じく消える。
- webview は ⌘P で pin を切り替える（旧 Monica どおり）。sidebar は pin された Tab を持つ Runspace を先頭の Pinned グループにまとめ、グループの中は `sort_order` 順に並べる。drag でグループはまたげない。

張り直し:

- Backend は Exit を受けて行を exited にし、Reap した後で、その Terminal Session を指す Tab が pin されていれば、新しい `starting` の session を作って Tab に結び直し、commit 後に Create する（`tab.respawn` と同じ形）。size は 24×80 で始め、attach の resize で追いつく。
- reconcile の後は、pin された Tab が終わった行を指していれば、同じく張り直す。reconcile で exited か lost にした行のほかに、Exit を記録してから張り直す前に Backend が止まった行も拾う。
- 張り直さないのは、failed の行と、`ended_at - created_at` が 2 秒未満の行。その Tab は overlay を出したまま `tab.respawn` を待つ。`.zshrc` が壊れていて即死を繰り返す shell を、起こし続けないため。ただし pid の無い lost の行（Create が届く前に Backend が止まり、shell が一度も動かなかった行）は、2 秒未満でも張り直す。
- Exit の時点で Tab が無いか pin されていなければ、何もしない。Task の close で消えた Bench の Tab は張り直さない。
- webview は、`changes` で Tab の `terminalSessionId` が替わったら、新しい session に attach し直す。

## 終わった行

- exited / lost / failed の `terminal_session` と、終了の `agent_session` の行は消さない。Run の行は履歴として消さず（Task v1）、`run.agent_session_id` → `agent_session.terminal_session_id` の FK が残るため。1 行は 200 byte 程度で、GC の読み手もいない。
- 一覧は画面が使う行に絞る。
  - `terminalSession.list` は、live か Tab に指されている行だけを返す。Tab の overlay の材料で、webview は Bench の最後の Tab を閉じた後に Terminal Session がここから消えるのを待つ（「Runspace と Tab」）。Tab に指されていない live な行は、閉じた Tab の shell が Exit するまでの間だけ出る。webview は Shell から Exit を受けた Terminal Session を、一覧が live と言っていても exited として扱う（Backend が exit を記録するまで行は live のままなので）。接続中の Tab が Exit で閉じる間は、overlay も dot も出さない。CLI の `monica workbench terminal-session list` も同じものを出す。
  - `agentSession.list` は、終了でない行だけを返す。status dot と未読の材料（`docs/packages/workbench-ui-state.md`）。

## Agent Session の終了と未観測

ADR-0008 の「Backend 起動時」と ADR-0011 の reconcile の規則のうち、Agent Session の分。どちらも `transition` に Terminal Session の終了と Backend の再起動の event として渡す。

- Agent Session の居場所（`terminal_session_id`）は、受け付けた hook の Terminal Session に合わせる。resume の SessionStart を取りこぼした agent が前の Tab に結ばれたままだと、前の Tab が閉じたときに生きている agent を終了にしてしまうため。 つの Terminal Session に live な Agent Session が 1 つであることは、`agent_session` の部分 unique index（`state <> 'ended'`）が守る。cwd も受け付けた hook の値に合わせる。
- Terminal Session の行が終わるとき（ptyd の Exit、reconcile の lost / exited）、同じ transaction で、その Terminal Session の終了でない Agent Session を終了（terminal_exited）にする。
- 生きている Terminal Session の動作中の Agent Session を未観測にするのは、Backend の起動直後の reconcile だけ。ptyd に繋ぎ直したときの reconcile では動作中のままにする。その間も Backend は居て hook を受けていたため。
- reconcile が終了や未観測にした Agent Session も、`reconciled` の前に 1 つずつ `{ type: "agentSession", sessionId }` で知らせる。`agentSession` の合図だけを読む購読側（task の Run）にも、ptyd に繋ぎ直したときの終了が届くようにするため。

## 未読

`GLOSSARY.md` の未読を Workbench Ledger で守る。Workbench Ledger に置く理由は ADR-0021。画面の出し方は `docs/packages/workbench-ui-state.md` の「未読」にある。

- `agent_session` に、今の待ちを通知した時刻 `notified_at` と見た時刻 `seen_at` を置く。どちらも Agent Session が状態に入り直すたび（`transition` の `enter`。待ちの理由が変わるときと、許可の新しい待ちを含む）に空にする。
- `recordHook` は、`notificationFor` が理由を返した遷移の行に、同じ transaction で `notified_at` を書く。通知はどれも状態に入り直す遷移で出るので、通知した待ちの `seen_at` は空から始まる。
- 未読は `notified_at` があり `seen_at` が空のこと。`agentSession.list` が行ごとに `unread` として導いて渡し、webview は導かない。時刻を比べず空かどうかで決めるのは、同じ ms に見たことと次の通知が重なっても取りこぼさないため。
- 待ちが解けると（動作中・終了・未観測）、入り直しで両方が空になるので未読でなくなる。通知を出さない待ち（起動・resume の直後の手空き）は `notified_at` が空なので未読にならない。
- 同じ待ちの間の通知は 1 つの未読と数える。許可を 2 回求めると待ちに入り直すので、1 回目を見た後でも未読に戻る。
- `agentSession.markSeen { sessionId, notifiedAt }` は、未読の行の `notified_at` が渡された `notifiedAt`（webview が見た通知の時刻）と同じときだけ、`seen_at` に今の時刻を書き、`{ type: "agentSession", sessionId }` を publish する。webview が見てから届くまでの間に同じ Agent Session に次の通知が出ても、まだ見ていないその通知を既読にしないため。それ以外の行には何も書かず、合図も出さない。webview が同じ未読に重ねて呼んでも、読み直しが連鎖しないようにするため。無い session は `NOT_FOUND`。
- 未読は Backend の再起動をまたいで残る。reconcile は待ちの行を動かさない（未観測にするのは動作中の行だけ）。
- 未読の数は Workbench Ledger が数え、`badge` で Backend に渡す。数え方と渡す時は `docs/packages/notifications.md` の「Dock の数」にある。

## Tab の外から来た hook

- `recordHook` は、input の Terminal Session が Workbench Ledger に無いか終わっている（exited / lost / failed）なら、何も書かず通知も出さずに、stderr に 1 行出して正常に返す。Agent Session は Tab の中で動く agent なので、どの Tab にも無い Terminal Session の agent は観測しない。
- 起きるのは、env の `MONICA_TERMINAL_SESSION_ID` が Tab の外（Tab で起こした tmux server、Tab から `code .` で開いたエディタの端末、`nohup`）へ漏れたときと、DB を消した後で reconcile が ptyd の session を終わらせる前に hook が届いたとき。
- 生きている Terminal Session の id が漏れた場合は、Backend には見分けられない。payload に pid が無いため。その agent は Tab の agent として観測され、SessionStart で Tab の agent を superseded にする（ADR-0008 の既知のずれ）。
