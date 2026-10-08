# 通知と Dock の数

Agent Session がユーザー待ちに入ったときに macOS の通知を出し、押されたらその Tab を選ぶ（ADR-0013、ADR-0022、語は `GLOSSARY.md` の通知）。判定と本文は workbench が持ち、OS に渡すのは Shell が持つ。Task の無い Tab でも出すので、観測と同じく Workbench を持ち込む骨格の実装に含める。task が足すのは `nameAgentSession` だけ（`docs/packages/task-ledger.md` の「Run」）。未読の数を Dock の icon に出すのと、release で未読でなくなった通知を通知センターから取り下げるのも同じ経路で行う（下の「Dock の数」と「取り下げ」、ADR-0025）。

## 出す遷移

`recordHook` は遷移を書く transaction の中で `notificationFor(前の行 | null, event, 次の行)` に通知の理由を聞き、理由があればその行に `notified_at` を書く（未読の材料。`docs/packages/workbench-ledger.md` の「未読」）。通知そのものは commit した後に出す。`notificationFor` は `transition` の隣に置く純関数。

| 次の状態 | 出す条件 |
|---|---|
| 質問・許可・エラーの待ち | 新しい待ちに入った |
| 手空き | 前の行が動作中か未観測で、event が Stop |
| それ以外 | 出さない |

- 質問とエラーは、前の行が同じ理由の待ちでないときに新しい待ちになる。PreToolUse(AskUserQuestion) と PermissionRequest(AskUserQuestion) は同じ質問なので 1 回しか出ない。
- 許可は、PermissionRequest（ExitPlanMode と AskUserQuestion を除く）が来るたびに新しい待ちになる。前の行が許可待ちでも、`transition` は `state_changed_at` を更新する。許可した tool が動いている間は許可待ちに見えたままなので、その間に background の subagent が次の許可を求めたときに取りこぼさないため。PermissionRequest に `tool_use_id` は無く、同じダイアログかどうかは見分けられない。
- `notificationFor` は `state_changed_at` を比べず、前の行の待ちの理由と event から新しい待ちかを決める。`state_changed_at` は ms 単位なので、同じ ms に続いた hook では新しい待ちに入っても前の行と同じ値になる。
- SessionStart による手空き（起動・resume の直後）と、待ちから手空きへの変化では出さない。
- agent の仕事が残っている Stop は遷移しないので出ない。agent の仕事が終わった後に Claude Code が自分で起こす turn の Stop で出る。
- 未知の session_id は動作中の行を作ってから遷移を当てる（ADR-0008）ので、最初の event が Stop なら出る。
- PermissionRequest(ExitPlanMode) は遷移しないので、プランの自動承認では出ない。
- edge 1 つに通知 1 つ。dedupe key、outbox、Backend の再起動時のまとめ出しは持たない。
- test は遷移表と同じく表駆動で書く。

## title と body

- title は呼び名。`nameAgentSession(db, agentSessionId)` が文字列を返せばそれを使う。null なら Agent Session の cwd の末尾 2 つ（旧 Monica の `shortPath`）を使う。長さは切らない（macOS が切る）。
- `nameAgentSession` は table を読むだけの関数。その Agent Session の Run の Task を引き、無ければ Tab → Runspace → Bench の Task を引いて（CLI の `current` と同じ順）、Bench のラベルと同じ `<repo>#<n> <title>` を返す。後ろの経路は、通知の判定（`recordHook` の commit 直後）が task の購読より先に走り、Bench の Tab で始まったばかりの Agent Session にまだ Run が無い場合のためにある。
- body は `<理由> · <Agent Session の title>`（`手空き · Monica通知の問題`）。理由は `手空き`、`質問`、`許可: <tool>`、`エラー: <error_type>`（error_type が無ければ `エラー`）。Agent Session の title が読めなければ理由だけにし、通知は止めない。title は Task か cwd でしか呼ばないので、同じ repo で claude の Tab を複数開くと、名前が無ければどの Tab の待ちか分からないため。名前を title でなく body に足すのは、sidebar で Runspace → Tab の順に探す並びに合わせるため。名前は切らない（macOS が切る）。
- Agent Session の title は、`transcript_path` が指す Agent Session Transcript の末尾 64 KiB を読み、その中で最後の `{"type":"ai-title","aiTitle":…}` の行の `aiTitle` を使う。Claude Code が Tab の title（OSC 0/2）に出す会話の名前と同じもので、Tab の title は Workbench Ledger に持たない（`docs/packages/workbench-ledger.md`）ので Agent Session Transcript から読む。ptyd に最後の OSC の title を覚えさせる案は、ptyd の protocol と Rust 側の変更が要るので採らない。手元の Agent Session Transcript 87 件では、最後の `ai-title` は末尾から 33 KiB 以内にあった。
- `ai-title` は Claude Code の文書化されていない形式で、短い会話には付かない。Agent Session Transcript が無い、`ai-title` の行が無い、最後の `ai-title` の行が JSON として読めないか `aiTitle` が空でない文字列でないときは、読めないとする。最後の行が読めなくても前の `ai-title` には戻らない。形が変わった後で古い title を出さないため。`ai-title` の行は `"type":"ai-title"` を含む行として探す。Claude Code は詰めた JSON を書くので、会話の本文に出た同じ文字列は escape されて当たらない。
- 音は鳴らさない。

## Backend と Shell

- apps/backend が `createWorkbenchLedger` に渡す `notify({ title, body, terminalSessionId })` は、stdout に `{"type":"notify","title","body","terminalSessionId"}` を 1 行書く。`terminalSessionId` は、通知を出した時に Agent Session が居た Terminal Session（遷移した後の行のもの）。test では `notify` と `nameAgentSession` を差し替える。
- `nameAgentSession` か `notify` が throw したら、stderr に 1 行出して捨てる。`recordHook` の記録と `changes` の合図は続ける。
- Backend の stdout は Shell 宛ての JSON 行専用（ADR-0007）。Backend の log は stderr に出す。
- Shell は stdout の行を `type` で振り分ける。`endpoint` は `backend-endpoint` event に、`notify` は通知（下の「Shell が出す通知」）に、`unread` は Dock の数と通知の取り下げ（下の「Dock の数」と「取り下げ」）に渡す。解釈できない行は Shell の log に流して捨てる。

### Shell が出す通知

- Shell は main bundle の path が `.app` で終わるか（release）で経路を分ける。.app の外の process で `UNUserNotificationCenter.currentNotificationCenter` を呼ぶと、catch できない例外で abort するため（`docs/research/macos-notifications.md`）。
- release は objc2-user-notifications で UNUserNotificationCenter に出す。title と body に加え、`userInfo` の `terminalSessionId` に notify の行の値を載せる。request identifier も notify の行の `terminalSessionId` にし、同じ Terminal Session の届いた通知を新しい通知で置き換える。置き換えても system はもう一度 alert し、一覧の先頭に置く。notify は新しい待ちのたびに出すので、alert の回数は変わらない。`userInfo` の `terminalSessionId` は、クリックと、identifier の違う古い通知を取り下げるのに使う（下の「取り下げ」）。音は鳴らさない。投稿の失敗は completion handler で受け、stderr に 1 行出す。
- release の Shell は `setup` で center の delegate を置き、許可（alert だけ）を求める。`setup` は `applicationDidFinishLaunching:` の中で走るので、通知で起こされたときのクリックにも delegate が間に合う。center は delegate を weak で持つので、Shell は process が終わるまで static に持つ。許可が無ければ通知は出ず、stderr に 1 行出す。
- delegate の `willPresent` は list だけを返す。monica が前面の間はバナーを出さず、通知センターにだけ入れる。
- dev（.app の外）は tauri-plugin-notification で出し、置き換えも取り下げもしない。plugin は Terminal.app の名義で出す（`tauri::is_dev()` で切り替わる）ので、Terminal.app に通知の許可が要り、押しても Tab へは移らない。見た目とクリックは `bun run install-app` で入れた release で確かめる。

### クリック

- delegate の `didReceive` は、`userInfo` の `terminalSessionId` を Shell に 1 つ持ち（新しいクリックで上書き）、webview に `notification-clicked` を emit し、main の窓を unminimize・show・focus する。
- webview は `take_notification_click` command で持っている Terminal Session を取り出し、その Tab を選ぶ（`docs/packages/workbench-ui-state.md` の「通知のクリック」）。取り出すと Shell から消える。
- 通知で起こした monica では、webview が listen を張る前にクリックが届く。ptyd は monica より長生きする（ADR-0011）ので、その Terminal Session がまだ Tab にあれば選べる。

## 未読の集合

Workbench Ledger は、未読の Agent Session が居る Terminal Session の id の集合（id の昇順の配列）を数え直し、Backend を通して Shell に渡す（未読は `docs/packages/workbench-ledger.md` の「未読」）。Shell はそれで Dock の数を出し（下の「Dock の数」）、release では通知を取り下げる（下の「取り下げ」）。通知のバナーは数秒で消え、窓が隠れている間は webview の JS が止まる（ADR-0013）ので、通知と同じく Backend が数えて Shell が出す。

- 数でなく集合を渡すのは、Dock の数と通知の取り下げを同じ集合から決め、食い違わないようにするため。終了でない Agent Session は 1 つの Terminal Session に 1 つまで（`agent_session` の部分 unique index）なので、集合の大きさは未読の数と同じになる。
- Workbench Ledger は `start()` で、ptyd への接続を待たずに今の集合を `unread(terminalSessionIds)` に渡す。ptyd が起きない起動でも数を出すため。以降は自分の `changes` を購読して数え直し、前に渡した集合と違うときだけ渡す。数ではなく集合で比べるのは、未読の Agent Session が別の Tab から hook を受けて居場所を移したときのように、数が同じまま集合が変わることがあるため。合図は procedure の output が変わる経路すべてで出る（`docs/packages.md` の contract の規約 5）ので、hook、`markSeen`、shell の終了、reconcile のどれで集合が変わっても拾う。`stop()` で購読をやめる。
- 数え直しは合図の後の microtask で行う。合図は他の domain の transaction の中（`removeRunspace` など）からも出るので、commit か rollback の後の行を数えるため。同じ transaction で出た合図は 1 回の数え直しにまとまる。
- `unread` か数え直しが throw したら、stderr に 1 行出して捨てる。前に渡した集合は変えないので、次の合図で渡し直す。
- apps/backend が渡す `unread(terminalSessionIds)` は、stdout に `{"type":"unread","terminalSessionIds":[…]}` を 1 行書く。`start()` は endpoint の行より前に呼ぶので、起動時の集合の行は endpoint の行より先に出る。notify の行は `recordHook` の commit の直後に同期で書かれ、数え直しはその後の microtask なので、同じ待ちの notify の行は、それを含む集合の行より先に出る。

## Dock の数

Dock の monica の icon に未読の数を出し、0 なら何も出さない。

- 数えるのは未読の Agent Session で、Pinned の Tab にあるものも数える。終了でない Agent Session は生きている Terminal Session に 1 つずつしか居ず、生きている Terminal Session は、閉じた Tab の shell が終わるまでの間を除けばどれかの Tab が表示しているので、Dock の数は sidebar の行の数の合計と同じになる。Tab を閉じるとその Terminal Session が終わり、Agent Session も終了になるので、その未読は Exit の記録で数から外れる（ADR-0023）。
- Shell は今の Backend の行だけを扱い、集合の大きさを Dock に出す（`set_badge_count`）。終わった Backend の書き残しは捨てる。Rust から呼ぶので capability は要らない。0 は `None` で消す。tauri 2.12 の macOS 実装は `Some(0)` を `"0"` の label にして出すため。
- Shell は Backend が終わったら数を消す。Backend の居ない間に古い数を残さないため。未読は Backend の再起動をまたいで残り、respawn で起き直した Backend が `start()` で今の集合を書くので、数は戻る。

## 取り下げ

release の Shell は、`unread` の行で通知センターの monica の通知を未読の Agent Session に揃え、未読でなくなった（見た、待ちが解けた、終了した）Agent Session の通知を取り下げる（ADR-0025）。揃えるのは未読から通知への片方向で、通知センターで通知を消しても見たことにはしない（`GLOSSARY.md` の未読）。category と CustomDismissAction は持たない。

- Shell は今の Backend から前に届いた集合を、Backend ごとに持つ。2 つ目以降の集合では、前の集合から抜けた id を `removeDeliveredNotificationsWithIdentifiers:` に渡す。identifier が Terminal Session の id なので、届いた通知を読まずに選べる。
- 今の Backend から最初の集合（Shell の起動と、Backend の respawn の後）では、`getDeliveredNotificationsWithCompletionHandler:` で届いた通知を読み、`userInfo` の `terminalSessionId` が集合に無い通知（`terminalSessionId` の無い通知も）の request identifier を取り下げる。前の起動で出した通知と、ADR-0025 より前の UUID の identifier で出た通知はこれで消える。block は background thread で呼ばれうるので、closure には集合の複製を持たせる。
- 最初の集合で未読だった Terminal Session の、UUID の identifier の古い通知は、後で未読でなくなっても id では消えない。次に Backend とつながった時の最初の集合で消える。
- 最初の集合では、届いた通知を読んで取り下げを center に出すまで（最大 2 秒）、その Backend の次の行を扱わない。読む間に同じ Terminal Session の新しい通知を出すと、古い集合で選んだ取り下げがそれを消すため。待つのは Supervisor の lock を放してからにし、webview の `backend_endpoint` などを止めない。
- 取り下げる identifier を選ぶ処理（前の集合と今の集合から、最初の集合なら届いた通知の identifier と `terminalSessionId` から）と、最初の集合かどうかの判定は、objc2 に触らない関数と型にして Rust の test で確かめる。.app の外で走る `cargo test` で `currentNotificationCenter` を呼ぶと abort するため。
- Shell は stdout の行を届いた順に 1 つの thread で扱い、center は要求を system が受けた順に 1 つずつ処理する（`docs/research/macos-notification-removal.md`）。同じ待ちの notify の行は、それを含む集合の行より先に出る（上の「未読の集合」）ので、通知を出す要求はそれを取り下げる要求より先に center に届く。
- Backend が終わっても通知は取り下げない。Dock の数と違い、残った通知はクリックで Tab に移れるため。respawn した Backend の最初の集合で揃う。終わった Backend の書き残しの行では取り下げない。
- 取り下げは非同期で、終わりを知る手段は無い。表示中のバナーも画面から消える（`docs/research/macos-notification-removal.md` の「release で確かめたこと」）。
- 通知が未読より少ないことはある（通知センターで手で消した、許可が無い、投稿に失敗した、通知センターに出さない設定、古い通知が見えなくなった）。sidebar と Dock の数には未読が残る。
- dev（.app の外）は取り下げも届いた通知の読み出しもしない。tauri-plugin-notification の desktop には届いた通知を取り下げる口が無く、.app の外の process で `currentNotificationCenter` を呼ぶと abort するため。
