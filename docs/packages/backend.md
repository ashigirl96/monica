# Backend（apps/backend）

`apps/backend` の組み立てと、ブラウザに notes を配る 2 つ目の口。Backend の寿命と endpoint は ADR-0007。

## 組み立て（`apps/backend/src/main.ts`）

最初に login shell から PATH を 1 回取り（`$SHELL -ilc` で区切り文字に挟んだ `$PATH` を出させる。cwd は `$HOME`、`DISABLE_AUTO_UPDATE=true`）、`process.env.PATH` に入れる。`.app` から起動した Backend は launchd の最小の PATH しか持たず、`gh`・`git`・`ghq`・setup script の中の bun や mise が見つからないため。失敗したら元の PATH のまま stderr に 1 行出す。login shell は stdin を渡さずに起こし（Backend の stdin は Shell の死を知らせる pipe）、5 秒で打ち切る。

Bun.spawn は `env` を渡さないと、子に起動時の environ を渡し、実行ファイルも起動時の PATH で探す。そのため Backend で動くコードの spawn は `env: process.env` を渡す（絶対 path の実行ファイルは除く）。lint の `tania/spawn-env`（`scripts/oxlint/tania.js`）がこれを守る。ptyd は `process.env` から組んだ env を渡すので、Tab にも届く。

1. `$TANIA_HOME/tania.db` を開き、`locking_mode=EXCLUSIVE` → `journal_mode=WAL` → `foreign_keys=ON` の順に設定する（ADR-0007）。
2. `migrate()` を workbench → task → job → note の順に呼ぶ。`migrationsTable` は各 package の `migrations.table` を渡す（`docs/packages/migration.md`）。
3. `createWorkbenchLedger` → `createTaskLedger` → `createJobLedger` → `createNoteLedger` の順に作る。`createWorkbenchLedger` には、env の `TANIA_PTYD_PATH`（`ptydPath`）、stdout に通知の行を書く `notify`、`@tania/task/server` の `nameAgentSession` を渡す。`createTaskLedger` と `createJobLedger` と `createNoteLedger` には同じ `home` を渡す。`createJobLedger` の `systemJobs` には、`@tania/task/server` の `systemJobs(taskLedger)` の戻り値を渡す。`TANIA_PTYD_PATH` が無ければ stderr に 1 行出して exit 1 する。
4. router を `{ workbench: workbenchRouter, task: taskRouter, job: jobRouter }` で mount し、context は `{ db, workbenchLedger, taskLedger, jobLedger }`。note の router はこの口に載せず、notes の口だけに載せる（下の「notes の口」）。
5. hono に CORS（`tauri://localhost`・`http://tauri.localhost`。env の `TANIA_DEV_URL` があればその origin も。`docs/packages/dev-loop.md` の「dev loop」）、`/health`（token 無し）、`/rpc/*` の bearer を載せ、`Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 })` で立てる。
6. `start()` を Workbench Ledger → Task Ledger → Job Ledger → Note Ledger の順に呼び、notes の口を立てる。Workbench Ledger の `start()`（ptyd への接続と reconcile）を最大 3 秒待ってから、`backend.json` と stdout の endpoint 行を書く（ADR-0007 / 0011）。
7. 終了時は notes の口を止め、`stop()` を逆順に呼んでから ADR-0007 の手順で抜ける。

domain は 4 つしかないので、汎用の「domain の登録」機構は作らずに直接並べる。

## notes の口

ブラウザに notes を配る、固定 port の 2 つ目の口（ADR-0017）。組み立ては `apps/backend/src/notes-listener.ts` の `listenNotes`。

- port は Shell が env `TANIA_NOTES_PORT` で渡す（`docs/packages/desktop.md`）。env が無ければ口を立てない。headless で起こした dev の Backend が release の 19380 を取らないようにするため。
- `127.0.0.1` と `::1` の両方で bind する。Chromium と macOS は `tania.localhost` を `::1` から先に引くので、他の process が `::1` 側だけを握っていても EADDRINUSE で見つける。どちらかで失敗したら、立てた方も止め、stderr に 1 行出して口なしで起動を続ける。
- Host は `tania.localhost:<port>`・`localhost:<port>`・`127.0.0.1:<port>`（host 名は `@tania/note/contract` の `NOTES_HOSTNAMES`）の完全一致だけを通し、ほかは 403 で断る（DNS rebinding）。
- GET 以外の request は `Sec-Fetch-Site: same-origin` を求め、ほかは 403 で断る（CSRF）。`same-site` は site が port を見ないので、`localhost` の別の port の app からの request も含む。
- 載せるもの:
  - `/rpc` の `{ note }` の router。context は `{ db, noteLedger }`。workbench・task・job は載せない。`openTab` の `input` は shell に打鍵されるので、token の無い口では任意のコマンドになる。
  - 画像の素の GET（`/api/assets/<file>`、`@tania/note/contract` の `IMAGE_URL_PREFIX`）。今は 404 を返す。
  - SPA の静的ファイル。`/rpc` と画像以外の GET は、build の出力に在る file ならそれを、無ければ `index.html` を返す。path は file system の path として解かず、起動時に集めた file の一覧から引く。`assets/` の下（Vite が hash を付けた file）は `public, max-age=31536000, immutable`、ほかは `no-cache`。
- SPA は compiled binary に `--asset` で同梱した `apps/web/dist` を、entry の隣（`/$bunfs/root/dist`）から読む（`docs/packages/dev-loop.md` の「release build と install」）。`bun run` の Backend には無いので、dev の Backend は SPA の GET に 404 を返し、画面は `apps/web` の Vite が配る。

## テスト

- 組み立ては、Shell と同じく process として起こし、fake の ptyd の home を渡して確かめる（`docs/packages/workbench-ledger.md` の「テスト」）。token の口と notes の口に同じ path を投げ、口ごとに載る procedure を見る。
- notes の口の照合と SPA は `listenNotes` を直に呼んで確かめる。
