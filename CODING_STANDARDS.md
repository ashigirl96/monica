# Coding standards

review で差分に当てる規則。どれも判断が要るもので、決定の本文と理由は括弧の中の文書にある。機械で判定できる規則は lint・型・テストに置き、ここには書かない。

## domain と package

- 1 つの概念は `packages/<domain>` の 1 箇所で定義する。層ごとの写し型、DTO、port と adapter を作らない（ADR-0002）。
- apps は packages を組み立てるだけで、ロジックを持たない（ADR-0002）。
- 他の domain の table には、`sql` で書いた文や table を引数で受け取る helper を通しても直接書かない。書き込みは相手の domain の method を通す（`docs/packages.md` の「domain をまたぐ規則」）。
- 他の domain から呼ばれる書き込みは、第 1 引数に transaction を取る同期の method にする。ptyd や fs への副作用は別の async method にし、呼び手が commit の後に呼ぶ（`docs/packages.md` の「server entry の形」）。
- await を挟んでから transaction に入る処理は、transaction の中で行を id で引き直し、path や名前のような行から作る値はその行から作る。await の間に sync が repo の改名を写したり、別の procedure が同じ行を書いたりするため（`docs/packages.md` の「Run の起動」と「Attach」）。
- await を挟む処理は、await の間に同じ Task や行を動かす経路（同じ domain の別の procedure、hook の購読、背景の sync、ユーザーの shell やエディタ）を数え上げ、経路ごとに、予約で断るか、最後の同期区間（transaction）で見直すか、git のような外の確かめに任せるかで閉じる。git や fs のように戻せない操作の後に見つけたものは、断らずに守ったまま処理を終える。断れば、壊した後の中途半端な状態が残るため（`docs/packages.md` の「close と reopen」）。
- DB の行と ptyd（や fs）の両方を進める処理は、commit の前後や ptyd への要求の途中のどこで Backend が止まっても、ptyd との接続が切れても、次の reconcile が正しい状態に戻せる形にする（ADR-0011）。
- commit の後の副作用（通知など）が失敗しても、commit 済みの変更の合図（`events`）と記録は止めない（`docs/packages.md` の「通知」）。
- procedure の output が変わる経路（reconcile や他の domain の行の変化を含む）は、どれも自分の domain の `events` で合図する（`docs/packages.md` の「contract の規約」の 5）。
- CLI と webview で動くコードは、cli entry が import する内側のファイルも含めて DB に触らず、procedure を呼ぶ（ADR-0003）。
- Shell（`apps/desktop/src-tauri`）に置くのは、Tauri プロセスにしか無いもの（窓と webview の event、app の名義、AppKit）に触る処理と、端末の byte だけ。fs と process の spawn で済む処理は Backend の procedure にする（ADR-0001）。

## 型

- test 以外のコードでは、配列や index signature から読んだ値について、範囲外のときの扱いを決めて分岐で書く。`!` を付けてよいのは、範囲内であることが同じ関数の中の条件から読み取れる箇所だけ。`!` で黙らせると、`noUncheckedIndexedAccess` が範囲外の読み出しを拾えなくなるため。test は `!` でよい。範囲外なら test が落ちるだけなので。

## テスト

- DB は fake にせず、in-memory の SQLite に migration を当てる。外から見える振る舞いは `createRouterClient` を通して確かめる。ptyd と CLI の seam、procedure に出ない行の確かめ方も同じ節にある（`docs/packages.md` の「テスト」）。

## 語

- 型・関数・画面の語は `GLOSSARY.md` の定義に合わせる。_Avoid_ に挙がった語は使わない。

## コメント

- `~/.claude/CLAUDE.md` の「コードコメント」に従う。
