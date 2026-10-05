# パッケージ構成と dev loop

tania の repo の形、package の entry、domain 間の呼び出し、CLI の組み立て、dev と release の手順を決める。骨格を実装するときに最初に読む文書で、実装が進んだらここを今の形に合わせて直す。決定の理由は `docs/adr/` にある（とくに ADR-0002 / 0003 / 0006 / 0009 / 0010 / 0011）。出発点は branch `prototype/stack`・`prototype/workbench`・`prototype/terminal-session` で、骨格の実装 issue は #25 の sub-issue。

## 配置

```
tania/
├── package.json        workspaces・catalog・packageManager・scripts
├── tsconfig.json       1 つだけ
├── Cargo.toml          Rust の workspace（crates/* と apps/desktop/src-tauri）
├── .claude-plugin/     plugin.json・marketplace.json（ADR-0006）
├── scripts/            desktop.ts・dev-instance.ts・dev.ts・build.ts・install-app.ts・tania-dev
├── apps/
│   ├── backend/        @tania/backend   Backend の組み立て
│   ├── cli/            @tania/cli       bin は tania
│   └── desktop/        @tania/desktop   src/ が webview、src-tauri/ が Shell
├── packages/
│   ├── workbench/      @tania/workbench
│   ├── task/           @tania/task
│   └── ui/             @tania/ui        domain を持たない UI 部品
└── crates/
    ├── terminal-protocol/
    ├── terminal-daemon/
    ├── terminal-client/
    ├── ptyd/
    └── logfile/
```

- apps は packages を組み立てるだけでロジックを持たない（ADR-0002）。apps どうしは互いを import しない。
- Rust の `target/` と `Cargo.lock` は root に 1 つ。crate 名は `tania-<dir>`（`tania-ptyd` など）。terminal 5 crate は monica から rename だけで持ち込む（#11）。
- `packages/ui` は popover・icon・toast・fuzzy picker・drag reorder のような、domain の語を持たない部品を置く。CLI の整形関数が使う表（`@tania/ui/table`）もここに置く。cli entry は apps/cli だけが import するので、domain の cli entry どうしでは共有できないため。domain の UI は各 domain package の `ui` entry に置く。

### ドメイン package の中

```
packages/<d>/
├── package.json
├── drizzle.config.ts      out: "./migrations/<d>"
├── migrations/
│   ├── index.ts           { folder, table } と _journal.json の import
│   └── <d>/               drizzle-kit generate の出力
├── skills/<name>/SKILL.md
└── src/
    ├── schema.ts
    ├── contract.ts
    ├── server.ts
    ├── cli.ts
    └── ui/index.ts
```

entry より内側のファイル分割は自由。

## entry

entry は層ではなく、import してよい実行環境で切る（ADR-0009）。root の `"."` は置かない。

| entry | 中身 | 実行環境 | import する側 |
|---|---|---|---|
| `@tania/<d>/schema` | drizzle の table。`drizzle-orm/sqlite-core` と `drizzle-orm` 本体（部分 index の条件を書く `sql`）だけを import する | どこでも | 自分の contract と server、他 package の schema（FK）と server（SELECT） |
| `@tania/<d>/contract` | oRPC の contract、zod schema、型 | どこでも | apps/desktop（型だけ）、apps/cli、自分と他 package の server と ui と cli |
| `@tania/<d>/server` | router、`create<D>()`、migrations の re-export | Bun | apps/backend、他 package の server、テスト |
| `@tania/<d>/ui` | React の component と atom | browser | apps/desktop、他 package の ui |
| `@tania/<d>/cli` | 出力の整形関数と手で書く command | Bun | apps/cli |

- 依存の向きは task → workbench だけ。workbench は task を import しない（ADR-0005）。bun の isolated linker では package.json に書いていない依存を解決できないので、向きは package.json が守る。package の中の entry の境界（schema が import してよいもの、ui が server の entry と `bun:sqlite` を import しないこと、cli entry を import するのが apps/cli だけであること）と apps どうしの向きは、`.oxlintrc.json` の overrides が lint で守る。CLI と webview で動くコード（apps/cli、apps/desktop、各 package の cli entry と ui entry）が DB に触るもの（`bun:sqlite`、`drizzle-orm`、schema entry と server entry の値）を import しないことも同じく守る（ADR-0003）。cli entry で見るのは `cli.ts` の import だけで、`cli.ts` が import する内側のファイルは見ない。apps/cli のテストと `testing.ts` は in-memory の Backend を組むので、この制限から外す。
- task の schema は workbench の table を FK のために import するが、re-export しない（ADR-0010）。
- webview の bundle に `bun:sqlite` や `@orpc/server` が混ざっていないかは `vite build` で確かめる。混ざれば解決に失敗して落ちる。型だけの import は消えるので対象外。

## domain 間の呼び出しと Backend の組み立て

### server entry の形

```ts
// @tania/workbench/server
export { migrations } from "../migrations";
export const router = os.router({ ... });          // context は { db, workbench }
export function createWorkbench(deps: {
  db: Db;
  home: string;
  ptydPath: string;
  notify: (n: { title: string; body: string }) => void;
  nameAgentSession: (db: Db, agentSessionId: string) => string | null;
}): Workbench;

// @tania/task/server
export { migrations } from "../migrations";
export const router = os.router({ ... });          // context は { db, task }
export function createTask(deps: {
  db: Db;
  workbench: Workbench;
  home: string;
  github?: GitHub;
  ghq?: Ghq;
}): Task;
export function nameAgentSession(db: Db, agentSessionId: string): string | null;
```

`ptydPath` は spawn する ptyd の場所（ADR-0011）。`notify` と `nameAgentSession` は通知のための口（「通知」の節）。`github` は GraphQL の URL と token の取り方で、省けば `https://api.github.com/graphql` と `gh auth token --hostname github.com` になる。task の `home` は Bench の worktree と setup の log を置く場所（「Task の帳簿」の Bench）。`ghq` は `root()` と `get(repo)` で、省けば `ghq` の command を呼ぶ。テストは偽の GitHub と ghq を渡す。

`Workbench` と `Task` は次を持つ。

- `events`: その domain の変更を知らせる in-process の publisher。
- `start()` / `stop()`: 起動時と終了時の処理。workbench は ptyd への接続（無ければ spawn、版違いは入れ替え）と reconcile（ADR-0011）、task は起動時と 5 分おきの背景 sync（#18）、起動時に preparing のまま残った Bench を失敗にすることと、終了時に走っている setup の process group を kill すること。
- 他の domain から呼ばれる書き込み: 第 1 引数に transaction（`db` でもよい）を取る**同期**の method。task は `db.transaction((tx) => { workbench.moveTab(tx, …); insertRun(tx, …) })` のように、両 domain の書き込みを 1 つの transaction にまとめる。ptyd や fs への副作用は transaction に入らないので別の async method にし、呼び手が commit の後に呼ぶ。workbench の同期 method は `createRunspace` / `removeRunspace` / `moveTab` / `openTab`、commit 後の async は `startTerminalSession` / `writeTerminalSession` / `terminateTerminalSessions`（#22）。`Workbench` に出ているのはこの 7 つと、reconcile を待つ `ready()`。他の domain が呼ばない書き込みは、同じ形（第 1 引数が tx）の module 内の関数として procedure の handler から呼び、`Workbench` には出さない。`createRunspace(tx, { cwd })` が作るのは Tab の無い所有された Runspace で、`removeRunspace(tx, id, { spare? }) → terminalSessionId[]` はそれを消し、中の Tab の Terminal Session を返す。`spare`（Terminal Session の配列）の Tab が中にあれば、Runspace を消さずに所有を解いてそれらの Tab だけを残し（pin されていれば pin のまま）、ほかの Tab の Terminal Session を返す（ADR-0012）。返した Terminal Session は、呼び手が commit の後に `terminateTerminalSessions(ids)` で終わらせる。ptyd の Terminate は冪等で、終わった session に送っても失敗しない。

`openTab` が書く `starting` の Terminal Session の行は、workbench の reconcile が終わってから書く。reconcile の途中で書くと、ptyd の List に無い行として lost にされる。workbench の handler は、行に書く shell を reconcile を待ってから返す `shellWhenReady(workbench)` を transaction の前に await する。他の domain は transaction の前に `workbench.ready()` を await してから、`openTab(tx, { runspaceId, cwd? }) → { tabId, terminalSessionId }` を呼ぶ。`openTab` は shell を自分で埋め、`{ type: "layout" }` を publish する。`moveTab(tx, tabId, runspaceId)` は Tab を Runspace の末尾へ移し（`tab.move` と同じ規則）、`{ type: "layout" }` を publish する。`writeTerminalSession(id, data)` は ptyd に Write を送る。ptyd は attach していない接続からの Write も通すので、webview が Tab を表示していなくても打てる。

他の domain から呼ばれない処理は router の handler の中に書いてよい。

### domain をまたぐ規則

- **書き込み**は相手の domain の method を通す。相手の table に直接 INSERT / UPDATE / DELETE しない。lint の `tania/cross-domain-write` が、`@tania/<d>/schema` から import した table を `insert` / `update` / `delete` に渡す形を止める（テストと fixture は除く）。
- **読み出し**は相手の table を `@tania/<d>/schema` で直接 SELECT してよい。表示状態（#17）や ActiveRun guard のように Agent Session と Run を join する読み出しを procedure 経由にすると N+1 になるため。
- **event は「変わった」の合図**で、購読側は payload を信じず DB を読み直す。bun:sqlite の transaction は同期なので、tx の中で publish しても購読側が動くのは commit 後の microtask になる。rollback されても読み直すだけで害が無いので、commit 後に publish する仕組みは作らない。
- workbench の router を in-process client（`createRouterClient`）で呼ぶ形は採らない。oRPC の呼び出しは async で、drizzle の bun:sqlite の transaction に async 関数を渡すと throw しても rollback されないため（ADR-0009）。
- transaction に async 関数を渡さない。lint の `tania/sync-transaction` が、関数式と、同じ file で定義した async 関数を名前で渡す形を止める。

### Backend の組み立て（`apps/backend/src/main.ts`）

最初に login shell から PATH を 1 回取り（`$SHELL -ilc` で区切り文字に挟んだ `$PATH` を出させる。cwd は `$HOME`、`DISABLE_AUTO_UPDATE=true`）、`process.env.PATH` に入れる。`.app` から起動した Backend は launchd の最小の PATH しか持たず、`gh`・`git`・`ghq`・setup script の中の bun や mise が見つからないため。失敗したら元の PATH のまま stderr に 1 行出す。login shell は stdin を渡さずに起こし（Backend の stdin は Shell の死を知らせる pipe）、5 秒で打ち切る。

Bun.spawn は `env` を渡さないと、子に起動時の environ を渡し、実行ファイルも起動時の PATH で探す。そのため Backend で動くコードの spawn は `env: process.env` を渡す（絶対 path の実行ファイルは除く）。lint の `tania/spawn-env`（`scripts/oxlint/tania.js`）がこれを守る。ptyd は `process.env` から組んだ env を渡すので、Tab にも届く。

1. `$TANIA_HOME/tania.db` を開き、`locking_mode=EXCLUSIVE` → `journal_mode=WAL` → `foreign_keys=ON` の順に設定する（ADR-0007）。
2. `migrate()` を workbench → task の順に呼ぶ。`migrationsTable` は各 package の `migrations.table` を渡す。
3. `createWorkbench` → `createTask` の順に作る。`createWorkbench` には、env の `TANIA_PTYD_PATH`（`ptydPath`）、stdout に通知の行を書く `notify`、`@tania/task/server` の `nameAgentSession` を渡す。`createTask` には同じ `home` を渡す。`TANIA_PTYD_PATH` が無ければ stderr に 1 行出して exit 1 する。
4. router を `{ workbench: workbenchRouter, task: taskRouter }` で mount し、context は `{ db, workbench, task }`。
5. hono に CORS（`tauri://localhost`・`http://tauri.localhost`。env の `TANIA_DEV_URL` があればその origin も。「dev loop」の節）、`/health`（token 無し）、`/rpc/*` の bearer を載せ、`Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 })` で立てる。
6. `start()` を workbench → task の順に呼ぶ。workbench の `start()`（ptyd への接続と reconcile）を最大 3 秒待ってから、`backend.json` と stdout の endpoint 行を書く（ADR-0007 / 0011）。
7. 終了時は `stop()` を逆順に呼んでから ADR-0007 の手順で抜ける。

domain は 2 つしかないので、汎用の「domain の登録」機構は作らずに直接並べる。

### テスト

package ごとに in-memory の SQLite に自分の migration を当てる（task は workbench → task の順）。外から見える振る舞いは `createRouterClient(router, { context })` を通して確かめ、他の domain から呼ばれる method と module 内の関数（`openTab` など）はそのまま呼ぶ。DB を fake に差し替えない（ADR-0002）。`bun test` を root で打つと全 package のテストが走る。

- workbench の ptyd は `packages/workbench/src/fake-ptyd.ts` に差し替える。fake は `$home/ptyd.sock` で NDJSON を話し、List の中身を台本にし、Exit を押し込み、届いた Reap と Terminate を記録する。本物の ptyd は CI の ts job に無く、Exit と Created の競合も決まった順で起こせないため。home は `mkdtemp(tmpdir())` で短くする（socket の path の上限は 104 byte）。
- task の GitHub は `packages/task/src/fake-github.ts` に差し替える。fake は GraphQL の `repository { issue(number:) }` の alias だけを話し、届いた request を記録し、repo ごとの失敗、未認証、応答の保留を起こせる。CLI のテストの Task は `gh auth token` が失敗する GitHub を持ち、本物の GitHub に届かない。
- task と CLI のテストの Workbench は、ptyd に送る口（`ready`・`startTerminalSession`・`writeTerminalSession`・`terminateTerminalSessions`）を `spyOn` で記録だけに差し替える。fake の ptyd は workbench の entry の外にあり、他の package から import できないため。DB と `openTab` は本物を通す。
- task の ghq は `packages/task/src/fake-ghq.ts` に差し替える。CI の ts job に ghq は無い。fake は一時 directory の `origins/<owner>/<repo>` を origin（default branch は main）にし、`get` でそれを clone して記録する。Bench の準備は本物の git で確かめる。CLI のテストの Task は失敗する ghq を持つ。
- setup の 600 秒の timeout は、`setTimeout` を `spyOn` してその callback を捕まえ、手で呼ぶ。
- await の間の競合は、await の途中で止めて決まった順で起こす。sync の途中は fake GitHub の `hold()`、git の ref の更新（`branch -D` など）の途中は checkout の `.git/hooks/reference-transaction` が file を待つ script、ptyd に送る口の途中は `spyOn` が返す保留の Promise で止める（`close.test.ts`）。
- 一定の間隔で走る処理は、`setInterval` を `spyOn` で捕まえ、間隔を確かめてから callback を手で呼ぶ。Bun の `jest.useFakeTimers()` は `Bun.sleep` と `setTimeout` も止め、一部の timer だけを偽にできないので、HTTP の応答を待つテストが進まなくなる。
- 終わった行のように procedure に出ない行は、`@tania/workbench/schema` の table を SELECT して確かめてよい。他の domain が読むのと同じ面だから。
- CLI は remote client を `createRouterClient` に差し替えて回す（ADR-0003。fixture は `apps/cli/src/testing.ts`）。Backend 側のエラーの形と接続拒否の retry だけは、router を `Bun.serve` に載せて確かめる。in-process の client は handler の生の Error を投げ、HTTP のように `ORPCError`（`INTERNAL_SERVER_ERROR`）に包まないため。
- hook の CLI（`tania workbench hook claude`）は例外で、`apps/cli/src/main.ts` を subprocess で起こし、router を `Bun.serve` に載せて確かめる。claude から見た約束（stdin の payload、stdout の allow、exit code）と 2 秒の打ち切り、trpc-cli より前の振り分けは、process の外からしか見えないため。

## contract の規約

1. 合成した contract の root は package 名で mount する（`{ workbench, task }`）。path の先頭が package 名になり、CLI もそれに従う（`tania task track`、`tania workbench hook claude`）。
2. 全 procedure に `.meta({ description })` と `.output()` を付ける。description は CLI の help の正本、output は `--format json` の形の正本になる（#17 の JSON の形もここに書く）。
3. CLI に出すのは `.meta({ cli: true })` を付けた procedure だけ（ADR-0003）。event iterator の procedure は付けても出ない。
4. 呼び手が分岐する domain エラー（close の guard のように `data` に理由の一覧を持つもの）だけを `.errors()` で宣言する。それ以外は oRPC の標準 code（`NOT_FOUND`、`BAD_REQUEST`）を投げる。
5. 変更の stream は domain ごとに 1 本（`workbench.changes`、`task.changes`）で、判別 union の event を流す。中身は `events` と同じ合図。合図は、その domain の procedure の output が変わる経路すべてで出す。stream だけを購読して読み直す client が、古い output を持ったまま残らないようにするため。他の domain の行から導く output（task の表示状態は workbench の Agent Session から導く）は、相手の合図を受けて自分の合図を出す。
6. `oc.meta(...)` と `createSchemaFactory({ coerce: { date: true } })` は各 package の `contract.ts` の中にだけ書く。oRPC 2.0 で `.meta` が plugin 制になったときに直す場所を 1 つにするため（#21）。例外は `apps/cli/src/forward.ts` で、output を持たない procedure を組み直すために contract の meta を `os.$meta` で引き継ぐ（「CLI（apps/cli）」の節）。

contract を走査するテストを 1 本置き、description と output が全 procedure にあること、`cli: true` の procedure に整形関数があることを確かめる。

## migration

- 各 package が `drizzle.config.ts` を持ち、`out: "./migrations/<d>"` に生成する。`bun run generate` が全 package の `drizzle-kit generate` を走らせる。
- `migrations/index.ts`:

  ```ts
  import { join } from "node:path";
  import journal from "./workbench/meta/_journal.json";

  const entries: { tag: string }[] = journal.entries;

  export const migrations = {
    folder: join(import.meta.dir, "workbench"),
    table: "__drizzle_migrations_workbench",
    latest: entries.at(-1)?.tag,
  };
  ```

  journal の import は、generate の出力を `bun --watch` の import 木に入れるためにある（#8 の詰まった点 3）。`entries` に型を付けるのは、table が 0 本の package の journal（`entries: []`）を tsc が `never[]` と推論するため。
- table が 0 本の package（骨格の task）は、0 本のまま `drizzle-kit generate` を 1 回走らせ、出てきた `meta/_journal.json`（`entries: []`）を commit する。`migrate()` はこれで何もせずに通り、後で table を足せば普通に `0000_*.sql` ができる。custom migration は作らない。bun:sqlite はコメントだけの SQL を `Invalid SQL statement` で落とす。
- 履歴 table は package ごとに分ける。既定の `__drizzle_migrations` を共有すると、drizzle は `created_at` の大小しか比べないので、片方の migration が黙って飛ばされる。runtime の `migrate()` には `migrationsTable` を必ず渡す（drizzle.config の `migrations.table` は `drizzle-kit migrate` にしか効かない）。
- folder の basename は domain 名にする。`--asset` は basename の位置に mount するので、2 つの `drizzle/` を同梱すると `meta/_journal.json` が衝突して build が落ちる。
- compiled binary ではどの module の `import.meta` も entry のものになるので、package の中で `new URL("../drizzle", import.meta.url)` と書くと壊れる。folder の親に置いた `migrations/index.ts` の `import.meta.dir` を使えば、`bun run` でも compiled でも同じ source で動く。
- task の snapshot に task の table しか無いことをテストで確かめる（workbench の table を re-export すると二重に CREATE される）。

## CLI（apps/cli）

- CLI は Backend と別の compiled binary（ADR-0003）。
- `src/main.ts` は argv を見て、各 package の `cli` entry が export する手書き command（`{ path, description, run }`）に当たればそれを実行する。当たらなければ trpc-cli を dynamic import し、contract の `cli: true` の葉から CLI を組む。hook は tool 1 回ごとに起動するので、trpc-cli と contract の実体を import する前に振り分ける（compiled で約 46ms → 約 18ms）。
- `src/backend.ts` が Backend の探索（`backend.json` の読み出し、不在時の即 exit 2、接続拒否時の 200ms × 3 秒 retry。ADR-0007）と `RPCLink` の生成を 1 箇所で持つ。手書き command には `connect({ retry? }): Client | null` として渡す。hook は `retry: false` で呼び、接続拒否でもすぐ諦める。
- 転送 router（`src/forward.ts`）は contract を走査し、`cli: true` の葉を「remote を呼ぶ → 整形して出力する → `undefined` を返す」handler に置き換える。`undefined` を返すので、trpc-cli の YAML / 表の logger は何も出さない。
- input に `terminalSessionId` を持つ procedure（`current`、`attach`、`close`）には、転送 router が env の `TANIA_TERMINAL_SESSION_ID` を埋める。flag には出さない。
- `--format text|json` は `buildProgram` で global option として足す（既定は text）。json は procedure の output をそのまま出す。text は `@tania/<d>/cli` の整形関数を procedure の path で引く。整形の識別子は英語（#17）。
- エラーは常に stderr に 1 行 `CODE: message` を出す。trpc-cli は `ORPCError` を cause に剥がして表示し、remote 由来の `ORPCError` は cause を持たないので、転送 handler が `` new Error(`${code}: ${message}`, { cause }) `` に包んで投げ直す（#8 の詰まった点 1）。stack を出さないよう trpc-cli の `formatError` で message だけにする。`--format json` のときも stdout には成功時の output だけを出す。
- exit code は 0 = 成功、1 = それ以外の失敗、2 = Backend 不在。trpc-cli は usage エラーも handler の throw も 1 で `process.exit` を自分で呼ぶので、`run({ process: { exit } })` で差し替え、投げ返される `FailedToExitError` を catch して写像する。
- `prompts: false` を固定する。
- completions は trpc-cli の生成に任せる（#12）。
- hook の受け口は `tania workbench hook claude`（`@tania/workbench/cli` の手書き command）。仕様は「tab の env と shim」の節。
- SKILL.md と CLI を突き合わせる検査テストは apps/cli に置く（ADR-0006。`skill-check.test.ts`）。`createProgram` が組む commander の木を辿って command path と flag 名を引くので、procedure を呼ばず、Backend も要らない。
  - 検査する command は、`bash` か `sh` の fence の中で `tania` から始まる行と、本文のインラインの `tania …`。長い fence の中の fence は例なので見ない。行の `#` から後ろは shell と同じく comment として外す。
  - 親の option（`--format`）と `--help` は、commander と同じく子の後ろでも受ける。
  - 手書き command（`tania workbench hook claude`）は contract から生えず、Skill も呼ばないので、木に無く、書けば落ちる。
  - plugin.json の `skills` は、Skill を持つ `packages/*/skills` とちょうど一致させる。Skill の無い directory を載せても落ちる。workbench の `skills` は Skill ができたときに足す。
- oRPC 2.0 で `RPCLink` の引数が変わったときに直すのは `apps/cli/src/backend.ts` と `apps/desktop/src/backend.ts` の 2 箇所だけ（#21）。

## desktop（apps/desktop）

- `src/` は app の枠だけを持つ。shortcut、Backend client の provider、Shell からの `backend-endpoint` event による再接続、Backend 不在の表示、toast。domain の画面は `@tania/<d>/ui` から読む。Workbench の画面（sidebar・Tab の帯・端末の並び）は `@tania/workbench/ui` の `Workbench` が持ち、`client.workbench` を props で受けて、endpoint が替わるたびに `workbench.changes` を購読し直す。
- ⌥ のキーは xterm に渡さず（`buildKeyEventHandler`）、shortcut だけが拾う。shortcut の binding が `false` を返して素通しした ⌥ のキーも、端末には届かない。
- ⌘ と 1 文字のキーの組み合わせも xterm に渡さず、ブラウザの copy と paste に任せる。kitty の flag を立てた app には、xterm が ⌘ を super として送り（⌘V なら `CSI 118;9u`）、イベントを cancel するので、copy と paste が起きなくなるため。xterm が legacy の encode で持っていた ⌘A の全選択は、webview が `selectAll` を呼ぶ。⌘Enter や ⌘Backspace のように legacy でもバイト列を送っていたキーは、xterm に任せる。
- kitty keyboard protocol は xterm に任せる（`vtExtensions.kittyKeyboard`）。flag の stack、`CSI ?u` への返答、キーの encode はどれも xterm が行い、webview の parser は kitty の CSI に触らない。
  - ptyd は Tab に `TERM_PROGRAM=WezTerm` を渡す。claude はこれを見て起動時に kitty の flag を push し、Shift+Enter を改行として受け取る。flag が立っている間、claude は Ctrl+V を `CSI 118;5u` の形でしか受け取らない。flag は app ごとに立つので、shell の Tab と claude を抜けた後では、Shift+Enter は `\r`、Ctrl+V は `\x16` のまま送られる。
  - kitty keyboard protocol は xterm 6.1 にしかないので、`@xterm/xterm` と addon 3 つを 6.1 の beta に完全に固定している（`^` を付けない）。版は #60 の prototype で確かめたもの。6.1 の stable が出たら移る。
- Backend の endpoint の受け取りと不在の表示:
  - 起動時は Shell の `backend_endpoint` command で今の endpoint（無ければ null）と再起動を諦めたかどうか（`{ endpoint, failed }`）を取り、以降は `backend-endpoint` と `backend-failed` の event で受ける。listen する前に出た event を取りこぼさないため。諦めたかどうかも取るのは、諦めた後に reload した webview が「再試行」を出せるようにするため。
  - Shell は Backend の予期しない終了で endpoint を捨てたら、`backend-endpoint` に null を載せて出す。再起動を諦めたら `backend-failed` を出す（ADR-0007）。
  - webview は endpoint が 1 秒以上 null のままなら、Workbench の上端に 1 行「Backend に再接続中…」を出す。`bun --watch` の再起動（約 100ms）でちらつかないよう 1 秒待つ。`backend-failed` では「Backend を起動できません」と「再試行」を出し、再試行は Shell の `backend_restart` command（失敗回数を戻して spawn する）を呼ぶ。
  - 端末の byte は Shell を通るので、Backend が居ない間も打鍵と出力は続く。画面を塞がず、layout を変える操作だけが toast で失敗する。
- domain の ui には自分の contract の client だけを渡す（workbench の ui は `client.workbench`）。oRPC の client は callable な Proxy なので、React の state に入れるときは `setState(() => client)`（#8 の詰まった点 5）。
- Shell の terminal command と `clipboard_write_image` を呼ぶ wrapper（monica の `commands/terminal.ts`）は `packages/workbench/src/ui` に置く。
- 画像の drop は、Tauri の drag-drop event の paths から画像の拡張子を持つ最初の 1 つを `clipboard_write_image` に渡し（monica どおり。画像が無ければ何もしない）、成功したら active な Tab の xterm の入力欄に Ctrl+V の `keydown` を渡す。Ctrl+V で clipboard の画像を読むのは agent の振る舞いなので、Shell の command にまとめない。失敗したら `packages/ui` の toast で 1 行出す（monica は黙っていた）。
  - Ctrl+V は `terminal_write` で決まったバイト列にせず、xterm に encode させる。monica の `\x16` は kitty の flag を立てた claude に無視される。xterm に任せれば、drop は flag の状態を知らなくて済む。
- Workbench の画面が使う、Shell に置かない monica の command は `workbench` の procedure にする（`cli: true` は付けない）。
  - `worktree.info({ cwd })` → `{ repo, branch } | null`: `git -C <cwd> rev-parse --abbrev-ref HEAD --path-format=absolute --git-dir --git-common-dir`。linked worktree のときだけ値を返し、`repo` は common dir の親の名前。Runspace の title（`repo:branch`）に使い、webview は path ごとに cache して 5 秒で間引く。
  - `editor.resolve({ cwd, candidates })` → `(string | null)[]`: `~` を展開し、相対なら cwd に join して `realpath` する。失敗したら末尾の `:<数字>` を最大 2 つ外して再試行する。terminal の link 検出が hover のたびに 1 行分をまとめて呼び、null の候補は link にしない。
  - `editor.open({ path })` → `void`: `/usr/bin/open -a Zed <path>`。Zed は固定で、line:col は渡さない。webview は失敗を握りつぶす。
- URL を開くのは webview から plugin-opener の `openUrl` で行う（http(s)・mailto・tel）。
- workbench の ui は Task の要素を出す場所を 2 つの slot として props で受け、apps/desktop が `@tania/task/ui` の component をはめる。workbench の ui は Task を import しない（ADR-0005）。
  - `renderRunspaceLabel(runspaceId)`: Bench のラベル `<repo>#<n> <title>`。準備中・準備失敗のときだけその語を添える。workbench は所有された Runspace にだけ呼び、null なら普段の title を出す。task の ui は `task.bench.list`（`{ runspaceId, ref, title, setupState }[]`）と `task.changes` で描き直す。
  - `tabMenuItems(tab, close)`: Tab のメニューの「New shell here」と「Terminate」の間に出す項目。`tab` は `{ id, terminalSessionId }`。`close` はメニューを閉じる。task の ui はメニューを開くたびに `task.list` と `task.current({ terminalSessionId })` を読み、current の `source` が `run`（Tab の claude がどこかの Task の Run）なら何も出さない。current は closed な Task の Run も引くので、close を頼んだ claude が残った Tab にも出さない。NOT_FOUND は Run でも Bench でもない Tab なので出す。それ以外なら区切り線と「Attach to Task…」を出し、選ぶと picker を開く。picker は open な Task を `tracked_at` の新しい順に並べ、`<repo>#<n> <title>` と表示状態（CLI の STATE の 1 マスと同じ形）を出し、選ぶと `task.attach` を呼ぶ。失敗は toast で 1 行出す。
  - picker はメニューの外へ portal で出るので、`@tania/ui` の `PopoverMenu` は、どのメニューの中での押下と scroll も外側として扱わない。開いているメニューは、そのメニューとそこから開いたメニューだけだから。
- Tailwind の `@source` に `packages/*/src/ui/**/*.{ts,tsx}` と `packages/ui/src` を足す。glob を含む path は file の pattern として読まれるので、directory で止めると何も拾わない。
- `src-tauri/` は Shell。Backend の監督（ADR-0007）、terminal の中継、OS への窓口だけを持つ。窓口は通知（ADR-0013）、画像の clipboard、plugin-opener、drag-drop の event。custom command は terminal の attach / detach / write / resize の 4 本（ptyd は spawn しない。ADR-0011）、`clipboard_write_image`、`backend_endpoint`、`backend_restart` の 7 本。
- 窓は monica どおり title bar を webview に重ね（`titleBarStyle: "Overlay"`、`hiddenTitle`、`trafficLightPosition { x: 16, y: 22 }`）、`transparent` と `windowEffects: sidebar` で背後を透かす（`transparent` には `macOSPrivateApi` と tauri の `macos-private-api` feature が要る）。webview は信号機の分を `@tania/ui` の `TRAFFIC_LIGHT_ZONE_*` で空け、sidebar の見出しと Tab の帯を `data-tauri-drag-region`（`core:window:allow-start-dragging`）にする。
- Shell に置くのは、Tauri プロセスにしか無いもの（窓と webview の event、app の名義、AppKit）に触る処理と、Backend の再起動で途切れてはいけない terminal の byte だけ（ADR-0001）。fs と process の spawn で済む処理（worktree の判定、エディタ）は Backend の procedure にする。
- 例外は `tania` の symlink（「dev loop」の節）で、Shell が起動時に張る。CLI の実体の場所（release は `.app` の中、dev は `TANIA_BIN`）と、release だけが `~/.local/bin` に張るという区別が、どちらも Shell の build で決まる事実だから。
- Shell は Backend を自分と別の process group で起こす。端末の Ctrl-C を Backend が直接受けると `backend.json` を残したまま死ぬので、Shell の死は stdin の EOF で知らせる。
- `clipboard_write_image(path)` は monica の objc2 の実装（`NSImage::initWithContentsOfFile` を general pasteboard に `writeObjects`）を持ち込む。NSPasteboard は main thread で呼ぶので、sync command のままにする。

## Workbench の帳簿

`packages/workbench` の contract と行の規則。table の下書きは #22 の resolution、Agent Session の遷移表は #36 の resolution にある。

### contract（root は `workbench`）

```
terminalSession.list       → TerminalSession[]（tabId を join）                               cli
terminalSession.terminate  { id }
layout.get                 → { runspaces: [{ id, cwd, sortOrder, owned,
                                 tabs: [{ id, cwd, sortOrder, terminalSessionId, pinned }] }] }
runspace.create            { cwd?, index?, rows, cols } → { runspaceId, tab }
runspace.remove            { id }                      中の Tab の session を terminate
runspace.move              { id, index }
tab.open                   { runspaceId, cwd?, index?, rows, cols, terminalSessionId? } → Tab
tab.respawn                { id, rows, cols } → Tab
tab.close                  { id }                      session は detached になる
tab.move                   { id, runspaceId, index }
tab.setCwd                 { id, cwd }
tab.pin / tab.unpin        { id }
agentSession.recordHook    { terminalSessionId, payload } → void
agentSession.list          → AgentSession[]                                                    cli
worktree.info              { cwd } → { repo, branch } | null
editor.resolve             { cwd, candidates } → (string | null)[]
editor.open                { path } → void
changes                    → { type: "layout" } | { type: "terminalSession", id }
                             | { type: "agentSession", sessionId } | { type: "reconciled" }
```

- 各 procedure の規則は下の節と、`tab.open` / `tab.respawn` / `terminalSession.*` は #22 の resolution、`recordHook` は「tab の env と shim」の節、`worktree.*` / `editor.*` は「desktop」の節にある。
- `recordHook` の CLI は手書きの `tania workbench hook claude`。`agentSession.list` の CLI（`tania workbench agent-session list`）は、画面無しで観測を確かめるためにある。
- `owned` は他の domain が `createRunspace(tx, { cwd })` で作った Runspace の印（ADR-0012）。規則は「Runspace と Tab」と「pin」の節にある。
- `terminal_session.shell` は Backend の起動時に 1 回決める。`$SHELL`、無ければ `os.userInfo().shell`、それも無ければ `/bin/zsh`。reconcile で ptyd から取り込んだ行は `""`。

### Runspace と Tab

所有されていない Runspace は常に Tab を 1 つ以上持ち、Backend がそれを守る（`GLOSSARY.md` の Runspace）。所有された Runspace（Bench）は Tab が 0 でも残り、Workbench の操作では消えない。`runspace.remove` は `CONFLICT` で断り、GUI に remove は無い。消すのは作った側の `removeRunspace`（Task の close、slice 5）だけ（ADR-0012）。

- `sort_order` は、Runspace と Tab を足す・移す・消すたびに、同じ transaction の中で兄弟を 0..n-1 に振り直す。`runspace.create` と `tab.open` の `index` を省けば末尾に足す。webview は active の次を渡し（monica どおり）、CLI と Task は省く。
- Tab の title は帳簿に持たない。OSC 0/2 の title は webview の memory にだけ持ち、再 attach のときは transcript の replay に含まれる OSC で戻る。表示は monica どおり title、無ければ cwd の末尾、それも無ければ `Terminal`。title はよくある zsh の theme なら command のたびに変わり、帳簿に書くとそのたびに `changes` と `layout.get` が往復するため。
- 再 attach の replay は transcript の末尾 256 KB だけを流す。そこから落ちたモード（alt screen、マウス、bracketed paste、kitty keyboard の stack など）は、ptyd が replay の前に流し直す。追うモードと理由は `crates/terminal-daemon` の `TerminalModes` の module doc にある。webview の parser がそのモードの CSI を握りつぶすと、この流し直しも効かない。
- `tab.respawn` は exited / lost / failed の Tab に新しい session を結び直す。overlay の「New shell in …」と「Retry」が呼ぶ（monica どおり）。
- `tab.cwd` は最後に分かった cwd。webview は OSC 7 の cwd が前の値と変わったときだけ `tab.setCwd` を呼ぶ（OSC 7 は prompt のたびに来る）。OSC 7 を出さない shell のため、OSC 0/2 の title が `/` で始まるか `~`・`~/…` なら、それも cwd の知らせとして扱う（monica どおり。`~user` や zsh の named directory は Backend が絶対 path にできないので取らない）。ただし一度でも OSC 7 を出した Tab では title を cwd に使わない（title の `~/repo` と OSC 7 の `/Users/…/repo` が交互に「変わった」ことになるため）。`tab.setCwd` は `~` を home に展開して絶対 path で持つ。Backend の張り直し（「pin」の節）と `tab.respawn` はこの cwd で始め、Runspace の title（`worktree.info`）も再起動の直後はこれを使う。

- `runspace.create { cwd?, rows, cols } → { runspaceId, tab }` は、Runspace・Tab・`starting` の Terminal Session を 1 transaction で作り、commit 後に Create する（`tab.open` と同じ形）。cwd を省けば `$HOME`。空の Runspace を作ってから `tab.open` を呼ぶ 2 段にすると、間で webview の reload や Backend の再起動が起きたときに空の Runspace が残り、消す規則が無いため。
- `tab.open` の cwd を省けば、新しい Terminal Session は Runspace の cwd で始める。reattach の Tab は Terminal Session の cwd を持ち、OSC 7 の `tab.setCwd` で追いつく。
- Task の close の後に残った Runspace と Tab の cwd は、消えた worktree を指すことがある。ptyd は cwd が directory でなければ shell を `$HOME` で起こす（portable-pty の `CommandBuilder` がそうする）ので、Backend は cwd を確かめずに渡す。Tab の cwd は OSC 7 で追いつく。
- `tab.close` と `tab.move` は、Tab が抜けて 0 になった所有されていない Runspace を同じ transaction で消す。CLI の Attach のように webview の無い経路でも、空の Runspace が残らない。所有された Runspace は 0 になっても残す。
- layout が空になったら、webview が `runspace.create` で 1 つ作る（monica の `initialState()`）。
- webview は header の Tab を sidebar の Runspace の行に drop すると、`tab.move` でその Runspace の末尾へ移す（monica に無い操作）。
- 手前に見えていた Tab が、layout を読み直したら別の Runspace に居れば、画面も移った先へついていく。drop、pin の切り出し、Attach（CLI と picker）のどれで移っても同じ。CLI の `tania task attach` は手前の Tab で打つことが多く、ついていかないと打った端末が画面から消えるため。
- shell が終わった Tab は webview が閉じる。接続中の Tab で Shell の Exit を受けたら、webview が `tab.close` を呼ぶ（monica どおり）。Backend は行を exited にするだけで、Tab を閉じない。exit の時点で接続していなかった Tab と、lost / failed の Tab は、overlay を出したまま `tab.respawn` か `tab.close` を待つ。pin された Tab は例外で、webview は閉じず、Backend が張り直す（「pin」の節）。

### pin

`GLOSSARY.md` の Pin を帳簿で守る。帳簿に置く理由は ADR-0014。

- `tab.pinned`（既定 false）に `(runspace_id) WHERE pinned` の部分 unique index を張り、`layout.get` の Tab に載せる。
- `tab.pin { id }`: Runspace に pin された別の Tab があれば、pin をこの Tab に付け替える。無ければ、所有されていない Runspace にほかの Tab があるとき、新しい Runspace（cwd は Tab の cwd、並びは末尾）を作って Tab を移してから立てる。それ以外はその場で立てる。所有された Runspace（Bench）は、ほかの Tab があっても切り出さない。切り出すと Tab が Task の Bench から外れるため。
- `tab.unpin { id }`: 印を外すだけで、元の Runspace には戻さない。
- `tab.close`、`terminalSession.terminate`、`runspace.remove` は、pin された Tab が対象か中にあれば `CONFLICT` で断る。
- `tab.move` と `moveTab`（Attach）は、Tab を別の Runspace へ移したら同じ transaction で pin を外す。同じ Runspace の中の並べ替えでは外さない。
- `removeRunspace`（Task の close）は pin を見ない。Bench の pin された Tab も他の Tab と同じく消える。
- webview は ⌘P で pin を切り替える（monica どおり）。sidebar は pin された Tab を持つ Runspace を先頭の Pinned グループにまとめ、グループの中は `sort_order` 順に並べる。drag でグループはまたげない。

張り直し:

- Backend は Exit を受けて行を exited にし、Reap した後で、その Terminal Session を指す Tab が pin されていれば、新しい `starting` の session を作って Tab に結び直し、commit 後に Create する（`tab.respawn` と同じ形）。size は 24×80 で始め、attach の resize で追いつく。
- reconcile の後は、pin された Tab が終わった行を指していれば、同じく張り直す。reconcile で exited か lost にした行のほかに、Exit を記録してから張り直す前に Backend が止まった行も拾う。
- 張り直さないのは、failed の行と、`ended_at - created_at` が 2 秒未満の行。その Tab は overlay を出したまま `tab.respawn` を待つ。`.zshrc` が壊れていて即死を繰り返す shell を、起こし続けないため。ただし pid の無い lost の行（Create が届く前に Backend が止まり、shell が一度も動かなかった行）は、2 秒未満でも張り直す。
- Exit の時点で Tab が無いか pin されていなければ、何もしない。Task の close で消えた Bench の Tab は張り直さない。
- webview は、`changes` で Tab の `terminalSessionId` が替わったら、新しい session に attach し直す。

### 終わった行

- exited / lost / failed の `terminal_session` と、終了の `agent_session` の行は消さない。Run の行は履歴として消さず（Task v1）、`run.agent_session_id` → `agent_session.terminal_session_id` の FK が残るため。1 行は 200 byte 程度で、GC の読み手もいない。
- 一覧は画面が使う行に絞る。
  - `terminalSession.list` は、live か Tab に指されている行だけを返す。Detached グループと Tab の overlay の材料。webview は Shell から Exit を受けた Terminal Session と自分が終了を頼んだ Terminal Session を、一覧が live と言っていても exited として扱い、Detached に出さない（Backend が exit を記録するまで行は live のままなので）。接続中の Tab が Exit で閉じる間は、overlay も dot も出さない。CLI の `tania workbench terminal-session list` も同じものを出す。
  - `agentSession.list` は、終了でない行だけを返す。status dot の材料（「Workbench の UI 状態と status dot」の節）。

### Agent Session の終了と未観測

ADR-0008 の「Backend 起動時」と ADR-0011 の reconcile の規則のうち、Agent Session の分。どちらも `transition` に Terminal Session の終了と Backend の再起動の event として渡す。

- Agent Session の居場所（`terminal_session_id`）は、受け付けた hook の Terminal Session に合わせる。resume の SessionStart を取りこぼした agent が前の Tab に結ばれたままだと、前の Tab が閉じたときに生きている agent を終了にしてしまうため。 つの Terminal Session に live な Agent Session が 1 つであることは、`agent_session` の部分 unique index（`state <> 'ended'`）が守る。cwd も受け付けた hook の値に合わせる。
- Terminal Session の行が終わるとき（ptyd の Exit、reconcile の lost / exited）、同じ transaction で、その Terminal Session の終了でない Agent Session を終了（terminal_exited）にする。
- 生きている Terminal Session の動作中の Agent Session を未観測にするのは、Backend の起動直後の reconcile だけ。ptyd に繋ぎ直したときの reconcile では動作中のままにする。その間も Backend は居て hook を受けていたため。
- reconcile が終了や未観測にした Agent Session も、`reconciled` の前に 1 つずつ `{ type: "agentSession", sessionId }` で知らせる。`agentSession` の合図だけを読む購読側（task の Run）にも、ptyd に繋ぎ直したときの終了が届くようにするため。

### Tab の外から来た hook

- `recordHook` は、input の Terminal Session が帳簿に無いか終わっている（exited / lost / failed）なら、何も書かず通知も出さずに、stderr に 1 行出して正常に返す。Agent Session は Tab の中で動く agent なので、どの Tab にも無い Terminal Session の agent は観測しない。
- 起きるのは、env の `TANIA_TERMINAL_SESSION_ID` が Tab の外（Tab で起こした tmux server、Tab から `code .` で開いたエディタの端末、`nohup`）へ漏れたときと、DB を消した後で reconcile が ptyd の session を取り込む前に hook が届いたとき。
- 生きている Terminal Session の id が漏れた場合は、Backend には見分けられない。payload に pid が無いため。その agent は Tab の agent として観測され、SessionStart で Tab の agent を superseded にする（ADR-0008 の既知のずれ）。

## Workbench の UI 状態と status dot

帳簿に載せない Workbench の画面の状態と、Agent Session の状態の見せ方。どちらも `packages/workbench/src/ui` に置く。

### UI 状態

- webview の localStorage に置く（ADR-0014）。中身は active な Runspace とその active Tab、sidebar の開閉と幅（160〜360、既定 200）、UI zoom（0.8〜1.6、既定 1）。monica の `ui-state.json` から、Space、Work Board、window ごとの入れ子を除いた形。
- 端末の font size と、active でない Runspace の active Tab は保存しない（monica どおり）。
- 書き込みは 500ms の debounce。localStorage は同期で読めるので、monica の render 前の hydrate は要らない。
- 保存した id が `layout.get` に無ければ、先頭の Runspace と、その先頭の Tab に戻す（monica の `resolveWorkbenchActive`）。読めないか壊れていれば既定値で始める。

### status dot

Tab の dot（label の左）は、その Tab の Terminal Session の live な Agent Session の状態を写す。材料は `agentSession.list`。

| Agent Session | dot |
|---|---|
| 動作中 | 緑の点滅 |
| 質問・許可 | 琥珀の点滅 |
| エラー | 赤 |
| 手空き | 薄い琥珀 |
| 未観測 | 灰の輪（中抜き） |
| 終了、または Agent Session が無い | 出さない |

- hover の title は状態の語にし、質問と許可はそこで見分ける。
- plan 承認の色は持たない。plan の承認は許可の一種で、ExitPlanMode は自動承認されて待ちにならない（#16）。
- 見たかどうか（既読）は持たない。
- Terminal Session の dot（label の右。exited / lost / failed）は monica のまま残す。
- sidebar の Runspace の行には、その Runspace の Tab の Agent Session から 1 つを選んで出す。優先順は 質問・許可 > エラー > 手空き > 未観測 > 動作中。Bench も同じ規則で、Task の表示状態は使わない（Bench のラベルの語は task の slot が出す）。Detached グループの行にも Tab と同じ dot を出す。
- 状態と色の対応は Task の型を借りない。monica の `lib/status-config` は Task の `DisplayStatus` を借りていたが、workbench は task を import しない（ADR-0005）。
- tania が前面にある間は通知のバナーが出ないので、この dot が代わりになる（ADR-0013）。active でない Runspace の待ちは、Runspace の行の dot で気づく。

## tab の env と shim

Terminal Session を作るときに Backend が ptyd の Create に渡す env と、Backend が `start()` で書く 3 つのファイル（shim、claude wrapper、hook の settings）の仕様。3 つのファイルは内容に差分があるときだけ書き直す。ここと ADR-0008 の Agent Session の観測は、Workbench を持ち込む骨格の実装に含める。Task が無い Tab でも観測するため（ADR-0005）。

### env

| 名前 | 値 |
|---|---|
| `TANIA_HOME` | Backend の home |
| `TANIA_TERMINAL_SESSION_ID` | `ts-<uuidv7>` |
| `ZDOTDIR` | `$TANIA_HOME/shell/zdotdir`（shim） |
| `TANIA_USER_ZDOTDIR` | Backend の env の `ZDOTDIR`。無ければ空で、shim は `$HOME` を使う |
| `PATH` | 先頭に `$TANIA_HOME/bin`。zsh 以外の shell 向けの保険で、zsh では shim が最後に置き直す |

- Tab id、task id と ref、run id、Backend の port と token は渡さない（ADR-0005 / 0007 / 0011）。Runspace は env を持たない。`.tania/setup.sh` にも `TANIA_*` を足さない。
- ptyd を spawn するときは、Backend の env から `TANIA_*`（`TANIA_HOME` は付け直す）、`CLAUDECODE`、`CLAUDE_CODE_*` を落とす。ptyd は自分の env を全 tab に渡すので、Claude Code の中から `bun run desktop` を起こすとこれらが全 tab に漏れ、wrapper の入れ子の判定が壊れる。
- tab で動く CLI は env の `TANIA_TERMINAL_SESSION_ID` を呼び手として procedure の input に入れる（`current`、`attach`、`close`）。Backend はその Terminal Session の live な Agent Session の Run の Task を引き、無ければ Tab → Runspace → Bench の Task を引く。`current` の解決元は `run` か `bench`。Claude Code が Bash tool に渡す `CLAUDE_CODE_SESSION_ID` は非公開なので使わない。

### shim（`$TANIA_HOME/shell/zdotdir/`）

ptyd は shell を常に `--login` で起こすので、zsh は `.zshenv` → `.zprofile` → `.zshrc` → `.zlogin` の順に shim を読む。

- 4 枚とも、ZDOTDIR を一時的にユーザーの値（`TANIA_USER_ZDOTDIR`、空なら `$HOME`）にして同名のファイルを source するだけ。ユーザーの `.zshenv` が ZDOTDIR を変えたら、以降はその値から読む。
- `.zshrc` の最後で `$TANIA_HOME/bin` を PATH の先頭に置き直す。ユーザーの rc が PATH の前に何を足しても、dev の tab の `tania` と `claude` は `$TANIA_HOME/bin` のものを指す。zinit の turbo mode のように `.zshrc` の後で PATH の前に足す plugin の dir はその前に来るが、`tania` と `claude` を持たなければ害は無い。
- `.zlogin` の最後で ZDOTDIR をユーザーの値に戻して export する（元が未設定なら unset）。tab から起こした子（dev の desktop、tmux、Claude Code の Bash tool）は shim を通らない。
- `claude` の shell 関数は定義しない。Claude Code の Bash tool は shell 関数を snapshot に取り込むので、関数にすると agent の中から起こした `claude` にも効いてしまう。

### claude wrapper（`$TANIA_HOME/bin/claude`）

- PATH から自分の directory 以外の `claude` を探して exec する。
- PATH に別の wrapper（他の home の tania、monica）があると、どちらも PATH の先頭の `claude` へ戻すので exec が巡回する。wrapper は exec した `claude` を env の `TANIA_CLAUDE_TRAIL`（pid と path の列）に残し、同じ pid で戻ってきたら、それを飛ばして次を探し、`--settings` も足し直さない。exec は pid を変えないので、claude の子に漏れた値とは見分けられる。
- `TANIA_TERMINAL_SESSION_ID` があり、`CLAUDECODE` が無いときだけ `--settings $TANIA_HOME/shell/claude/settings.json` を足す。`CLAUDECODE` があるのは agent の Bash tool から起こした入れ子の claude で、hook を付けると同じ Terminal Session の SessionStart が親の Agent Session を superseded にする（ADR-0008）。
- 最初の引数が claude の subcommand（`mcp`、`doctor`、`update` など。claude 2.1.288 の `--help` の Commands）なら `--settings` を足さない。claude は `--settings` の後ろの subcommand を prompt として読み、後ろに置くと `unknown option` で落ちる。最初の引数が prompt（`claude "fix the bug"`）なら足す。
- `--session-id` は足さない。Run は Bench の Tab に居る Agent Session から生まれる（ADR-0005）。
- `claude` を絶対パスで呼ぶと wrapper を通らず、その Agent Session は観測されない。

### hook の settings（`$TANIA_HOME/shell/claude/settings.json`）

- 張る hook は 9 本（ADR-0008）で、timeout はすべて 5 秒（既定の 600 秒を必ず上書きする）。SessionStart、UserPromptSubmit、PreToolUse（matcher `AskUserQuestion`）、PostToolUse、PostToolUseFailure、PermissionRequest、Stop、StopFailure、SessionEnd。
- command は `'<home>/bin/tania' workbench hook claude`（絶対パス。agent が PATH を変えても届く）。
- wrapper は file の path を渡すので、Backend が書き直せば既存の tab でも次の `claude` から効く。

### hook CLI（`tania workbench hook claude`）

- `TANIA_TERMINAL_SESSION_ID` が無ければ即 exit 0。
- PermissionRequest で `tool_name == "ExitPlanMode"` なら、Backend を待たずに stdout へ allow を書く（`updatedInput` に `tool_input` を返し、`updatedPermissions` に `setMode: auto` を付ける。#16）。
- stdin の payload と env の Terminal Session id を `agentSession.recordHook` に渡す。呼び出しは 2 秒で打ち切り、不在・失敗・timeout のどれでも exit 0。retry しない（ADR-0007）。

### payload と decoder

実機の payload は `docs/research/hook-payloads/` にあり、decoder の test の fixture にする。field と、場面ごとにどの hook がどの順で届くかは `docs/research/hook-payloads.md`。遷移表は #36 の resolution。

- Stop は、`background_tasks` に type が `subagent` / `workflow` / `teammate` で status が `running` のものがあるかだけを読む。field が無ければ無いとみなす。
- PreToolUse(AskUserQuestion) と PermissionRequest(AskUserQuestion) は、同じ質問の event にする。
- StopFailure のエラーの種類は `error` から読む（`error_type` ではない）。
- `permission_mode` は SessionStart / SessionEnd / StopFailure に無い。PermissionRequest に `tool_use_id` は無い。

## 通知

Agent Session がユーザー待ちに入ったときに macOS の通知を出す（ADR-0013、語は `GLOSSARY.md` の通知）。判定と本文は workbench が持ち、OS に渡すのは Shell が持つ。Task の無い Tab でも出すので、観測と同じく Workbench を持ち込む骨格の実装に含める。task が足すのは `nameAgentSession` だけ（「Task の帳簿」の Run の節）。

### 出す遷移

`recordHook` が遷移を書いて commit した後、`notificationFor(前の行 | null, event, 次の行)` が通知の理由を返す。`transition` の隣に置く純関数。

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

### title と body

- title は呼び名。`nameAgentSession(db, agentSessionId)` が文字列を返せばそれを使う。null なら Agent Session の cwd の末尾 2 つ（monica の `shortPath`）を使う。長さは切らない（macOS が切る）。
- `nameAgentSession` は table を読むだけの関数。その Agent Session の Run の Task を引き、無ければ Tab → Runspace → Bench の Task を引いて（CLI の `current` と同じ順）、Bench のラベルと同じ `<repo>#<n> <title>` を返す。後ろの経路は、通知の判定（`recordHook` の commit 直後）が task の購読より先に走り、Bench の Tab で始まったばかりの Agent Session にまだ Run が無い場合のためにある。
- body は理由。`手空き`、`質問`、`許可: <tool>`、`エラー: <error_type>`（error_type が無ければ `エラー`）。
- 音は鳴らさない。

### Backend と Shell

- apps/backend が `createWorkbench` に渡す `notify({ title, body })` は、stdout に `{"type":"notify","title","body"}` を 1 行書く。test では `notify` と `nameAgentSession` を差し替える。
- `nameAgentSession` か `notify` が throw したら、stderr に 1 行出して捨てる。`recordHook` の記録と `changes` の合図は続ける。
- Backend の stdout は Shell 宛ての JSON 行専用（ADR-0007）。Backend の log は stderr に出す。
- Shell は stdout の行を `type` で振り分ける。`endpoint` は `backend-endpoint` event に、`notify` は tauri-plugin-notification の `app.notification().builder().title(..).body(..).show()` に渡す。解釈できない行は Shell の log に流して捨てる。
- plugin の macOS 実装は NSUserNotificationCenter なので、取り下げ、クリックの受け取り、最前面でのバナーは無い。クリックすると tania が前面に出るだけ。
- dev の通知は plugin が Terminal.app の名義で出す（`tauri::is_dev()` で切り替わる）。Terminal.app に通知の許可が要る。見た目は `bun run install-app` で入れた release で確かめる。

## Task の帳簿

`packages/task` の contract と写しの規則。table は #15、sync の契機は #18、表示状態は #17 の resolution にある。

### contract（root は `task`）

```
track       { ref } → { ref, title, alreadyTracked, closed }                                cli
sync        { ref? } → { synced, missing }                                                  cli
list        { closed? } → { tasks: ListItem[], backgroundSyncError: { at, message } | null }  cli
run         { ref, inPlace?, force? } → { ref, cwd, mode, benchCreated, warnings,               cli
              tabId, terminalSessionId, resumed }  errors: BLOCKED { blockers }
current     { terminalSessionId? } → { ref, title, displayState, agentSessionId, source }   cli
attach      { ref, terminalSessionId? } → { ref, title, benchCreated, runCreated,               cli
              agentSessionId }
close       { ref, force?, terminalSessionId? } → { ref, removedWorktree, deletedBranch,        cli
              spared, warnings }  errors: CLOSE_REFUSED { reasons }
reopen      { ref } → { ref, title, warnings }                                               cli
bench.list  → { runspaceId, ref, title, setupState }[]
changes     → { type: "task", ref } | { type: "synced" }
```

- ref は `owner/repo#n` と `https://github.com/owner/repo/issues/n`（後ろの `?…` と `#…` は捨てる）だけを受ける。CLI では位置引数にする（zod の `.meta({ positional: true })`）。
- `ListItem` の `displayState` は純関数 `displayState(task, issue, bench, runs)` が TS で導く（#17 の表）。`runs` はその Task の Run の Agent Session。live な Run があれば `waiting`（`reason`、許可なら `tool`、エラーなら `errorType`）/ `unobserved` / `running` に `since`（`state_changed_at`）と `liveRuns` を付け、無ければ `closed` / `issue_closed` / `not_started` / `preparing` / `setup_failed` / `ended` の 1 語にする。`liveRuns` は代表を先頭に集約の順で並べる。`ListItem` の `cwd` は Bench の cwd。
- 人間向けの STATE の 1 マスは `waiting:permission(Bash) 12m +1`（理由、許可なら tool 名、`since` からの経過、他の live な Run の件数）。経過は 60 秒未満が `s`、60 分未満が `m`、24 時間未満が `h`、それ以上が `d` で、切り捨てる。
- `current` は呼び手の Terminal Session の live な Agent Session が Run ならその Task を返し（`source: run`、`agentSessionId` はその Agent Session）、そうでなければ Tab → Runspace → Bench の Task を引く（`source: bench`、`agentSessionId` は null）。`terminalSessionId` が無ければ `BAD_REQUEST`、どちらでも引けなければ `NOT_FOUND`。
- Bench の行の変化（作成、準備の終わり）と、Run の Agent Session の変化（Run になったときを含む）は `{ type: "task", ref }` で知らせる。表示状態は Run の Agent Session から導くので、`task.changes` だけで `list` を描き直せるようにする。

### Run

`GLOSSARY.md` の Run を不変条件で保つ。「Bench の Runspace にある Tab の live な（`agent_session.state != 'ended'`）Agent Session で、どの Run でもないものは、その Bench の Task の Run になる」（ADR-0005）。

- task は `start()` で `workbench.events` を listener で購読し、`agentSession` の合図が来たらその Agent Session に不変条件を当てる。async iterator の購読は溜まった合図を 100 件で捨てるので使わない。workbench は transaction の中でも publish するので、読み直しは `queueMicrotask` で commit の後に回す。`stop()` で購読を外す。
- `start()` は購読を張った後に、全件に 1 回当てる。Backend の更新より前から Bench の Tab に居た Agent Session と、commit から購読の microtask までの間に Backend が止まった分を拾う。Backend が居ない間の hook は CLI が捨てるので、不在中に始まった claude の行は起動後の最初の hook で生まれ、購読の経路で Run になる。
- 全件は workbench の reconcile を待たずに当てるので、不在中に Terminal Session が終わった Agent Session も、終了になる前に Run になることがある。Backend が止まる前に Bench の Tab で動いていた agent なので、Task の Run にして差し支えない。
- どちらの経路も `origin = started` で insert する。一度 Run になった Agent Session は、Tab がどこに移っても、終わるまでその Task の Run のまま（`run.agent_session_id` の UNIQUE が守る）。closed な Task には Bench が無いので、Run は生まれない。
- `layout` の合図（Tab の移動）でも、同じく commit の後に当てる。合図はどの Tab が動いたかを持たないので、Bench の Tab すべてに当てる。この経路で生まれる Run は Tab ごと Bench に入った Agent Session なので `origin = attached` にする（GUI の drag）。Bench の Tab で始まった claude の Run は、hook の commit と同じ同期の区間で積まれた `agentSession` の合図の microtask が先に作るので、この経路に横取りされない。
- task のテストは、Tab と live な Terminal Session の行を fixture で書き、hook は workbench の `agentSession.recordHook` に渡す（`testing.ts` の `openTab` と `hook`）。Agent Session の行と合図を Backend と同じ経路で作るため。

### Attach

`GLOSSARY.md` の Attach。CLI の `tania task attach <ref>` は呼び手の Tab を、Tab のメニューの picker は選んだ Tab を、同じ `attach` で移す。GUI の drag は `tab.move` で移し、Run は「Run」の節の `layout` の経路が作る。

- `terminalSessionId` が無ければ `BAD_REQUEST`、未 track は `NOT_FOUND`、closed な Task は `BAD_REQUEST`（`run` と同じ）。
- 1 つの transaction で次の順に進める。
  1. その Terminal Session を表示している Tab を引く。無ければ（detached、または帳簿に無い）`BAD_REQUEST`。
  2. その Terminal Session の live な Agent Session が別の Task の Run なら `CONFLICT`。message にはその Task の ref を出す。GUI の drag はこれを断らず、Tab だけが移る。
  3. Tab が既にその Bench に居れば、何も変えずに返す（`moveTab` は同じ Runspace でも末尾へ並べ替えるので呼ばない）。
  4. Bench が無ければ、in_place の Bench を作る（`createRunspace` を含む）。cwd は Repo の checkout（`$(ghq root)/github.com/<owner>/<repo>`）で、setup は走らせず、`setup_state` は最初から `ready`（`prepared_at` は作った時刻）。checkout が無いか ghq root が引けなければ `BAD_REQUEST`。attach は network を使わないので clone しない。ghq root は async なので transaction の前に引き、transaction の中で Bench がまだ無いときだけ使う。待つ間に `run` が Bench を作っていれば、そちらに移す。checkout の path は transaction の中で引き直した repo の名前から作る。待つ間に sync が repo の改名を写すと、前に引いた名前の path は古い checkout を指すか、clone されていないことになるため。
  5. `moveTab(tx, tabId, bench.runspaceId)`。pin は外れる。
  6. live な Agent Session がどの Run でもなければ、Run を `origin = attached` で insert する。agent の居ない Tab も移せて、その後その Tab で起こした claude は「Run」の節の不変条件で Run になる。
- commit の後の `layout` の合図では、Agent Session が既に Run なので何も起きない。
- Tab を移したら `{ type: "task", ref }` で知らせる。Run を作らない移動でも `current` の output は変わるため。
- CLI の text は、Bench を作ったこと、Tab がどの Task の Bench に居るか、Tab の claude がその Task の Run になったか（agent が居なければ、次に起こした claude が Run になること）を 1 行ずつ出す。

### Bench

`run` の前半。Bench を確保し、準備が終わるのを待つ。後半は「Run の起動」の節。

- `run` は open な Task だけを受ける（closed は `BAD_REQUEST`、未 track は `NOT_FOUND`）。Bench が無ければ、tx で Task が open かを引き直してから `bench` の行（`preparing`）と `workbench.createRunspace(tx, { cwd })` を作って commit し（`--in-place` の ghq root を待つ間に close が走り終えることがあるため。Tab を開く tx も同じく引き直す）、準備を Backend の中で始める。準備中の Bench は sidebar にすぐ出る。
- cwd は作る前に決め、その後は変えない。worktree は `$TANIA_HOME/worktrees/<owner>/<repo>/issue-<n>`、`--in-place` は `$(ghq root)/github.com/<owner>/<repo>`。`--in-place` で ghq root が引けなければ、Bench を作らずに `PRECONDITION_FAILED`。worktree の Bench に `--in-place` を打つと `BAD_REQUEST`、flag の無い `run` は今の Bench の mode に従う。
- 準備: in-place は、checkout（cwd）が無ければ `ghq get <owner>/<repo>` して終わる。ghq は repo の今の名前の場所に clone するので、改名の後で cwd に来なければ失敗にする。worktree は、cwd が linked worktree ならそのまま使う。repo が改名されても、作った worktree は作った時の checkout に登録されているので、checkout を引き直さない。cwd が worktree でなければ、checkout が無いときに `ghq get` する。ただし、改名の前に作った worktree が消えていたら（cwd が今の名前の path と違えば）失敗にする。元の branch は改名前の checkout にしか無く、新しい名前の clone から作り直すと黙って別の branch になるため。そのうえで、path が消えていればその登録だけを `git worktree remove <path>` で外し（`prune` は外付けの disk の上の worktree のような、関係の無い登録まで外すので使わない）、branch `issue-<n>` があれば `git worktree add <path> issue-<n>`。無ければ default branch（`refs/remotes/origin/HEAD`、取れなければ `git remote set-head origin --auto` を 1 回）を求め、`git fetch origin <default>` を best-effort で打ってから `git worktree add -b issue-<n> <path> origin/<default>`。fetch の失敗は output の `warnings` に載せる。git と ghq には `GIT_TERMINAL_PROMPT=0` を渡す。Backend が端末から起こされていると、git は認証を /dev/tty で尋ねて止まるため。
- setup は `<worktree>/.tania/setup.sh` を直接 exec する（shebang と実行権限が要る）。無ければ ready。cwd は worktree、stdin は null、env は Backend の env から `TANIA_*`・`CLAUDECODE`・`CLAUDE_CODE_*` を落としたもの。自分の process group（`detached`）で起こし、600 秒で group に SIGTERM を送り、group が空になるか 2 秒たったら SIGKILL を送る。script が先に抜けても、後始末をしている子孫に猶予を残すため。env の除外は workbench の `inheritableEnv()` を ptyd と共有する。
- log は `$TANIA_HOME/logs/setup/<owner>/<repo>/issue-<n>.log` に試行ごとに上書きで書く。setup の stdout と stderr のほかに、失敗の理由を `tania: <理由>` の 1 行で足す。
- 成功したら `ready` と `prepared_at`、失敗したら `failed` と `setup_error`（`exit 1`、`timed out after 600s`、`spawn failed: <message>`、git の失敗の最後の行）を書く。`run` は `PRECONDITION_FAILED` で `setup_error` と log の path を出す。
- `failed` の Bench への `run` は同じ手順をやり直す。worktree が残っていれば setup だけが走る。準備中の Bench への `run` は同じ準備の完了を待つ。CLI を Ctrl-C しても準備は続く。
- `start()` は `preparing` のまま残った行を `failed`（`the Backend stopped while preparing`）にする。`stop()` は setup の group に SIGKILL を送り、その後の準備の結果は書かない。

### Run の起動

`run` の後半。Bench の新しい Tab で素の `claude` を起こすか、終わった claude を resume する。Run の行は「Run」の節の不変条件が作る。

- Bench があり live な Run があれば、`CONFLICT` で断る。message には live な Run の Agent Session と状態（`s-1 waiting:idle`）を並べ、並行して agent を足すなら Bench に Tab を開いて `claude` を打てば Run になる、と案内する。
- resume の候補は、今の Bench を作った後に始まった Run（`run.started_at >= bench.created_at`）のうち、Agent Session が最後に動いた（`last_event_at` が新しい）もの。live な Run が無いので、その Agent Session は終わっている。候補があれば sync も Blocker gate もせずに resume する。resume は新しい Run ではないため（#18）。
  - Bench より前の Run は reopen の前の挑戦なので、resume せず新しい会話から始める。
  - `transcript_path` の file が無い Agent Session は候補から外す。claude は最初の prompt まで transcript を書かず、prompt を送らずに抜けた Agent Session の `--resume` は `No conversation found` で終わるため。外さないと、その Run がいつまでも候補に残り、`run` で新しい claude を起こせなくなる。path を持たない Agent Session は候補に残す。
- 新しい Run は、Task を sync（5 秒）してから Blocker gate を確かめる。`--force` でも sync する。GitHub に届かないか Issue が返らなければ手元の写しで判定し、`warnings` に理由と写しの古さ（分）を載せて続ける。sync は repo の改名を写すので、Task は名前でなく行の id で引き直す。
- open な Blocker があれば、`.errors()` で宣言した `BLOCKED`（`data.blockers` に ref の一覧）で断る。`--force` なら越える。gate を通ったら Bench を確保して準備する（「Bench」の節。CLI は準備を待つ）。
- `workbench.ready()` を待ってから、tx で `openTab` → commit → `startTerminalSession`（24×80。表示されていない Tab の shell は attach の resize で追いつく）→ すぐに `claude\r`（resume なら `claude --resume '<id>'\r`）を write して返る。shell の起動は待たない。起動前に書いた入力が捨てられないことは #13 で確かめた。Tab は前面に出さない。
- cwd は、新しい Run なら Bench の cwd、resume ならその Agent Session の cwd（その directory が無ければ Bench の cwd）。Agent Session の id は hook の payload から来るので、single quote で囲んで打つ。

### close と reopen

`GLOSSARY.md` の Bench と、ADR-0012 の close の順序。

- `close` は Task を引き（未 track は `NOT_FOUND`、closed は `BAD_REQUEST`）、返るまで（commit の後の terminate を含む）その Task を Backend の memory で予約する。予約の間は、同じ Task への `close`、`run`（Bench を開く・準備をやり直す・Tab を開く直前）、`attach` と `reopen`（transaction の中）を `CONFLICT` で断る。git を待つ間に準備や Tab が片付ける Bench に入らないように、また close の呼び手が閉じた結果を受け取るようにするため。Bench の準備が走っていれば、close も `--force` でも `CONFLICT` で断る。準備は worktree と Bench の行を書き続け、走っている準備は reopen の後の `run` にも待たれるため。
- Task を sync（5 秒。`--force` でも sync）してから、行の id で引き直す。GitHub に届かなければ手元の写しで続け、`warnings` に載せる（`run` と同じ `syncOrUseCopy`）。
- guard は当たったものをすべて集め、`.errors()` で宣言した `CLOSE_REFUSED`（`data.reasons`）で返す。`--force` なら見ない。
  - ActiveRun: Task の live な Run。呼び手の Terminal Session の Agent Session の Run は除く。Bench が無くても見る。reopen の前に close を頼んだ claude が残っていることがあるため。
  - UncommittedChanges（worktree の Bench だけ）: `git -C <worktree> status --porcelain --untracked-files=normal` が空でない。untracked を含め、ignored は含めない。worktree が無ければ当たらない。
  - UnpublishedCommits（worktree の Bench だけ）: `git -C <checkout> rev-list --max-count=1 refs/heads/<branch> --not --remotes` が commit を返す。fetch しないので、push 済みなら merge されていなくても止めない。branch が無ければ当たらない。
- checkout は、worktree があればその `--git-common-dir` の親を使う。repo の改名の後も、作った時の checkout に当たる。worktree が無ければ今の名前の ghq の checkout を使い、それも無ければ git は何もしない。別の Task の Bench が同じ cwd を持てば、worktree にも branch にも触らない。repo の改名の後に旧名を別の repo が使うと、その repo の同じ番号の Task の worktree が同じ path にできるため。
- worktree の Bench は `git -C <checkout> worktree remove <path>` → `git -C <checkout> branch -D <branch>` を実行する。`--force` の close だけが `worktree remove --force` にする。素の `worktree remove` は ignored の file を通し、untracked と変更のある worktree を断るので、guard の後に書かれた変更も git が守る。`branch -D` の前には remote に無い commit を見直し、あれば branch を残して `warnings` に載せ、close は続ける。worktree を外した後は、その branch に commit が積まれないため。path が消えていれば、その登録だけを `worktree remove --force` で外す（失敗は無視する）。消えた worktree の登録が残っていると、その branch を消せないため。`prune` は関係の無い登録まで外すので使わない（「Bench」の節）。git か ghq が失敗したら `PRECONDITION_FAILED` で、DB を何も変えずに止まる。in_place の Bench は checkout も branch も触らない。
- tx で Task を引き直して ref を作り直す。`closed_at` を入れ、`bench` の行を消し、`removeRunspace(tx, runspaceId, { spare })` を呼ぶ。`spare` は呼び手の Terminal Session と、`--force` でなければ git を待つ間に Bench の Tab で起こした claude（hook から Run になっている）の Terminal Session。後者も呼び手と同じく所有を解いた Runspace に残し、`warnings` に載せる。guard の後に見つけたものは、壊した後で断らずに守ったまま close を終えるため。output の `spared` は呼び手の Tab が残ったかどうか。commit の後に `{ type: "task", ref }` で知らせ、返った Terminal Session を `terminateTerminalSessions` で終わらせる。
- Run の行は残す。close を頼んだ claude は、終わるまで closed な Task の Run のままで、`current` もその Task を返す。
- CLI は拒否を、1 行目の `CLOSE_REFUSED: <ref> stays open:`、理由を 1 行ずつ、最後の `pass --force to close anyway` で出し、exit 1 にする。Skill は stderr の 1 行目で失敗を読むので、1 行目は `CODE: message` の形を保つ。
- `reopen` は closed な Task だけを受ける（open は `BAD_REQUEST`）。sync（5 秒。届かなければ警告）してから `closed_at` を NULL に戻し、`{ type: "task", ref }` で知らせる。Bench は作らないので、表示状態は `not_started`（Issue が closed なら `issue_closed`）。次の `run` か `attach` が Bench を作り直す。`run` は close で消えた branch `issue-<n>` を origin の default branch から作り直し、Bench より前の Run は resume しない（「Run の起動」の節）。

### sync

- GitHub client（`github.ts`）は repo ごとに 1 本の GraphQL で最大 50 件を alias（`i<number>`）で引く。null の alias（削除・transfer・PR の番号）は写しを消さずに `missing` に回し、`errors` があっても返った alias は書く。`repository` ごと null なら（削除・権限の喪失）その repo の失敗にする。新しい Issue の `track` だけは、打ち間違いを GitHub の障害に見せないよう `NOT_FOUND` にする。多くは gh のアカウント違いや SSO による権限の喪失で、`missing` にすると背景 sync の警告に出ず、写しが黙って古くなるため。
- token は sync のたびに取り直す。`gh auth token` の失敗は 0 件成功にせず、sync の失敗にする。
- timeout は sync 1 回の全体（token と全 query）にかかる。`track` / `sync` / 背景は 30 秒。`stop()` は走っている request を切る。
- 範囲（open な Task すべて、または 1 つの Task）ごとに走る sync を 1 つにし、後から来た要求はその完了を自分の timeout まで待つ。5 秒の直前の sync が 30 秒の sync に合流しても 5 秒で返すため。
- repo ごとに引けた分をその都度 1 transaction で書く。失敗した repo は `owner/repo: 理由` で並べ、`sync` は `BAD_GATEWAY` を投げ、背景は log と `list` の `backgroundSyncError` に出す。背景の次の回が成功すれば消える。
- 写しの行が同じ issue かは、GitHub の node ID（`issue.node_id`）で決める。node ID で見つからなければ、node ID の無い行（node ID を足す前に書いた行）を `(lower(repo), number)` で照らす。Task の Issue は、query に渡した ref（改名前の名前のこともある）の行を先に照らす。Task が指すのはその行だから。どれでも見つからなければ足す。見つけた行の repo と番号は、GitHub の今の値に書き直す。同じ node ID か、書き直す先の `(repo, number)` に別の行があれば、同じ issue の写しが 2 つあるので、その repo の sync の失敗にする。
- repo の query 1 本分の写しを書くときは、parent や Blocker を書く前に、その batch の Task の Issue の行に node ID と今の名前を付ける。改名した repo の Task が同じ batch の別の Task の parent や Blocker として先に出てきても、Task の行に当たるようにするため。別の repo の Task の parent や Blocker として先に写った場合は 2 行になり、失敗になる（node ID を足す前に書いた行が残る DB で、repo を改名したときだけ）。
- 同じ `(repo, number)` に node ID の違う行があれば、その番号は GitHub で別の issue に使われている（repo を消して作り直したときなど）。黙って付け替えず、その repo の sync の失敗にする。#15 は node ID を保存しないと決めていたが、repo の改名で GitHub は旧名の query にも新しい名前で答え、parent や Blocker の node は新しい名前でしか来ないので、repo と番号だけでは同じ issue の行が 2 つに分かれる。
- `track` が既に track 済みかは、Task の行の insert が重なったかで決める。改名した repo の issue は旧名でも新しい名前でも引けるので、入力の ref の名前では決められない。
- 新しい Issue の `track` は写しと Task の行を同じ transaction で書くので、失敗か `missing` なら何も書かない。
- `syncTask` は 1 つの Task を sync し、成否を投げずに `{ synced, missing, failures }` で返す。`run` / `close` / `reopen` の直前の 5 秒の sync はこれを呼ぶ。

## dev loop

- `bun run desktop` が `scripts/desktop.ts` を走らせる。
  1. `TANIA_HOME` が無ければ `~/.tania-dev` を設定し、`TANIA_BIN=<repo>/scripts/tania-dev` を設定する。home を `mkdir -p` し、`scripts/dev-instance.ts` の `devInstance` で home から identifier と vite の port の第一候補を引く（ADR-0007）。
     - 既定の home は `com.ashigirl96.tania.dev` と 1420 のまま。ほかの home は `com.ashigirl96.tania.dev.<home の basename>-<hash>` と、1421 からの範囲に hash で散らした port で、1420 は使わない。
     - hash は home の realpath から取る。basename だけだと `~/.tania-s2` と `$TMPDIR/tania-s2` が同じ identifier になり、後から起こした方が先の窓に回される。realpath にそろえないと、`$TMPDIR` の下の同じ home が `/var/…` と `/private/var/…` の 2 通りに書けて別の identifier になり、single-instance をすり抜ける。
  2. `cargo build -p tania-ptyd` を行う。externalBin は release の build だけが渡す（「release build と install」の節）ので、`binaries/` には何も置かない。
  3. 第一候補から上へ、127.0.0.1 と ::1 の両方で bind できる最初の port を選ぶ。vite は `localhost` で listen し、どちらの loopback に bind するかは名前解決の順で決まるため。選んだ port は env `TANIA_DEV_URL`（`http://localhost:<port>`）に入れる。Shell は Backend の env を消さずに起こすので、Backend の CORS まで届く。
     - 空きを確かめてから vite が bind するまでの間は port を押さえない。vite は自分で socket を開くので、確かめた socket を渡せないため。ほぼ同時に起こした 2 つの home が同じ port を選ぶと、後の vite は `strictPort` で落ちる。起こし直せば次の空きを選ぶ。
  4. `tauri dev --config src-tauri/tauri.dev.conf.json --config '<JSON>'` を起動する。dev の config は productName と identifier（既定の home の値）を release から分ける。後ろの JSON は home ごとの `identifier` と `build.devUrl` で上書きし、`build.beforeDevCommand`（`bun run dev --port <port>`。vite の `strictPort` は残す）で vite を起こす。
     - identifier か `devUrl` が前回と違うと `TAURI_CONFIG` が変わり、desktop の crate を build し直す。agent は worktree ごとに決まった名前の home を使う（`desktop-dev` skill）ので、build し直すのは worktree ごとに最初の 1 回だけ。
     - mcp-bridge の port は plugin が 9223 から空きを選び、log の `MCP Bridge plugin initialized … on 127.0.0.1:<port>` に出す。
- debug build の Shell は Backend として `bun --watch apps/backend/src/main.ts` を起動し、ptyd の場所 `target/debug/tania-ptyd`（`TANIA_PTYD_PATH` で差し替え可）を env `TANIA_PTYD_PATH` で Backend に渡す。ptyd を spawn するのは Backend で、場所は debug でも release でも Shell が env `TANIA_PTYD_PATH` で渡す（release は Shell の隣の `tania-ptyd`。ADR-0011）。Backend は package や apps/backend の編集と `bun run generate` で同じ pid のまま再起動し、webview は `backend-endpoint` event で再接続する。byte は Shell の ptyd 接続を通るので、この再起動で端末は切れない。
- webview は vite の HMR。package の `ui` も source のまま読む。
- `bun run tania <args>` は `scripts/tania-dev`（`bun apps/cli/src/main.ts "$@"`）を呼ぶ。`TANIA_HOME` が無ければ `~/.tania-dev`。
- `bun run dev:list` は、動いている dev と残った home を `TANIA_HOME` ごとに並べる（desktop か headless か、desktop・Backend・ptyd の pid、mcp-bridge の port、worktree）。Backend の env は `ps` で読めないので、home は ptyd の `--tania-home` と `~/.tania-*`・`$TMPDIR/tania-*` から集め、Backend は `backend.json` の pid から、desktop はその親から引く。bridge の port は desktop の pid が LISTEN している TCP の port（`lsof`）。release の `~/.tania` は出さない。
- `bun run dev:kill <NAME>` は desktop → Backend → ptyd の順に止める。逆にすると、Shell が Backend を、Backend が ptyd を起こし直す。`$TMPDIR` の下の home は消し、`~/.tania-dev` は layout の帳簿があるので残す。
- Shell は起動時に `$TANIA_HOME/bin/tania` → `TANIA_BIN` の symlink を張る。release の desktop だけが `~/.local/bin/tania` にも張る（ADR-0006）。dev の desktop が張ると release の CLI を上書きするため。Workbench の tab の PATH に `$TANIA_HOME/bin` を前置するのは shim（「tab の env と shim」の節）。
- `TANIA_HOME` は direnv に書かない（ADR-0006）。
- `.claude/skills` は生成しない。Skill は plugin として repo から in-place で読まれる（ADR-0006）。
- Skill を使うには、user scope の `~/.claude/settings.json` に tania の checkout を directory marketplace として登録し、`tania@tania` を enable する。登録はユーザーが行う。project scope には書かない。Skill はどの repo で動く agent にも配るため。

  ```json
  {
    "extraKnownMarketplaces": {
      "tania": { "source": { "source": "directory", "path": "<ghq root>/github.com/ashigirl96/tania" } }
    },
    "enabledPlugins": { "tania@tania": true }
  }
  ```

  - `path` は worktree ではなく main の checkout を指す。worktree は消すと plugin ごと読めなくなる。
  - checkout はその場で読まれ、SKILL.md の編集は `/reload-plugins` で効く。呼び名は `/tania:<name>`。
  - manifest は `claude plugin validate .` で確かめる。`version` が無いという warning は意図どおり（ADR-0006）。
- cargo の初回 build は約 36 秒（#8）。

## release build と install

- `bun run build` が `scripts/build.ts` を走らせる。
  1. `cargo build --release -p tania-ptyd`
  2. Backend: `bun build --compile --minify-whitespace --minify-syntax --bytecode --format=esm --asset packages/workbench/migrations/workbench --asset packages/task/migrations/task apps/backend/src/main.ts`
  3. CLI: `bun build --compile --minify-whitespace --minify-syntax --bytecode --format=esm apps/cli/src/main.ts`
  4. 3 つの binary を `apps/desktop/src-tauri/binaries/<name>-<rust triple>` に置き、`tauri build --bundles app --config '{"bundle":{"externalBin":[…]}}'`
- externalBin を base の `tauri.conf.json` に書かないのは、tauri-build が cargo の build のたびに `binaries/` の存在を求め、`binaries/tania-ptyd-<triple>` で `target/<profile>/tania-ptyd` を上書きするため。base に書くと dev と CI の clippy にも `binaries/` が要り、空の placeholder は cargo が作った ptyd を潰す。
- `--minify` は使わない。trpc-cli が class 名で instanceof を判定しており、名前が潰れると起動しない。`--bytecode` は top-level await があるので `--format=esm` が要る。
- compiled binary は Bun の runtime だけで約 60MB あり、Backend と CLI で約 120MB になる。
- `bun run install-app` は `.app` を `/Applications` にコピーし、codesign と quarantine の解除を行う（monica の `just install-app` と同じ）。codesign の identity は Keychain Access で作った自己署名の `tania`。ad-hoc と違い、build をまたいで署名の同一性が保たれる。
- 署名と notarization（hardenedRuntime 下の Bun の JIT entitlements。Bun の binary は Backend と CLI の 2 つ）は配布を始めるときに決める。

## 検査と CI

- 検査は `bun run check` に集める。何を流すかの正本は `package.json` の `check:ts` と `check:rust` で、CI の job も同じ script を呼ぶ。`check:ts` は最後に apps/desktop の `vite build` を流す（「entry」の節の bundle の検査）。
- Rust の検査は macOS の runner で流す。Tauri の crate が macOS の system library を要るため。
- Rust の検査は、Rust に関わる file が変わったときだけ走らせる（対象は `ci.yml` の `changes` job の filter）。private repo では macOS の runner の 1 分が 10 分に数えられ、crate は monica から rename しただけで骨格の後はほとんど変わらないため。GitHub Actions には job 単位の paths filter が無いので、判定は ubuntu の小さな job で行う。
- 整形だけの commit は、SHA を `.git-blame-ignore-revs` に書いて blame から外す。repo は squash merge なので、SHA は merge の後の main のものを後続の PR で足す。GitHub の blame はこのファイルを自動で読み、手元の git は `git config blame.ignoreRevsFile .git-blame-ignore-revs` を 1 回打つと読む。
- tauri の bundle build、knip、jscpd、lefthook は入れない。

## 版

- Bun は `package.json` の `packageManager` で固定し、CI も同じ版を使う。1.4 未満には `--asset` が無い。
- Rust は `rust-toolchain.toml` で `Cargo.toml` の `rust-version` と同じ版に固定し、CI も同じ file から入れる。stable を追うと、clippy に足された lint で、crate に触れた PR が変更と関係なく落ちるため。
- 依存の版は root の `workspaces.catalog` に集め、member は `catalog:` で参照する。`@orpc/*` は trpc-cli が対応する major に固定する（ADR-0003）。
- tsconfig は root の 1 つで、`types: ["bun"]` と DOM の lib を同居させる。browser 側の安全性は `vite build` に任せる。
- tsconfig に `exactOptionalPropertyTypes` と `noPropertyAccessFromIndexSignature` は入れない。前者は zod が推論する `x?: T | undefined` を domain の関数の `x?: T` に渡せず、procedure を足すたびに書き足しが要るため。後者は `env.X` を `env["X"]` と書かせるだけのため。`noUnusedLocals`・`noUnusedParameters` も入れない。oxlint の `no-unused-vars` が同じものを error にしている。
- scripts は root の `package.json` に並べ、1 行に収まらないものは `scripts/*.ts` に書く。just は使わない。

## ここで決めていないこと

- 設定、`$TANIA_HOME` のレイアウト、ログ（map の fog）。
- 署名と notarization（map の fog）。
