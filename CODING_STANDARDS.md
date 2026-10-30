# Coding standards

review で差分に当てる規則。どれも判断が要るもので、理由は規則の文か括弧の中にある。括弧は、決定を記録した ADR、規則が守る振る舞いを見るテストの名前、この file の別の規則、規則に当たるコードのどれかを指す。機械で判定できる規則は lint・型・テストに置き、ここには書かない。

## domain と package

- 1 つの概念は `packages/<domain>` の 1 箇所で定義する。層ごとの写し型、DTO、port と adapter を作らない（ADR-0002）。
- apps は packages を組み立てるだけで、ロジックを持たない（ADR-0002）。
- 他の domain の table には、`sql` で書いた文や table を引数で受け取る helper を通しても直接書かない。書き込みは相手の domain の method を通す（ADR-0009）。
- 他の domain から呼ばれる書き込みは、第 1 引数に transaction を取る同期の method にする。fs への副作用は別の async method にし、呼び手が commit の後に呼ぶ。ptyd への副作用は workbench が transaction の後に自分で送る（ADR-0009、ADR-0015）。
- await を挟んでから transaction に入る処理は、transaction の中で行を id で引き直し、path や名前のような行から作る値はその行から作る。await の間に sync が repo の改名を写したり、別の procedure が同じ行を書いたりするため。
- GitHub から引いた Issue で写しの行や Task を引き当てるときは、node ID で照らし（`packages/task/src/copy.ts` の `isLinkedIssue`）、`(repo, number)` は node ID の無い行にだけ使う。判定する経路と run する経路のように、同じ Issue を引く箇所はすべて同じ照らし方にそろえる。repo の改名の後は sync まで行の名前が古く、旧名は別の repo が使い回すため。
- await を挟む処理は、await の間に同じ Task や行を動かす経路（同じ domain の別の procedure、hook の購読、背景の sync、ユーザーの shell やエディタ）を数え上げ、経路ごとに、予約で断るか、最後の同期区間（transaction）で見直すか、git のような外の確かめに任せるかで閉じる。git や fs のように戻せない操作の後に見つけたものは、断らずに守ったまま処理を終える。断れば、壊した後の中途半端な状態が残るため（`packages/task/src/close-race.test.ts` の「a claude that becomes a Run while close removes the worktree keeps its Tab, like the caller's, and close completes」）。
- Run と Run Button の判定に当てる Issue Facts は、`run-admission.ts` の `freshestFacts` で取り、写しか押した時に読んだ答えかを呼び手で選ばない。`freshestFacts` は、sync が写しを書き直した、sync が失敗して押す前の写しを使った（`syncOrUseCopy` の `warnings`）、sync しない（resume）の 3 つの経路で、手元で最も新しいほうを返す。どれが新しいかは `synced_at` と時刻の大小でなく sync の成否で決める。in-process の fake は読みと sync を同じミリ秒で返すため。
- webview の action が procedure を呼んでから読み直すまでの間にも、CLI や別の画面の操作が挟まる。読み直しで分かるのは今の状態だけで、どの操作で変わったかは分からない。そのため、原因で分岐する判定（閉じて空になったか、移して空になったか）は、procedure が transaction の中で決めて output で返す（workbench の `tab.close` が返す `emptiedRunspaceId`）。Backend が自分で書き、返す相手のいない判定は、transaction の中で決めて event に載せて流す（shell が終わって Bench が空になったときの workbench の `runspaceEmptied`）。
- 画面の処理が await の後で画面の状態や保存の台帳を書き換えるときは、await の間に起きうること（画面が別の対象へ移る、同じ対象をユーザーが編集する、別のタブが同じ対象を保存する、取り直しが失敗して古い cache が返る）を数え、完了時に見直してから書き換える。見直しに使うのは、開いている対象、編集の印、取り直しの成否（`packages/note/src/ui/notes/note-sync.ts` の `reloadLatest`）、返った版の中身（`packages/note/src/ui/pages/essays/actions.ts` の `setOpenEssayStatus`）。開いている対象は URL で見る。`navigate` は URL をその場で書き換えるが、prop と、effect で写した ref は描画の後まで前の対象を指すため。見直さずに保存の予約を捨てる・別の対象へ予約する経路は本文の消失なので、diff が持ち込んだものでなくても直す。
- 対象を消す経路と開き直す経路では、その対象に紐づく手元の状態（保存の予約と基準版、未保存の本文と title、本文と一覧の cache）を数え、経路ごとに捨てるか重ねるかを決める。消す経路では、送信中の保存が後から返す失敗と CONFLICT も数える。残した予約は消した対象へ保存を送り続けるため（`packages/note/src/ui/notes/removals.ts` の `Removals`、`packages/note/src/ui/notes/note-sync.ts` の `noteToOpen`）。
- 削除のように戻しにくい操作は、開いている対象の種類を確かめてから行う。種類ごとの route は別の種類の id でも開くため（`packages/note/src/ui/notes/removals.ts` の `Removals` の種類）。
- focus で取り直す query は互いに順不同で返る。ある query の答えを別の query の答えで解く処理は、どちらが先に返っても同じ結果になるよう、前の答えを控えて使う（`packages/note/src/ui/pages/essays/editor.tsx` の、外で消された Essay の移り先を一覧の並びから選ぶ処理）。
- 画面にいる間だけ持つ状態（削除の取り消しの stack など）は、route を描き分けるより上で持ち、URL から導いた画面に結び付ける。中継の route（`/notes/:id`、`/repos`）を経ると、画面の component は一度 unmount されるため（`packages/note/src/ui/routes.ts` の `removalScreenOf`）。
- props を渡すなどして眠っていた経路を有効にする変更は、有効になる経路を diff の外まで読み、上の規則に照らす。旧 Monica から振る舞いを変えずに移したコードは、移した時には呼ばれていないので、await の後の見直しを経ていないことがある（エディタが破棄された後の完了を `view.isDestroyed` で捨てる `packages/note/src/ui/editor/image-upload.ts`）。
- 外から来た id（Shell の event、通知のクリック）で webview の layout や一覧を引く処理は、今の値が古い場合を数えて閉じる。窓が隠れている間は webview の JS が止まって読み直せず、Backend の再起動中は読み直しが失敗しても値が前のまま残る。読み直してから引き、読み直せなければ次に読めた値で引く（`packages/workbench/src/ui/notification-click.ts`）。
- 合図（listener）を購読して待つ処理は、待つと決めてから購読するまでの間に合図が過ぎた場合を、購読した後に回数や版を見直して閉じる。過ぎた合図は来ないので、そのままでは次の合図まで待ち続ける（`packages/note/src/ui/notes/note-references.ts` の `untilReached`）。
- 画面の effect の中で一度きりの値（module に置いた飛び先など）を取り出すときは、dev の StrictMode が effect を片付けて走らせ直しても、2 度目に同じ値を得られる形にする。取り出すたびに消すと、片付けで壊れる 1 度目にだけ効く（`packages/note/src/ui/notes/block-jump.ts` の `arrivalAt`）。
- procedure が transaction の後に送る ptyd への副作用（Create、Terminate）の結果は、procedure が返った時点ではまだ DB に無い。終わらせた shell を終わったものとして他の判定に渡すときは、Backend が Exit を記録するのを一覧か合図で待つ（ADR-0015）。Tab を閉じた Terminal Session は例外で、Tab の無い live な行を Terminating と読めるので、close が止める Active Run と Run の起動は待たずに数えない（ADR-0023）。
- DB の行と ptyd の両方を進める処理は、workbench の `terminal-session.ts` に置く（ADR-0015）。DB の行と ptyd や fs の両方を進める処理は、commit の前後や ptyd への要求の途中のどこで Backend が止まっても、ptyd との接続が切れても、次の reconcile が正しい状態に戻せる形にする（ADR-0011）。
- commit の後の副作用（通知など）が失敗しても、commit 済みの変更の合図（`events`）と記録は止めない。commit は戻らないので、副作用の失敗で合図を飛ばしたり呼び手に失敗を返したりすると、commit 済みの変更が無かったように見えるため。
- procedure の output が変わる経路（reconcile や他の domain の行の変化を含む）は、どれも自分の domain の `events` で合図する。合図が来なければ、stream だけを購読して読み直す client は古い output を持ったまま残るため。
- 合図（`events`）は、行を書いた関数が自分で出す。合図のための id や真偽を戻り値で返して、呼び手に出させない。呼び手を 1 つ忘れるだけで、購読側（task の Run の誕生、Dock の数、webview の読み直し）が黙って古いまま残るため。
- 呼び手の transaction を受け取る関数は、その transaction の中で合図を出す。rollback しても購読側が読み直すだけで害は無い（ADR-0009）。
- CLI と webview で動くコードは、cli entry が import する内側のファイルも含めて DB に触らず、procedure を呼ぶ（ADR-0003）。
- Shell（`apps/desktop/src-tauri`）に置くのは、Tauri プロセスにしか無いもの（窓と webview の event、app の名義、AppKit）に触る処理と、端末の byte だけ。fs と process の spawn で済む処理は Backend の procedure にする（ADR-0001）。
- iOS の native 実装（`apps/ios/Native`）も OS 操作だけを持ち、DB と業務判断は持たない。通信資格、QR の秘密、TLS trust と Keychain は native に閉じ、同梱 main frame にだけ限定 operation を渡す。接続の取り直しと一覧の世代管理は Workbench の共通コードに置く。
- Backend で動くコードの `Bun.spawn` には、ふつうは `env: process.env` を渡す。Bench の setup のように、Backend だけの env（`MONICA_*`、Claude Code の env）を子に渡さないときは、workbench の `inheritableEnv()` を渡す。lint の `monica/spawn-env` は `env` の key があるかしか見ないため。
- Backend が起こして待つ子 process は、打ち切ったとき・Backend が SIGTERM で止まったとき（`exit` を登録する前の起動の途中も含む）のどちらでも、子孫ごと居なくなるようにする（`apps/backend/src/login-shell-path.ts` の `detached` と group の kill）。子孫は出力を握って待ちを終わらせず、`detached` の子には Backend の死が届かないため。
- Backend の終了（`apps/backend/src/main.ts` の `exit`）は、口と ChatAgent を止めてから `process.exit` まで await を挟まない。await の間に token の口が新しい質問を受けると、止めた後に claude を起こすため。
- oRPC の client を React の state か jotai の atom に入れるときは、`() => client` の形で渡す（`packages/workbench/src/ui/workbench.tsx` の `setClient`）。client は callable な Proxy なので、そのまま渡すと updater として呼ばれるため。property を読むたびに新しい Proxy が返るので、`client.<domain>` は endpoint ごとに `useMemo` で 1 つにする（`apps/desktop/src/App.tsx`）。

## contract

- 合成した contract の root には、domain の package 名で mount する。path の先頭が package 名になり、CLI の command（`monica task run`）もそれに従う。
- `.errors()` で宣言するのは、呼び手が分岐する domain の error（close の guard のように `data` に理由の一覧を持つもの）だけにする。ほかは oRPC の標準の code（`NOT_FOUND`、`BAD_REQUEST`）で投げる。
- 応答の stream（1 回の呼び出しへの応答を流す event iterator）の途中の失敗は、流した event の後に `.errors()` で宣言した error で投げる。handler の中で起きた想定外の error も宣言した error に包む。素の `Error` は client に `INTERNAL_SERVER_ERROR` の「Internal server error」で届き、理由が落ちるため（ADR-0028）。

## CLI

- 一覧の command は `<noun> list`（1 行に 1 件）、1 件とその子の一覧は `<noun> show <id>` にし、子の複数形（`<noun> runs`）を command にしない。CLI は Skill の語彙なので、同じ形の出力には同じ動詞を使う（ADR-0003）。
- 手で書く command も、失敗は stderr の 1 行目に `CODE: message` で書き、help と stack を続けない。exit code は 0（成功）・1（それ以外の失敗）・2（Backend 不在）だけを使い、`--format json` の stdout には成功したときの output だけを出す。Skill は stderr の 1 行目と exit code で失敗を読むため（ADR-0003）。

## 型

- test 以外のコードでは、配列や index signature から読んだ値について、範囲外のときの扱いを決めて分岐で書く。`!` を付けてよいのは、範囲内であることが同じ関数の中の条件から読み取れる箇所だけ。`!` で黙らせると、`noUncheckedIndexedAccess` が範囲外の読み出しを拾えなくなるため。test は `!` でよい。範囲外なら test が落ちるだけなので。

## 依存

- `@anthropic-ai/claude-agent-sdk` は catalog で `^` を付けずに 1 つの版に固定する。版を変える PR は、`docs/research/chat-real-machine-checks.md` の 1 節の確かめを新しい版と同梱の claude でやり直し、その節を直す。Chat の claude の options の効き目は、確かめた版のものしか分からないため（ADR-0032）。

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
- task のテストで `run` の後に、強制でない `close` か同じ Task の次の `run` を呼ぶときは、先に Run の起動を外す。`packages/task/src/testing.ts` の `exit` で Terminal Session を終わらせるか、`close-fixture.ts` の `startedAndEnded` で claude を Run にして終わらせる。外さないと、60 秒の間どちらも `CONFLICT` で断られる。
- 一定の間隔で走る処理は、`setInterval` を `spyOn` で捕まえ、間隔を確かめてから callback を手で呼ぶ。決まった時間の打ち切りは、`setTimeout` を `spyOn` してその callback を捕まえ、手で呼ぶ。
- 本番が `Date.now()` の締め切りと短い sleep の loop で待つもの（setup と Job の SIGTERM から SIGKILL までの猶予）は、待ち始めた印を見てから `setSystemTime` で時計を進め、猶予の手前でまだ待っていることも確かめる。最後に `setSystemTime()` で戻す。
- 子の process の timer は、子を `bun --preload <テスト用の file>` で起こし、preload で差し替える（`apps/cli/src/hook.test.ts` の `AbortSignal.timeout`）。テストの process からは spy できないため。
- 待たずに進むことは、待てば打ち切りまで返らない場面（Exit を送らない fake の ptyd など）を作って確かめる。操作を、打ち切りより短い `Bun.sleep` と `Promise.race` する。テストの既定の timeout は打ち切りより長いことがあり、待ちを戻す変異も通すため（`packages/workbench/src/ui/store.test.ts`）。
- 偽の GitHub に request が届くのは、`requests` を poll せず、`received(count)` を await して待つ。固定の sleep でも待たない。
- 手元の暦日や時刻で切る処理は、テストの中で `process.env.TZ` を UTC 以外（`Asia/Tokyo` など）にして確かめ、`finally` で戻す。`bun test` は `process.env.TZ` を設定せずに UTC で動くので、UTC の日付で切る誤りも通る。
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
- iOS の TS CI は `RemoteWorkbench.observe`・`openTerminal` と実 SQLite・Ledger・fake ptyd、実 Rust Shell relay の結合と境界 lint を見る。端末 lifecycle の実 PTY は Rust 試験で補う。native CI は実 URLSession の HTTPS/WSS・限定 trust・redirect・Keychain と、Simulator の実 WKWebView に同梱 React・xterm を載せる試験を見る。parse ACK だけで描画成功にせず、生成 style の適用と実 screenshot も確認する。Simulator 用の ad-hoc signature は Keychain 試験に必要だが、Apple account、証明書、provisioning profile は不要。実機署名・カメラ・実回線の試験とは区別して報告する。
- bun test に DOM の環境（happy-dom など）を入れない。
- GFM に合わせる markdown の読み（表のセルの区切り、backslash の escape）は、同じ入力を `gh api markdown -f mode=gfm -f text='…'` に通し、cmark-gfm の描画と比べて決める。cmark-gfm の文法（`ext_scanners.re`）を読むだけだと、re2c の最長一致を見落として読み違えるため。
- 相手が body を読みやめられたこと（stream の cancel）を確かめるテストは、cancel が 200ms のうちに届くことを見る。Bun は読みやめたまま捨てた body も GC で 1 秒ほど後に cancel するので、長く待つと cancel を呼ばない実装も通るため。
- CLI が Backend の error をどう出すかと、接続を拒む Backend への retry は、router を `Bun.serve` に載せて HTTP で確かめる。in-process の client（`createRouterClient`）は handler の生の Error をそのまま投げ、HTTP のように `ORPCError` に包まないため（`apps/cli/src/backend.test.ts`）。
- process の外からしか見えない約束（argv の振り分け、stdin と stdout の枠、exit code、打ち切り、env の読み方、stdout の行）は、入口の `main.ts` を subprocess で起こして確かめる（`apps/cli/src/hook.test.ts`・`native-host.test.ts`、`apps/backend/src/main.test.ts`）。Backend は Shell と同じく、fake の ptyd の home と、何も書かない stdin の pipe を渡して起こす。
- 口に procedure が載っているかは、input の検証で断られる不正な input を送って確かめる。載っていれば 400、載っていなければ 404（Chrome Extension の token なら 401）になる。検証は handler の前で断るので、claude や GitHub に届かない。
- Backend を process で起こして偽の claude（`MONICA_CLAUDE_PATH`）に答えさせるテストは、env から `USER` を落とす。偽の claude を渡し損ねて node_modules の claude が起きても、keychain の login を読めず本物の API を呼ばないため（ADR-0033）。

## 語

- 型・関数・画面の語は `GLOSSARY.md` の定義に合わせる。_Avoid_ に挙がった語は使わない。
  - 置かれた場所（table の列、module、crate）で指すものが 1 つに決まる識別子は、語の修飾を省いてよい（`agent_session.transcript_path`、`agentSession.sessionId`、Rust の terminal-daemon の `Transcript` 型とテスト関数 `output_of_a_never_attached_session_reaches_the_transcript`）。外が決めた名前（hook の payload の field）は外の名前のまま受ける。

## コメント

- 既定は comment を書かない。何をしているかは、命名・型・構造・関数の切り出しで伝える（ADR-0039）。
- comment を足す前に、テストの名前・型・命名・ADR・commit message のどれかで表せないかを確かめる。どれでも表せず、読んだ人が「直して」しまう行にだけ、1 文で書く（ADR-0039）。
- 経緯・task・呼び出し元・issue 番号は comment に書かず、commit message と PR に書く。
