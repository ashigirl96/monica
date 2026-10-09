# Backend の組み立て（apps/backend）

`apps/backend` は domain の package を組み立てて Backend の process にする。組み立ては `src/main.ts`、ブラウザの口は `src/browser-listener.ts`。Backend の生死と Shell との約束は ADR-0007、ptyd は ADR-0011、ブラウザの口は ADR-0017 と ADR-0028 にある。

## PATH と spawn の env

最初に login shell から PATH を 1 回取り（`$SHELL -ilc` で区切り文字に挟んだ `$PATH` を出させる。cwd は `$HOME`、`DISABLE_AUTO_UPDATE=true`）、`process.env.PATH` に入れる。`.app` から起動した Backend は launchd の最小の PATH しか持たず、`gh`・`git`・`ghq`・setup script の中の bun や mise が見つからないため。失敗したら元の PATH のまま stderr に 1 行出す。login shell は stdin を渡さずに起こし（Backend の stdin は Shell の死を知らせる pipe）、5 秒で打ち切る。

PATH を取った後、DB を開く前に env の `MONICA_PTYD_PATH` を見て、無ければ stderr に 1 行出して exit 1 する。

env の `MONICA_CLAUDE_PATH`（Chat の claude の場所。release の Shell だけが渡す）は検めず、そのまま `createChatAgent` の `claudePath` に渡す。無くても、指す file が無くても止まらない。Chat が使えなくても Workbench は動くべきで、claude を起こせなかったことは質問の答えの場所に出る。

Bun.spawn は `env` を渡さないと、子に起動時の environ を渡し、実行ファイルも起動時の PATH で探す。そのため Backend で動くコードの spawn は `env` を渡す。ふつうは `process.env` で、Bench の setup のように変数を落とすときは workbench の `inheritableEnv()` を使う。lint の `monica/spawn-env`（`scripts/oxlint/monica.js`）は、PATH で実行ファイルを探す spawn に `env` の key があるかを見る。ptyd は `process.env` から組んだ env を渡すので、Tab にも届く。

## 起動と終了

1. `$MONICA_HOME/monica.db` を開き、`locking_mode=EXCLUSIVE` → `journal_mode=WAL` → `foreign_keys=ON` の順に設定する（ADR-0007）。
2. `migrate()` を workbench → task → job → note → chat の順に呼ぶ。chat は table を持たず、空の journal だけを持つ。`migrationsTable` は各 package の `migrations.table` を渡す（`docs/packages/migration.md`）。
3. `createWorkbenchLedger` → `createTaskLedger` → `createNoteLedger` → `createJobLedger` の順に作る。`createWorkbenchLedger` には、env の `MONICA_PTYD_PATH`（`ptydPath`）、stdout に通知の行を書く `notify`、`@monica/task/server` の `nameAgentSession`、stdout に未読の Terminal Session の集合の行を書く `unread` を渡す。`createTaskLedger` と `createNoteLedger` と `createJobLedger` には同じ `home` を渡す。`createJobLedger` の `systemJobs` には、`@monica/task/server` の `systemJobs(taskLedger)` と `@monica/note/server` の `systemJobs(noteLedger)` の戻り値をこの順につないで渡す。Job Ledger が両方の Ledger を呼ぶので、Note Ledger を先に作る。続けて `createChatAgent({ home, claudePath, pdfWorker, cMaps })` で ChatAgent を作る。`claudePath` は env の `MONICA_CLAUDE_PATH` で、dev では無いので SDK が node_modules の claude を使う（`docs/packages/chat.md`）。`pdfWorker` は `new URL('./pdf-worker.ts', import.meta.url)`（`@monica/chat/pdf-worker` を import するだけの `src/pdf-worker.ts`）で、compiled binary では build の 2 つ目の entrypoint が `/$bunfs/root/pdf-worker.ts` に置かれる。`cMaps` は `join(import.meta.dir, 'cmaps')` が在るときだけ渡す。compiled binary は `--asset` で同梱した `pdfjs-dist/cmaps` をそこに持ち、`bun run` の Backend には無いので packages/chat が node_modules から解く（`docs/packages/dev-loop.md` の「release build と install」）。
4. router を `{ workbench: workbenchRouter, task: taskRouter, job: jobRouter }` で mount し、context は `{ db, workbenchLedger, taskLedger, jobLedger }`。note と chat の router はこの口に載せず、ブラウザの口だけに載せる（下の「ブラウザの口」）。
5. hono に CORS（`tauri://localhost`・`http://tauri.localhost`。env の `MONICA_DEV_URL` があればその origin も。`docs/packages/dev-loop.md` の「dev loop」）、`/health`（token 無し）、`/rpc/*` の bearer を載せ、`Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 })` で立てる。
6. `start()` を Workbench Ledger → Task Ledger → Job Ledger → Note Ledger の順に呼び、ブラウザの口を立てる。ChatAgent は `start()` を持たない。Workbench Ledger の `start()`（ptyd への接続と reconcile）を最大 3 秒待ってから、`backend.json` と stdout の endpoint 行を書く（ADR-0007 / 0011）。
7. 終了時はブラウザの口を止め、ChatAgent の `stop()` で spare も含めて持っている claude すべてに SIGKILL を送る。新しい質問を受けなくしてから止めるため。続けて Ledger の `stop()` を逆順に呼んでから ADR-0007 の手順で抜ける。

domain は 5 つしかないので、汎用の「domain の登録」機構は作らずに直接並べる。

Backend の stdout は Shell 宛ての JSON 行専用で、log は stderr に出す（ADR-0007）。行の種類は `endpoint`・`notify`・`unread`（`docs/packages/notifications.md` の「Backend と Shell」）。

## ブラウザの口

ブラウザに notes を配り、Chrome Extension からも呼ばれる、固定 port の 2 つ目の口（ADR-0017・0028）。組み立ては `listenBrowser`。

- port は Shell が env `MONICA_BROWSER_PORT` で渡す（`docs/packages/desktop.md`）。env が無ければ口を立てない。headless で起こした dev の Backend が release の 19380 を取らないようにするため。
- `127.0.0.1` と `::1` の両方で bind する。Chromium と macOS は `monica.localhost` を `::1` から先に引くので、他の process が `::1` 側だけを握っていても EADDRINUSE で見つける。どちらかで失敗したら、立てた方も止め、stderr に 1 行出して口なしで起動を続ける。
- Host は `monica.localhost:<port>`・`localhost:<port>`・`127.0.0.1:<port>`（host 名は `@monica/note/contract` の `NOTES_HOSTNAMES`）の完全一致だけを通し、ほかは 403 で断る（DNS rebinding）。
- GET 以外の request は、`Sec-Fetch-Site: same-origin`（`Sec-Fetch-Mode` は見ない）か、`Sec-Fetch-Site: none` と `Sec-Fetch-Mode: cors` の組だけを通し、ほかは 403 で断る（CSRF）。`same-site` は site が port を見ないので、`localhost` の別の port の app からの request も含む。
  - `none` と `cors` の組は、Chrome Extension が host_permissions に書いた loopback の host へ送る fetch に付き、web ページの fetch には作れない（ADR-0028）。`none` を `cors` と組のときだけ通すのは、user が起こす navigation にも `none` が付くので、mode が `navigate` の POST を外すため。
  - Origin の拡張 ID は照合しない。拡張の page と service worker は Origin を書き換えられ、他の拡張も偽れる見込みで守りにならないため（ADR-0028）。
  - CORS の header は返さない。Chrome Extension の fetch は host_permissions に書いた host には CORS を受けず、preflight も出ない。
- 載せるもの:
  - `/rpc` の `{ note, chat }` の router。context は `{ db, noteLedger, chatAgent }`。workbench・task・job は載せない。`openTab` の `input` は shell に打鍵されるので、token の無い口では任意のコマンドになる。
  - 画像の素の GET（`/api/assets/<file>`、`@monica/note/contract` の `IMAGE_URL_PREFIX`）。prefix の後ろを Note Ledger の `serveImage` に渡し、応答をそのまま返す。oRPC の RPCHandler は File を必ず multipart に包むので、`<img src>` が読む生のバイト列は procedure では返せない（ADR-0019）。
  - SPA の静的ファイル。`/rpc` と画像以外の GET は、build の出力に在る file ならそれを、無ければ `index.html` を返す。path は file system の path として解かず、起動時に集めた file の一覧から引く。`assets/` の下（Vite が hash を付けた file）は `public, max-age=31536000, immutable`、ほかは `no-cache`。
- 2 つの `Bun.serve` に `maxRequestBodySize` で `@monica/chat/contract` の `MAX_ASK_BODY_BYTES`（50MB）を渡す。質問に添えるページの本文とスクリーンショットを受けるための上限で、超えた body は oRPC に届く前に 413 で断られる。note の画像は 20MB までなので、note の upload は変わらない。
- SPA は compiled binary に `--asset` で同梱した `apps/web/dist` を、entry の隣（`/$bunfs/root/dist`）から読む（`docs/packages/dev-loop.md` の「release build と install」）。`bun run` の Backend には無いので、dev の Backend は SPA の GET に 404 を返し、画面は `apps/web` の Vite が配る。

## テスト

- 組み立て（`src/main.ts`）は、Shell と同じく process として起こし、fake の ptyd の home を渡して確かめる。token の口とブラウザの口に同じ path を投げ、口ごとに載る procedure を見る。chat は不正な input を送り、ブラウザの口の 400 と token の口の 404 で見る。不正な input は handler の前で断られるので、claude を起こさない。
- `MONICA_CLAUDE_PATH` は、`@monica/chat/testing` の `writeFakeClaude` が書いた偽の claude を渡して起こし、ブラウザの口の `chat.ask` がその答えを返すことで見る。この Backend には `USER` を渡さない。渡し忘れて node_modules の本物の claude を起こしても、keychain の login を読めずに API を呼ばないため（ADR-0033）。
- ブラウザの口の照合と SPA と画像の GET と body の上限は `listenBrowser` を直に呼んで確かめる。上限より 1MiB 小さい PDF の File が、RPCLink の multipart で 413 にならずに `chat.ask` に届くことも見る。ChatAgent には `writeFakeClaude` の偽の claude を渡す。
