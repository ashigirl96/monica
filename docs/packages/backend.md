# Backend の組み立て（apps/backend）

`apps/backend` は domain の package を組み立てて Backend の process にする。組み立ては `src/main.ts`、notes の口は `src/notes-listener.ts`。Backend の生死と Shell との約束は ADR-0007、ptyd は ADR-0011、notes の口は ADR-0017 にある。

## PATH と spawn の env

最初に login shell から PATH を 1 回取り（`$SHELL -ilc` で区切り文字に挟んだ `$PATH` を出させる。cwd は `$HOME`、`DISABLE_AUTO_UPDATE=true`）、`process.env.PATH` に入れる。`.app` から起動した Backend は launchd の最小の PATH しか持たず、`gh`・`git`・`ghq`・setup script の中の bun や mise が見つからないため。失敗したら元の PATH のまま stderr に 1 行出す。login shell は stdin を渡さずに起こし（Backend の stdin は Shell の死を知らせる pipe）、5 秒で打ち切る。

PATH を取った後、DB を開く前に env の `MONICA_PTYD_PATH` を見て、無ければ stderr に 1 行出して exit 1 する。

Bun.spawn は `env` を渡さないと、子に起動時の environ を渡し、実行ファイルも起動時の PATH で探す。そのため Backend で動くコードの spawn は `env` を渡す。ふつうは `process.env` で、Bench の setup のように変数を落とすときは workbench の `inheritableEnv()` を使う。lint の `monica/spawn-env`（`scripts/oxlint/monica.js`）は、PATH で実行ファイルを探す spawn に `env` の key があるかを見る。ptyd は `process.env` から組んだ env を渡すので、Tab にも届く。

## 起動と終了

1. `$MONICA_HOME/monica.db` を開き、`locking_mode=EXCLUSIVE` → `journal_mode=WAL` → `foreign_keys=ON` の順に設定する（ADR-0007）。
2. `migrate()` を workbench → task → job → note の順に呼ぶ。`migrationsTable` は各 package の `migrations.table` を渡す（`docs/packages/migration.md`）。
3. `createWorkbenchLedger` → `createTaskLedger` → `createNoteLedger` → `createJobLedger` の順に作る。`createWorkbenchLedger` には、env の `MONICA_PTYD_PATH`（`ptydPath`）、stdout に通知の行を書く `notify`、`@monica/task/server` の `nameAgentSession`、stdout に未読の Terminal Session の集合の行を書く `unread` を渡す。`createTaskLedger` と `createNoteLedger` と `createJobLedger` には同じ `home` を渡す。`createJobLedger` の `systemJobs` には、`@monica/task/server` の `systemJobs(taskLedger)` と `@monica/note/server` の `systemJobs(noteLedger)` の戻り値をこの順につないで渡す。Job Ledger が両方の Ledger を呼ぶので、Note Ledger を先に作る。
4. router を `{ workbench: workbenchRouter, task: taskRouter, job: jobRouter }` で mount し、context は `{ db, workbenchLedger, taskLedger, jobLedger }`。note の router はこの口に載せず、notes の口だけに載せる（下の「notes の口」）。
5. hono に CORS（`tauri://localhost`・`http://tauri.localhost`。env の `MONICA_DEV_URL` があればその origin も。`docs/packages/dev-loop.md` の「dev loop」）、`/health`（token 無し）、`/rpc/*` の bearer を載せ、`Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 })` で立てる。
6. `start()` を Workbench Ledger → Task Ledger → Job Ledger → Note Ledger の順に呼び、notes の口を立てる。Workbench Ledger の `start()`（ptyd への接続と reconcile）を最大 3 秒待ってから、`backend.json` と stdout の endpoint 行を書く（ADR-0007 / 0011）。
7. 終了時は notes の口を止め、`stop()` を逆順に呼んでから ADR-0007 の手順で抜ける。

domain は 4 つしかないので、汎用の「domain の登録」機構は作らずに直接並べる。

Backend の stdout は Shell 宛ての JSON 行専用で、log は stderr に出す（ADR-0007）。行の種類は `endpoint`・`notify`・`unread`（`docs/packages/notifications.md` の「Backend と Shell」）。

## notes の口

ブラウザに notes を配る、固定 port の 2 つ目の口（ADR-0017）。組み立ては `listenNotes`。

- port は Shell が env `MONICA_NOTES_PORT` で渡す（`docs/packages/desktop.md`）。env が無ければ口を立てない。headless で起こした dev の Backend が release の 19380 を取らないようにするため。
- `127.0.0.1` と `::1` の両方で bind する。Chromium と macOS は `monica.localhost` を `::1` から先に引くので、他の process が `::1` 側だけを握っていても EADDRINUSE で見つける。どちらかで失敗したら、立てた方も止め、stderr に 1 行出して口なしで起動を続ける。
- Host は `monica.localhost:<port>`・`localhost:<port>`・`127.0.0.1:<port>`（host 名は `@monica/note/contract` の `NOTES_HOSTNAMES`）の完全一致だけを通し、ほかは 403 で断る（DNS rebinding）。
- GET 以外の request は `Sec-Fetch-Site: same-origin` を求め、ほかは 403 で断る（CSRF）。`same-site` は site が port を見ないので、`localhost` の別の port の app からの request も含む。
- 載せるもの:
  - `/rpc` の `{ note }` の router。context は `{ db, noteLedger }`。workbench・task・job は載せない。`openTab` の `input` は shell に打鍵されるので、token の無い口では任意のコマンドになる。
  - 画像の素の GET（`/api/assets/<file>`、`@monica/note/contract` の `IMAGE_URL_PREFIX`）。prefix の後ろを Note Ledger の `serveImage` に渡し、応答をそのまま返す。oRPC の RPCHandler は File を必ず multipart に包むので、`<img src>` が読む生のバイト列は procedure では返せない（ADR-0019）。
  - SPA の静的ファイル。`/rpc` と画像以外の GET は、build の出力に在る file ならそれを、無ければ `index.html` を返す。path は file system の path として解かず、起動時に集めた file の一覧から引く。`assets/` の下（Vite が hash を付けた file）は `public, max-age=31536000, immutable`、ほかは `no-cache`。
- SPA は compiled binary に `--asset` で同梱した `apps/web/dist` を、entry の隣（`/$bunfs/root/dist`）から読む（`docs/packages/dev-loop.md` の「release build と install」）。`bun run` の Backend には無いので、dev の Backend は SPA の GET に 404 を返し、画面は `apps/web` の Vite が配る。

## テスト

- 組み立て（`src/main.ts`）は、Shell と同じく process として起こし、fake の ptyd の home を渡して確かめる。token の口と notes の口に同じ path を投げ、口ごとに載る procedure を見る。
- notes の口の照合と SPA と画像の GET は `listenNotes` を直に呼んで確かめる。
