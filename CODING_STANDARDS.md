# Coding standards

review で差分に当てる規則。どれも判断が要るもので、理由は規則の文か括弧の中にある。括弧は、決定を記録した ADR、規則が守る振る舞いを見るテストの名前、この file の別の規則、規則に当たるコードのどれかを指す。機械で判定できる規則は lint・型・テストに置き、ここには書かない。

## domain と package

- 1 つの概念は `packages/<domain>` の 1 箇所で定義する。層ごとの写し型、DTO、port と adapter を作らない（ADR-0002）。
- apps は packages を組み立てるだけで、ロジックを持たない（ADR-0002）。
- 他の domain の table には、`sql` で書いた文や table を引数で受け取る helper を通しても直接書かない。書き込みは相手の domain の method を通す（`docs/packages.md` の「domain をまたぐ規則」）。
- 他の domain から呼ばれる書き込みは、第 1 引数に transaction を取る同期の method にする。fs への副作用は別の async method にし、呼び手が commit の後に呼ぶ。ptyd への副作用は workbench が transaction の後に自分で送る（`docs/packages.md` の「server entry の形」、ADR-0015）。
- await を挟んでから transaction に入る処理は、transaction の中で行を id で引き直し、path や名前のような行から作る値はその行から作る。await の間に sync が repo の改名を写したり、別の procedure が同じ行を書いたりするため（`docs/packages/task-ledger.md` の「Run の起動」と「Attach」）。
- GitHub から引いた Issue で写しの行や Task を引き当てるときは、node ID で照らし（`packages/task/src/copy.ts` の `isLinkedIssue`）、`(repo, number)` は node ID の無い行にだけ使う。判定する経路と run する経路のように、同じ Issue を引く箇所はすべて同じ照らし方にそろえる。repo の改名の後は sync まで行の名前が古く、旧名は別の repo が使い回すため（`docs/packages/task-ledger.md` の写しの同一性）。
- await を挟む処理は、await の間に同じ Task や行を動かす経路（同じ domain の別の procedure、hook の購読、背景の sync、ユーザーの shell やエディタ）を数え上げ、経路ごとに、予約で断るか、最後の同期区間（transaction）で見直すか、git のような外の確かめに任せるかで閉じる。git や fs のように戻せない操作の後に見つけたものは、断らずに守ったまま処理を終える。断れば、壊した後の中途半端な状態が残るため（`docs/packages/task-ledger.md` の「close と reopen」）。
- Run と Run Button の判定に当てる Issue Facts は、`run-admission.ts` の `freshestFacts` で取り、写しか押した時に読んだ答えかを呼び手で選ばない。`freshestFacts` は、sync が写しを書き直した、sync が失敗して押す前の写しを使った（`syncOrUseCopy` の `warnings`）、sync しない（resume）の 3 つの経路で、手元で最も新しいほうを返す。どれが新しいかは `synced_at` と時刻の大小でなく sync の成否で決める。in-process の fake は読みと sync を同じミリ秒で返すため（`docs/packages/task-ledger.md` の「Run ボタン」の `press`）。
- webview の action が procedure を呼んでから読み直すまでの間にも、CLI や別の画面の操作が挟まる。読み直しで分かるのは今の状態だけで、どの操作で変わったかは分からない。そのため、原因で分岐する判定（閉じて空になったか、移して空になったか）は、procedure が transaction の中で決めて output で返す（`docs/packages/workbench-ledger.md` の「Runspace と Tab」の `emptiedRunspaceId`）。
- 画面の処理が await の後で画面の状態や保存の台帳を書き換えるときは、await の間に起きうること（画面が別の対象へ移る、同じ対象をユーザーが編集する、別のタブが同じ対象を保存する、取り直しが失敗して古い cache が返る）を数え、完了時に見直してから書き換える。見直しに使うのは、開いている対象、編集の印、取り直しの成否（`packages/note/src/ui/notes/note-sync.ts` の `reloadLatest`）、返った版の中身（`packages/note/src/ui/pages/essays/actions.ts` の `setOpenEssayStatus`）。開いている対象は URL で見る。`navigate` は URL をその場で書き換えるが、prop と、effect で写した ref は描画の後まで前の対象を指すため。見直さずに保存の予約を捨てる・別の対象へ予約する経路は本文の消失なので、旧 Monica から移したコードでも直す（`docs/packages/note-ui.md` の「旧 Monica のコードを移すとき」）。
- props を渡すなどして眠っていた経路を有効にする変更は、有効になる経路を diff の外まで読み、上の規則に照らす。旧 Monica から振る舞いを変えずに移したコードは、移した時には呼ばれていないので、await の後の見直しを経ていないことがある（エディタが破棄された後の完了を `view.isDestroyed` で捨てる `packages/note/src/ui/editor/image-upload.ts`）。
- 外から来た id（Shell の event、通知のクリック）で webview の layout や一覧を引く処理は、今の値が古い場合を数えて閉じる。窓が隠れている間は webview の JS が止まって読み直せず、Backend の再起動中は読み直しが失敗しても値が前のまま残る。読み直してから引き、読み直せなければ次に読めた値で引く（`packages/workbench/src/ui/notification-click.ts`）。
- 合図（listener）を購読して待つ処理は、待つと決めてから購読するまでの間に合図が過ぎた場合を、購読した後に回数や版を見直して閉じる。過ぎた合図は来ないので、そのままでは次の合図まで待ち続ける（`packages/note/src/ui/notes/note-references.ts` の `untilReached`）。
- 画面の effect の中で一度きりの値（module に置いた飛び先など）を取り出すときは、dev の StrictMode が effect を片付けて走らせ直しても、2 度目に同じ値を得られる形にする。取り出すたびに消すと、片付けで壊れる 1 度目にだけ効く（`packages/note/src/ui/notes/block-jump.ts` の `arrivalAt`）。
- procedure が transaction の後に送る ptyd への副作用（Create、Terminate）の結果は、procedure が返った時点ではまだ DB に無い。終わらせた shell を終わったものとして他の判定に渡すときは、Backend が Exit を記録するのを一覧か合図で待つ（ADR-0015）。Tab を閉じた Terminal Session は例外で、Tab の無い live な行を Terminating と読めるので、close の ActiveRun guard と Run の起動中の予約は待たずに数えない（ADR-0023、`docs/packages/task-ledger.md` の「close と reopen」）。
- DB の行と ptyd の両方を進める処理は、workbench の `terminal-session.ts` に置く（ADR-0015）。DB の行と ptyd や fs の両方を進める処理は、commit の前後や ptyd への要求の途中のどこで Backend が止まっても、ptyd との接続が切れても、次の reconcile が正しい状態に戻せる形にする（ADR-0011）。
- commit の後の副作用（通知など）が失敗しても、commit 済みの変更の合図（`events`）と記録は止めない（`docs/packages/notifications.md`）。
- procedure の output が変わる経路（reconcile や他の domain の行の変化を含む）は、どれも自分の domain の `events` で合図する。合図が来なければ、stream だけを購読して読み直す client は古い output を持ったまま残るため。
- CLI と webview で動くコードは、cli entry が import する内側のファイルも含めて DB に触らず、procedure を呼ぶ（ADR-0003）。
- Shell（`apps/desktop/src-tauri`）に置くのは、Tauri プロセスにしか無いもの（窓と webview の event、app の名義、AppKit）に触る処理と、端末の byte だけ。fs と process の spawn で済む処理は Backend の procedure にする（ADR-0001）。

## contract

- 合成した contract の root には、domain の package 名で mount する。path の先頭が package 名になり、CLI の command（`monica task run`）もそれに従う。
- `.errors()` で宣言するのは、呼び手が分岐する domain の error（close の guard のように `data` に理由の一覧を持つもの）だけにする。ほかは oRPC の標準の code（`NOT_FOUND`、`BAD_REQUEST`）で投げる。
- 応答の stream（1 回の呼び出しへの応答を流す event iterator）の途中の失敗は、流した event の後に `.errors()` で宣言した error で投げる。handler の中で起きた想定外の error も宣言した error に包む。素の `Error` は client に `INTERNAL_SERVER_ERROR` の「Internal server error」で届き、理由が落ちるため（ADR-0028）。
- `oc.$meta(...)` と `createSchemaFactory({ coerce: { date: true } })` は、各 package の `contract.ts` の中にだけ書く。oRPC 2.0 で `.meta` が plugin 制になったときに、直す場所を 1 つにするため。`apps/cli/src/forward.ts` の `os.$meta` は、output を持たない procedure を組み直すために contract の meta を引き継ぐ例外。

## 型

- test 以外のコードでは、配列や index signature から読んだ値について、範囲外のときの扱いを決めて分岐で書く。`!` を付けてよいのは、範囲内であることが同じ関数の中の条件から読み取れる箇所だけ。`!` で黙らせると、`noUncheckedIndexedAccess` が範囲外の読み出しを拾えなくなるため。test は `!` でよい。範囲外なら test が落ちるだけなので。

## 依存

- `@anthropic-ai/claude-agent-sdk` は catalog で `^` を付けずに 1 つの版に固定する。版を変える PR は、`docs/packages/chat.md` の「実機で確かめたこと」の確かめを新しい版と同梱の claude でやり直し、その節を直す。Chat の claude の options の効き目は、確かめた版のものしか分からないため（ADR-0032）。

## テスト

- DB は fake にせず、package ごとに in-memory の SQLite に自分の migration を当てる（task は workbench → task の順）。外から見える振る舞いは `createRouterClient(router, { context })` を通し、他の domain から呼ばれる method と module 内の関数はそのまま呼んで確かめる（ADR-0002）。
- procedure に出ない行（終わった行など）は、`@monica/<d>/schema` の table を SELECT して確かめてよい。他の domain が読むのと同じ面のため。
- ptyd は、`@monica/workbench/testing` の fake の ptyd と `tempHome` の home で組む。本物の ptyd は CI の ts job に無く、Exit と Created の競合も決まった順で起こせないため。
- task と CLI のテストも Workbench Ledger の method を差し替えず、fake の ptyd の home で `createWorkbenchLedger` を組んで本物の protocol に通す（ADR-0009）。Tab と Runspace は Workbench Ledger の method か workbench の router で開き、Agent Session は hook で作り、workbench の table に直に書かない。
- procedure と Workbench Ledger の method は ptyd を待たずに返る。ptyd に届いた op は fake の `received` か `receivedAtLeast` で待ってから確かめ、Terminal Session が starting を抜けるのは `untilSettled` で待つ。
- op が届かないことを `receivedAll(…)` が空で確かめるときは、後から送る別の op（Tab を開いた Create など）が届くのを待ってから読む。すぐに読むと、transaction の後に送る op が届く前の空を見て、送ってしまう変異も通すため。
- await の間の競合は、await の途中で止めて決まった順で起こす。sync は fake の GitHub の `hold()` で、git の ref の更新（`branch -D` など）は checkout の `.git/hooks/reference-transaction` に置いた、file を待つ script で、ptyd の応答は fake の ptyd の `holdNext(op)` で止める（`packages/task/src/close-race.test.ts`）。
- 止められるのは、procedure が await する所だけ。procedure が待たない副作用（commit の後に workbench が送る Terminate など）を止めても、procedure の中の窓は止まらず、テストは競合を通らないまま通る。
- system の Job を足すときは、並びを出す domain のテストに 1 本足す。`systemJobs(<d>Ledger)` から名前で取り出した `run` を最小の場面で呼び、Ledger の method に届くことを見る。method の規則のテストは method を直に呼ぶ。`run` が別の method を呼んでも、型も Job Ledger のテストも捕まえないため。
- 一定の間隔で走る処理は、`setInterval` を `spyOn` で捕まえ、間隔を確かめてから callback を手で呼ぶ。決まった時間の打ち切りは、`setTimeout` を `spyOn` して callback を手で呼ぶ。
- `jest.useFakeTimers()` は使わない。Bun では `Bun.sleep` と `setTimeout` も止まり、一部の timer だけを偽にできないので、HTTP の応答を待つテストが進まなくなるため。
- 本番が `Date.now()` の締め切りと短い sleep の loop で待つもの（setup と Job の SIGTERM から SIGKILL までの猶予）は、待ち始めた印を見てから `setSystemTime` で時計を進め、猶予の手前でまだ待っていることも確かめる。最後に `setSystemTime()` で戻す。
- 子の process の timer は、子を `bun --preload <テスト用の file>` で起こし、preload で差し替える（`apps/cli/src/hook.test.ts` の `AbortSignal.timeout`）。テストの process からは spy できないため。
- 待たずに進むことは、待てば打ち切りまで返らない場面（Exit を送らない fake の ptyd など）を作って確かめる。操作を、打ち切りより短い `Bun.sleep` と `Promise.race` する。テストの既定の timeout は打ち切りより長いことがあり、待ちを戻す変異も通すため（`packages/workbench/src/ui/store.test.ts`）。
- 偽の GitHub に request が届くのは、`requests` を poll せず、`received(count)` を await して待つ。固定の sleep でも待たない。
- 手元の暦日や時刻で切る処理は、テストの中で `process.env.TZ` を UTC 以外（`Asia/Tokyo` など）にして確かめる。`bun test` は UTC で動くので、UTC の日付で切る誤りも通るため。
- `process.env.TZ` は `finally` で `process.env.TZ = tz ?? 'UTC'` と戻す。`undefined` の代入は文字列の `"undefined"` を入れて直前の時間帯を残し、`delete` は手元の時間帯に落とすので、どちらも UTC に戻らず、同じ process で後に走るテストに漏れるため（`packages/usage/src/usage.test.ts`・`packages/ui/src/local-time.test.ts`）。
- oRPC の client の procedure を記録するか差し替えるときは、client を `new Proxy` で包み、`get` でその key だけを替えて呼び手に渡す。client は property を読むたびに新しい Proxy を返すので、`spyOn` では差し替えられないため（`packages/task/src/ui/bench-close.test.ts`）。
- 受けた値を `toMatchObject` に渡した後で読み直さない。Bun の `toMatchObject` は、受けた object の中で matcher（`expect.stringContaining` など）に当たった値を、その matcher に置き換えるため（Bun 1.4.2）。後で読む値は、渡す前に取り出す。
- 外のサービスの fake（GitHub、ghq、ptyd）は、本物が引数で変える振る舞い（GraphQL の `states` や `includeClosedPrs` など）も再現する。引数を見ない fake では、query から引数を落としてもテストが通る。
- 打ち切りのテストは、signal に応えない fake（終わらない promise を返す）で確かめる。signal で reject する fake では、打ち切りが相手の終わりを待つ実装でも通る。本物の process は kill されても、子が stdout を握れば出力が読み終わらない（`packages/note/src/repo.ts` の ghq）。
- テストが exec する偽の実行 file は、repo に置いた 1 つの file を指す symlink にする。sh の script を走らせる偽物（偽の `gh`、偽の login shell）は `@monica/workbench/testing` の `writeFakeExecutable`、偽の claude は `@monica/chat/testing` の `writeFakeClaude` で置く。macOS は新しく書いた実行 file を初めて exec するたびに system で 1 列に並ぶ検査（1 回 0.1〜1 秒）を挟み、並列の worker どうしが待ち合って 5 秒の timeout を落とすため。
- 本番のコードが書いて exec する file（Tab の claude の wrapper、checkout の `setup.sh`、git hook）を直に exec するのは、その振る舞いを見るテストだけにする。setup を見ないテストの Repo には `setup.sh` を置かず、準備中の Bench が要るだけのテストは ghq の取得を pending の Promise にして止める。同じ wrapper を何度も exec するテストどうしは、home を 1 つにして使い回す（`packages/workbench/src/tab-env.test.ts`）。
- 遅いテストの timeout を、test ごとの第 3 引数で引き上げない。1 本ごとに process を起こす file は、file の先頭の `setDefaultTimeout` で引き上げる（`apps/backend/src/main.test.ts`）。
- テストが起こした process（Backend、偽の claude、偽の ptyd）は、居なくなるのを待ってから home を消す。走査の途中で他の process が子を消すと、Bun の `rmSync({ recursive: true, force: true })` は例外を出さずに止まり、home が TMPDIR に残るため。
- 一時 directory は `finally` で消さず、hook（`afterAll` など）で消す。timeout で打ち切られた test は `finally` を飛ばすため。
- hook は test file に書く。共有の module は片付けの関数を出し、呼び手の test file に登録させる（`scripts/oxlint/lint-probes.ts` の `cleanUpLintProbes`）。bun test は同じ process の test file どうしで module を使い回し、module の top level で登録した hook は最初に import した file にしか付かないため。

## 語

- 型・関数・画面の語は `GLOSSARY.md` の定義に合わせる。_Avoid_ に挙がった語は使わない。
  - 置かれた場所（table の列、module、crate）で指すものが 1 つに決まる識別子は、語の修飾を省いてよい（`agent_session.transcript_path`、`agentSession.sessionId`、Rust の terminal-daemon の `Transcript` 型とテスト関数 `output_of_a_never_attached_session_reaches_the_transcript`）。外が決めた名前（hook の payload の field）は外の名前のまま受ける。

## コメント

- 既定は comment を書かない。何をしているかは、命名・型・構造・関数の切り出しで伝える（ADR-0039）。
- comment を足す前に、テストの名前・型・命名・ADR・commit message のどれかで表せないかを確かめる。どれでも表せず、読んだ人が「直して」しまう行にだけ、1 文で書く（ADR-0039）。
- 経緯・task・呼び出し元・issue 番号は comment に書かず、commit message と PR に書く。
