# usage の contract と Usage Ledger

Backend が受けた Feature の呼び出しを、Caller と日ごとに数えて monica.db に残す（ADR-0037）。語は `GLOSSARY.md` の「Usage」の節に従う。

## 数える場所

- Backend の組み立てが、token の口の 2 つの `RPCHandler`（全権の handler と Chrome Extension の token の handler）とブラウザの口の `RPCHandler` に、`UsageLedger` の `count` を `clientInterceptors` として渡す。`count` は procedure の `path` を `.` でつないだ名前を Feature とし、`await next()` が返れば `ok`、throw すれば `failed` に数える。interceptor は input の検証を包むので、検証の失敗（`BAD_REQUEST`）も `failed` に入る。
- 知らない path、壊れた body、401、413 は interceptor に届かず、Feature の名前も決まらないので数えない。
- iterator を返す procedure（`changes`、`chat.ask`）は、iterator が返った時点で `ok` に数え、流している途中の error は数えない。消す判断に要るのは「使われたか」だけなので、iterator は包まない。
- Usage の書き込みが throw しても、procedure の結果はそのまま返し、stderr に `[usage]` の 1 行を出すだけにする。

## Caller の決め方

Backend の組み立てが request ごとに context に `caller` を入れる（`{ ...context, caller }`）。

- Chrome Extension の token の handler を通った request は `extension`。
- ブラウザの口は `notes`。
- token の口の全権の handler は、`Origin` header があれば `webview`、無ければ `cli`。webview の fetch には `Origin` が必ず付き、CLI の Bun の fetch には付かない。agent が curl で叩いた呼び出しと、hook（`workbench.agentSession.recordHook`）と補完（`__complete`）が打つ呼び出しも `cli` に入る。

## 記録の形

`usage` table 1 つで、`(feature, caller, date)` を主キーにして `ok` と `failed` の回数を持つ。`date` は Backend の手元の暦日（`YYYY-MM-DD`）で、Note の Logical Date のような日の区切りの調整はしない。同じ日の呼び出しは `INSERT … ON CONFLICT DO UPDATE` で同じ行に足す。行は消さない。

## createUsageLedger

`createUsageLedger({ db, features, now? })`。

- `features` は全 Feature の名前で、Backend の組み立てが `featuresOf(router)`（`traverseContractProcedures` で辿った path）で token の口の router（workbench・task・job・chat・usage）とブラウザの口の `browserRouter` から作って渡す。どちらも口が mount するのと同じ router の値を辿る。ブラウザの口を立てない起動でも note の Feature を含む。usage は他の domain を import しないので、一覧は deps で受ける。
- `now` は暦日を決める時計で、テストが日をまたがせるために差し替える。既定は `new Date()`。
- 型に出すのは `count` だけ。`start()` / `stop()` は持たない。`usage.list` の中身は `internals(usageLedger)` に置く。

## usage.list

`monica usage list`（`cli: true`）。全 Feature の行を返す。

- 1 行は Feature と Caller の組で、全期間の `ok`・`failed` の合計と、最後に呼ばれた日（`lastUsed`）を持つ。どの Caller からも呼ばれていない Feature は、`caller: null` の 0 回の行を 1 つ出す。
- 並びは、一度も呼ばれていない Feature を先頭にし、続けて最後に呼ばれた日の古い順。同じ日は Feature の名前、Caller の順。
- `features` に無い Feature（消した Feature）の記録は、table に残したまま出さない。
- 期間で絞る option は持たない。要ると分かったときに足す。
- 表の列は `FEATURE`・`CALLER`・`CALLS`・`FAILED`・`LAST USED`。`CALLS` は `ok` と `failed` の和で、`caller` と `lastUsed` の null は `-` にする。

## テスト

- `count` の数え方と `usage.list` は、`packages/usage/src/usage.test.ts` が `createRouterClient` の `interceptors` に `count` を渡して確かめる。`createRouterClient` は interceptor の context を型に載せないので、caller はテストが足す。
- Caller の決め方は、`apps/backend/src/main.test.ts` が process の Backend の token の口で、ブラウザの口の `notes` は `apps/backend/src/browser-listener.test.ts` が確かめる。
