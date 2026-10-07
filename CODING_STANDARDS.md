# Coding standards

review で差分に当てる規則。どれも判断が要るもので、決定の本文と理由は括弧の中の文書にある。機械で判定できる規則は lint・型・テストに置き、ここには書かない。

## domain と package

- 1 つの概念は `packages/<domain>` の 1 箇所で定義する。層ごとの写し型、DTO、port と adapter を作らない（ADR-0002）。
- apps は packages を組み立てるだけで、ロジックを持たない（ADR-0002）。
- 他の domain の table には、`sql` で書いた文や table を引数で受け取る helper を通しても直接書かない。書き込みは相手の domain の method を通す（`docs/packages.md` の「domain をまたぐ規則」）。
- 他の domain から呼ばれる書き込みは、第 1 引数に transaction を取る同期の method にする。fs への副作用は別の async method にし、呼び手が commit の後に呼ぶ。ptyd への副作用は workbench が transaction の後に自分で送る（`docs/packages.md` の「server entry の形」、ADR-0015）。
- await を挟んでから transaction に入る処理は、transaction の中で行を id で引き直し、path や名前のような行から作る値はその行から作る。await の間に sync が repo の改名を写したり、別の procedure が同じ行を書いたりするため（`docs/packages/task-ledger.md` の「Run の起動」と「Attach」）。
- await を挟む処理は、await の間に同じ Task や行を動かす経路（同じ domain の別の procedure、hook の購読、背景の sync、ユーザーの shell やエディタ）を数え上げ、経路ごとに、予約で断るか、最後の同期区間（transaction）で見直すか、git のような外の確かめに任せるかで閉じる。git や fs のように戻せない操作の後に見つけたものは、断らずに守ったまま処理を終える。断れば、壊した後の中途半端な状態が残るため（`docs/packages/task-ledger.md` の「close と reopen」）。
- webview の action が procedure を呼んでから読み直すまでの間にも、CLI や別の画面の操作が挟まる。読み直しで分かるのは今の状態だけで、どの操作で変わったかは分からない。そのため、原因で分岐する判定（閉じて空になったか、移して空になったか）は、procedure が transaction の中で決めて output で返す（`docs/packages/workbench-ledger.md` の「Runspace と Tab」の `emptiedRunspaceId`）。
- 画面の処理が await の後で画面の状態や保存の台帳を書き換えるときは、await の間に起きうること（画面が別の対象へ移る、同じ対象をユーザーが編集する、別のタブが同じ対象を保存する、取り直しが失敗して古い cache が返る）を数え、完了時に見直してから書き換える。見直しに使うのは、開いている対象、編集の印、取り直しの成否（`packages/note/src/ui/notes/note-sync.ts` の `reloadLatest`）、返った版の中身（`packages/note/src/ui/pages/essays/actions.ts` の `setOpenEssayStatus`）。開いている対象は URL で見る。`navigate` は URL をその場で書き換えるが、prop と、effect で写した ref は描画の後まで前の対象を指すため。見直さずに保存の予約を捨てる・別の対象へ予約する経路は本文の消失なので、monica から移したコードでも直す（`docs/packages/note-ui.md` の「monica のコードを移すとき」）。
- props を渡すなどして眠っていた経路を有効にする変更は、有効になる経路を diff の外まで読み、上の規則に照らす。monica から振る舞いを変えずに移したコードは、移した時には呼ばれていないので、await の後の見直しを経ていないことがある（エディタが破棄された後の完了を `view.isDestroyed` で捨てる `packages/note/src/ui/editor/image-upload.ts`）。
- 合図（listener）を購読して待つ処理は、待つと決めてから購読するまでの間に合図が過ぎた場合を、購読した後に回数や版を見直して閉じる。過ぎた合図は来ないので、そのままでは次の合図まで待ち続ける（`packages/note/src/ui/notes/note-references.ts` の `untilReached`）。
- 画面の effect の中で一度きりの値（module に置いた飛び先など）を取り出すときは、dev の StrictMode が effect を片付けて走らせ直しても、2 度目に同じ値を得られる形にする。取り出すたびに消すと、片付けで壊れる 1 度目にだけ効く（`packages/note/src/ui/notes/block-jump.ts` の `arrivalAt`）。
- procedure が transaction の後に送る ptyd への副作用（Create、Terminate）の結果は、procedure が返った時点ではまだ DB に無い。終わらせた shell を終わったものとして他の判定（close の ActiveRun guard など）に渡すときは、Backend が Exit を記録するのを一覧か合図で待つ（ADR-0015、`docs/packages/workbench-ledger.md` の「Runspace と Tab」）。
- DB の行と ptyd の両方を進める処理は、workbench の `terminal-session.ts` に置く（ADR-0015）。DB の行と ptyd や fs の両方を進める処理は、commit の前後や ptyd への要求の途中のどこで Backend が止まっても、ptyd との接続が切れても、次の reconcile が正しい状態に戻せる形にする（ADR-0011）。
- commit の後の副作用（通知など）が失敗しても、commit 済みの変更の合図（`events`）と記録は止めない（`docs/packages/notifications.md`）。
- procedure の output が変わる経路（reconcile や他の domain の行の変化を含む）は、どれも自分の domain の `events` で合図する（`docs/packages.md` の「contract の規約」の 5）。
- CLI と webview で動くコードは、cli entry が import する内側のファイルも含めて DB に触らず、procedure を呼ぶ（ADR-0003）。
- Shell（`apps/desktop/src-tauri`）に置くのは、Tauri プロセスにしか無いもの（窓と webview の event、app の名義、AppKit）に触る処理と、端末の byte だけ。fs と process の spawn で済む処理は Backend の procedure にする（ADR-0001）。

## 型

- test 以外のコードでは、配列や index signature から読んだ値について、範囲外のときの扱いを決めて分岐で書く。`!` を付けてよいのは、範囲内であることが同じ関数の中の条件から読み取れる箇所だけ。`!` で黙らせると、`noUncheckedIndexedAccess` が範囲外の読み出しを拾えなくなるため。test は `!` でよい。範囲外なら test が落ちるだけなので。

## テスト

- DB は fake にせず、in-memory の SQLite に migration を当てる。外から見える振る舞いは `createRouterClient` を通して確かめる。ptyd と CLI の seam、procedure に出ない行の確かめ方も同じ節にある（`docs/packages.md` の「テスト」）。
- 外のサービスの fake（GitHub、ghq、ptyd）は、本物が引数で変える振る舞い（GraphQL の `states` や `includeClosedPrs` など）も再現する。引数を見ない fake では、query から引数を落としてもテストが通る。
- 打ち切りのテストは、signal に応えない fake（終わらない promise を返す）で確かめる。signal で reject する fake では、打ち切りが相手の終わりを待つ実装でも通る。本物の process は kill されても、子が stdout を握れば出力が読み終わらない（`packages/note/src/repo.ts` の ghq）。

## 語

- 型・関数・画面の語は `GLOSSARY.md` の定義に合わせる。_Avoid_ に挙がった語は使わない。

## コメント

- `~/.claude/CLAUDE.md` の「コードコメント」に従う。
