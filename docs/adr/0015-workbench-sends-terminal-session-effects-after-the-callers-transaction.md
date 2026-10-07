---
status: accepted
---

# workbench が Terminal Session の ptyd への副作用を、呼び手の transaction の後に自分で送る

ADR-0009 は、ptyd への副作用を別の async method にし、呼び手が commit の後に呼ぶと決めた。その結果、Tab を開く 5 か所の呼び手（`runspace.create`、`tab.open`、`tab.respawn`、pin の張り直し、task の run）が「reconcile を待つ → transaction で `starting` の行を書く → commit の後に Create」を自分で並べ、1 段目を飛ばしても何も止めなかった。飛ばすと行は reconcile で lost になるのに ptyd では shell が走り、pin した Tab なら 2 つ目の shell が起きる。終わらせる側も、`runspace.remove` と task の close が「transaction で `removeRunspace` → commit → Terminate」を別々に並べていた。そこで `openTab` と `removeRunspace` が ptyd への副作用を `queueMicrotask` で予約し、workbench が自分で送る。bun:sqlite の transaction は同期なので、予約した処理は commit か rollback の後に動く。

## Considered Options

- **Workbench が transaction を開く callback の形**（`workbench.withTab((tx) => …)` が transaction を開き、commit の後に自分で Create する）: 呼び手が自分の transaction に Workbench の書き込みを混ぜられなくなる。task の close は Task の行、Bench の行、`removeRunspace` を 1 つの transaction に書くので（ADR-0009、ADR-0012）、task の書き込みを workbench の callback の中に入れることになり、transaction を開く側が操作ごとに入れ替わる。
- **後で呼ぶ handle を返す形**（`openTab` が `{ tabId, start() }` を返し、呼び手が commit の後に `start()` を呼ぶ）: 順序の義務が handle を呼ぶ義務に変わるだけで、呼び忘れも rollback の後に呼ぶ誤りも止めない。reconcile を待つ義務も呼び手に残る。

## Consequences

- `openTab` は `starting` の行を書き、その id を Create をまだ送っていない集合に足し、Create を予約する。予約が動いた時に行を読み直し、無いか `starting` でなければ rollback として集合から外して何もしない。SQLite は transaction が commit したかを後から教えないので、行で見分ける。Create が通ったら `input`（task の run の `claude\r`）を Write する。Created の応答の前に接続が切れたら、繋ぎ直した reconcile が shell を取り込んだときに Write する。
- `removeRunspace` は、消した Tab の Terminal Session の Terminate を予約する。予約が動いた時に消した Tab が残っていれば rollback として送らない。Terminate は接続が切れても繋ぎ直した ptyd に送り直し（冪等）、失敗は stderr に出す。送る前に Backend が止まると Terminate は残らず、Tab に指されていない live な行として次の起動の reconcile が terminate する（ADR-0023）。`tab.close` も同じ形で、閉じた Tab の Terminal Session の Terminate を予約する。
- reconcile は、Create をまだ送っていない集合にある行を、ptyd の List に無くても lost にしない（ADR-0011 の規則の例外）。Create を送った時点で集合から外すので、送ったが応答の前に接続が切れた行は今どおり reconcile が決める。ptyd に繋がらない間、集合の Create は残り、繋ぎ直した reconcile の後に送る。Backend が死ぬと集合は消え、その行は次の起動の reconcile で lost になる。
- Tab を開く・閉じる操作は ptyd を待たない。`tab.open`、`runspace.create`、`tab.respawn`、task の run は帳簿を commit したら返り、shell の失敗は Tab の failed / lost で見える。`runspace.remove`、`tab.close`、task の close は Terminate を後ろで送る。close の予約は close が返る時に解く。webview は Terminal Session が `starting` の間は attach せず、`running` になった合図で attach する。ptyd に session が無いうちに attach すると失敗して lost に見えるため。
- Workbench が他の domain に出すのは `events`・`start()`・`stop()` と、`createRunspace`・`openTab`・`moveTab`・`removeRunspace` の 4 つの同期 method だけになる。ADR-0009 の「呼び手が commit の後に呼ぶ」は fs への副作用にだけ残る。
