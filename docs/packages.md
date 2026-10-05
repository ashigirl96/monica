# パッケージ構成と dev loop

tania の repo の形、package の entry、domain 間の呼び出し、CLI の組み立て、dev と release の手順を決める。骨格を実装するときに最初に読む文書で、実装が進んだらここを今の形に合わせて直す。決定の理由は `docs/adr/` にある（とくに ADR-0002 / 0003 / 0006 / 0009 / 0010 / 0011）。出発点は branch `prototype/stack`・`prototype/workbench`・`prototype/terminal-session` で、骨格の実装 issue は #25 の sub-issue。

## 索引

この文書には、どの作業も読む規則を置く。ほかの規則は `docs/packages/` に分けてあり、作業がその範囲に触るときに読む。

- `docs/packages/workbench-ledger.md`: Workbench Ledger。workbench の contract と、Runspace・Tab・Terminal Session の起動と終了・pin・終わった行・Agent Session の終了の規則。workbench の procedure、ptyd に送るもの、reconcile、Agent Session の行に触るとき。
- `docs/packages/workbench-ui-state.md`: Workbench の UI 状態と status dot。webview に置く画面の状態と、Agent Session の状態の dot。Workbench の画面の状態か dot に触るとき。
- `docs/packages/tab-env-and-shim.md`: tab の env と shim。Tab に渡す env、shim、claude wrapper、hook の settings、hook CLI、payload の decoder。Tab の env、claude の起動、hook の受け口に触るとき。
- `docs/packages/notifications.md`: 通知。出す遷移、title と body、Backend から Shell への渡し方。通知の判定と本文、Agent Session の遷移に触るとき。
- `docs/packages/task-ledger.md`: Task Ledger。task の contract と、Run・Attach・Bench・Run の起動・close と reopen・sync の規則。task の procedure に触るとき。
- `docs/packages/job-ledger.md`: Job Ledger。job の contract と、Job Execution の記録・tick・飛ばす回・中断・保持の規則。job の procedure か、裏で定期的に走る処理に触るとき。
- `docs/packages/cli.md`: CLI（apps/cli）。argv の振り分け、Backend の探索、転送 router、`--format`、エラーと exit code、SKILL.md の検査。`cli: true` の procedure か SKILL.md を足すとき、apps/cli に触るとき。
- `docs/packages/desktop.md`: desktop（apps/desktop）。webview の枠、キーの扱い、Backend の endpoint、Task の slot、Shell の責務と command、窓。apps/desktop と domain の ui の載せ方に触るとき。
- `docs/packages/dev-loop.md`: dev loop、release、検査、版。dev の起動、scripts、release の build、CI、依存と tsconfig に触るとき。

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
│   ├── job/            @tania/job
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
| `@tania/<d>/ui` | React の component と atom。画面を持たない job には無い | browser | apps/desktop、他 package の ui |
| `@tania/<d>/cli` | 出力の整形関数、補完の候補を返す関数、手で書く command | Bun | apps/cli |
| `@tania/<d>/testing` | 他の package のテストに出す fake。今は workbench だけが持ち、`src/fake-ptyd.ts` の fake の ptyd（`startFakePtyd`）、短い home を作る `tempHome`、Terminal Session が starting を抜けるのを待つ `untilSettled` を出す | Bun | 他 package のテストと `testing.ts` |

- 依存の向きは task → workbench だけ。workbench は task を import しない（ADR-0005）。job は task も workbench も import しない（ADR-0016）。bun の isolated linker では package.json に書いていない依存を解決できないので、向きは package.json が守る。package の中の entry の境界（schema が import してよいもの、ui が server の entry と `bun:sqlite` を import しないこと、cli entry を import するのが apps/cli だけであること）と apps どうしの向きは、`.oxlintrc.json` の overrides が lint で守る。testing entry を import するのがテストと `testing.ts` だけであることは、lint の `tania/testing-entry` が守る。no-restricted-imports の設定は override をまたいで重ならないので、file の集合ごとの制限とは別の rule にしている。CLI と webview で動くコード（apps/cli、apps/desktop、各 package の cli entry と ui entry）が DB に触るもの（`bun:sqlite`、`drizzle-orm`、schema entry と server entry の値）を import しないことも同じく守る（ADR-0003）。cli entry で見るのは `cli.ts` の import だけで、`cli.ts` が import する内側のファイルは見ない。apps/cli のテストと `testing.ts` は in-memory の Backend を組むので、この制限から外す。
- task の schema は workbench の table を FK のために import するが、re-export しない（ADR-0010）。
- webview の bundle に `bun:sqlite` や `@orpc/server` が混ざっていないかは `vite build` で確かめる。混ざれば解決に失敗して落ちる。型だけの import は消えるので対象外。

## domain 間の呼び出しと Backend の組み立て

### server entry の形

```ts
// @tania/workbench/server
export { migrations } from "../migrations";
export const router = os.router({ ... });          // context は { db, workbenchLedger }
export function createWorkbenchLedger(deps: {
  db: Db;
  home: string;
  ptydPath: string;
  notify: (n: { title: string; body: string }) => void;
  nameAgentSession: (db: Db, agentSessionId: string) => string | null;
}): WorkbenchLedger;

// @tania/task/server
export { migrations } from "../migrations";
export const router = os.router({ ... });          // context は { db, taskLedger }
export function createTaskLedger(deps: {
  db: Db;
  workbenchLedger: WorkbenchLedger;
  home: string;
  github?: GitHub;
  ghq?: Ghq;
}): TaskLedger;
export function nameAgentSession(db: Db, agentSessionId: string): string | null;

// @tania/job/server
export { migrations } from "../migrations";
export const router = os.router({ ... });          // context は { db, jobLedger }
export function createJobLedger(deps: {
  db: Db;
  systemJobs: { name: string; every: number; run: () => Promise<void> }[];
  now?: () => Date;
}): JobLedger;
```

`ptydPath` は spawn する ptyd の場所（ADR-0011）。`notify` と `nameAgentSession` は通知のための口（`docs/packages/notifications.md`）。`github` は GraphQL の URL と token の取り方で、省けば `https://api.github.com/graphql` と `gh auth token --hostname github.com` になる。task の `home` は Bench の worktree と setup の log を置く場所（`docs/packages/task-ledger.md` の「Bench」）。`ghq` は `root()` と `get(repo)` で、省けば `ghq` の command を呼ぶ。テストは偽の GitHub と ghq を渡す。

`systemJobs` は system の Job の並びで、`run` は失敗なら reject する。`now` はテストが時計を進めるための口（`docs/packages/job-ledger.md`）。

`WorkbenchLedger` と `TaskLedger` と `JobLedger` は、Backend が 1 つずつ作り、`GLOSSARY.md` の Workbench Ledger と Task Ledger と Job Ledger を扱う部品で、どれも `start()` / `stop()` を持つ。`WorkbenchLedger` と `TaskLedger` は `events` も持つ。

- `events`: その domain の変更を知らせる in-process の publisher。job は change stream を持たないので無い（ADR-0016）。
- `start()` / `stop()`: 起動時と終了時の処理。`WorkbenchLedger` は ptyd への接続（無ければ spawn、版違いは入れ替え）と reconcile（ADR-0011）、`TaskLedger` は起動時に preparing のまま残った Bench を失敗にすることと、終了時に走っている setup の process group を kill すること、`JobLedger` は起動時に途中で止まった Job Execution を中断にして system の Job を 1 回走らせ、tick の timer を張ることと、終了時にそれを止めること。

`TaskLedger` はほかに `syncInBackground()` だけを持つ。open な Task すべての Sync で、失敗した repo があるか throw したら reject する。5 分おきに呼ぶのは system の Job `task.sync` で、task は timer を持たない（#18、ADR-0016）。

`WorkbenchLedger` は、他の domain から呼ばれる書き込みも持つ。第 1 引数に transaction（`db` でもよい）を取る**同期**の method で、task は `db.transaction((tx) => { workbenchLedger.moveTab(tx, …); insertRun(tx, …) })` のように、両 domain の書き込みを 1 つの transaction にまとめる。fs への副作用は transaction に入らないので別の async method にし、呼び手が commit の後に呼ぶ。ptyd への副作用は workbench が transaction の後に自分で送る（ADR-0015）。`WorkbenchLedger` に出ている書き込みは `createRunspace` / `removeRunspace` / `moveTab` / `openTab` の 4 つ。他の domain が呼ばない書き込みは、同じ形（第 1 引数が tx）の module 内の関数として procedure の handler から呼び、`WorkbenchLedger` には出さない。`createRunspace(tx, { cwd })` が作るのは Tab の無い所有された Runspace で、`removeRunspace(tx, id, { spare? })` はそれを消し、中の Tab の Terminal Session を transaction の後に終わらせる。`spare`（Terminal Session の配列）の Tab が中にあれば、Runspace を消さずに所有を解いてそれらの Tab だけを残し（pin されていれば pin のまま）、ほかの Tab の Terminal Session を終わらせる（ADR-0012）。ptyd の Terminate は冪等で、終わった session に送っても失敗しない。

`openTab(tx, { runspaceId, cwd?, size?, input? }) → { tabId, terminalSessionId }` は、`starting` の Terminal Session の行と Tab を書き、shell を自分で埋め、`{ type: "layout" }` を publish する。Create は transaction の後に workbench が送り、通ったら `input` を Write する。`size` を省けば 24×80 で起こし、表示されていない Tab の shell は attach の resize で追いつく。ptyd は attach していない接続からの Write も通すので、webview が Tab を表示していなくても打てる。Create をまだ送っていない行は reconcile で lost にならないので、呼び手は reconcile を待たない（ADR-0015）。`moveTab(tx, tabId, runspaceId)` は Tab を Runspace の末尾へ移し（`tab.move` と同じ規則）、`{ type: "layout" }` を publish する。Terminal Session の行の状態機械、Create をまだ送っていない集合、transaction の後の Create・Write・Terminate、張り直し（`tab.respawn` と pin）は `packages/workbench/src/terminal-session.ts` に集め、workbench の router の handler も同じ経路を通す。

他の domain から呼ばれない処理は router の handler の中に書いてよい。

### domain をまたぐ規則

- **書き込み**は相手の domain の method を通す。相手の table に直接 INSERT / UPDATE / DELETE しない。lint の `tania/cross-domain-write` が、`@tania/<d>/schema` から import した table を `insert` / `update` / `delete` に渡す形を止める。package のテストと `testing.ts` も対象にする。apps/cli のテストは自分の domain を持たず、task の table に fixture を書くので外す。
- **読み出し**は相手の table を `@tania/<d>/schema` で直接 SELECT してよい。表示状態（#17）や ActiveRun guard のように Agent Session と Run を join する読み出しを procedure 経由にすると N+1 になるため。
- **event は「変わった」の合図**で、購読側は payload を信じず DB を読み直す。bun:sqlite の transaction は同期なので、tx の中で publish しても購読側が動くのは commit 後の microtask になる。rollback されても読み直すだけで害が無いので、commit 後に publish する仕組みは作らない。
- workbench の router を in-process client（`createRouterClient`）で呼ぶ形は採らない。oRPC の呼び出しは async で、drizzle の bun:sqlite の transaction に async 関数を渡すと throw しても rollback されないため（ADR-0009）。
- transaction に async 関数を渡さない。lint の `tania/sync-transaction` が、関数式と、同じ file で定義した async 関数を名前で渡す形を止める。

### Backend の組み立て（`apps/backend/src/main.ts`）

最初に login shell から PATH を 1 回取り（`$SHELL -ilc` で区切り文字に挟んだ `$PATH` を出させる。cwd は `$HOME`、`DISABLE_AUTO_UPDATE=true`）、`process.env.PATH` に入れる。`.app` から起動した Backend は launchd の最小の PATH しか持たず、`gh`・`git`・`ghq`・setup script の中の bun や mise が見つからないため。失敗したら元の PATH のまま stderr に 1 行出す。login shell は stdin を渡さずに起こし（Backend の stdin は Shell の死を知らせる pipe）、5 秒で打ち切る。

Bun.spawn は `env` を渡さないと、子に起動時の environ を渡し、実行ファイルも起動時の PATH で探す。そのため Backend で動くコードの spawn は `env: process.env` を渡す（絶対 path の実行ファイルは除く）。lint の `tania/spawn-env`（`scripts/oxlint/tania.js`）がこれを守る。ptyd は `process.env` から組んだ env を渡すので、Tab にも届く。

1. `$TANIA_HOME/tania.db` を開き、`locking_mode=EXCLUSIVE` → `journal_mode=WAL` → `foreign_keys=ON` の順に設定する（ADR-0007）。
2. `migrate()` を workbench → task → job の順に呼ぶ。`migrationsTable` は各 package の `migrations.table` を渡す。
3. `createWorkbenchLedger` → `createTaskLedger` → `createJobLedger` の順に作る。`createWorkbenchLedger` には、env の `TANIA_PTYD_PATH`（`ptydPath`）、stdout に通知の行を書く `notify`、`@tania/task/server` の `nameAgentSession` を渡す。`createTaskLedger` には同じ `home` を渡す。`createJobLedger` の `systemJobs` には `{ name: "task.sync", every: 5 * 60_000, run: () => taskLedger.syncInBackground() }` を渡す。`TANIA_PTYD_PATH` が無ければ stderr に 1 行出して exit 1 する。
4. router を `{ workbench: workbenchRouter, task: taskRouter, job: jobRouter }` で mount し、context は `{ db, workbenchLedger, taskLedger, jobLedger }`。
5. hono に CORS（`tauri://localhost`・`http://tauri.localhost`。env の `TANIA_DEV_URL` があればその origin も。`docs/packages/dev-loop.md` の「dev loop」）、`/health`（token 無し）、`/rpc/*` の bearer を載せ、`Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 })` で立てる。
6. `start()` を Workbench Ledger → Task Ledger → Job Ledger の順に呼ぶ。Workbench Ledger の `start()`（ptyd への接続と reconcile）を最大 3 秒待ってから、`backend.json` と stdout の endpoint 行を書く（ADR-0007 / 0011）。
7. 終了時は `stop()` を逆順に呼んでから ADR-0007 の手順で抜ける。

domain は 3 つしかないので、汎用の「domain の登録」機構は作らずに直接並べる。

### テスト

package ごとに in-memory の SQLite に自分の migration を当てる（task は workbench → task の順）。外から見える振る舞いは `createRouterClient(router, { context })` を通して確かめ、他の domain から呼ばれる method と module 内の関数（`openTab` など）はそのまま呼ぶ。DB を fake に差し替えない（ADR-0002）。`bun test` を root で打つと全 package のテストが走る。

- workbench の ptyd は `packages/workbench/src/fake-ptyd.ts` に差し替える。fake は `$home/ptyd.sock` で NDJSON を話し、List の中身を台本にし、Exit を押し込み、届いた Reap と Terminate を記録する。本物の ptyd は CI の ts job に無く、Exit と Created の競合も決まった順で起こせないため。home は `mkdtemp(tmpdir())` で短くする（socket の path の上限は 104 byte）。fake と home の helper は `@tania/workbench/testing` から他の package にも出す。
- task の GitHub は `packages/task/src/fake-github.ts` に差し替える。fake は GraphQL の `repository { issue(number:) }` と `pullRequests(headRefName:)` の alias だけを話し、届いた request を記録し、repo ごとの失敗、branch ごとの null の応答、未認証、応答の保留を起こせる。CLI のテストの Task Ledger は `gh auth token` が失敗する GitHub を持ち、本物の GitHub に届かない。
- task と CLI のテストの Workbench Ledger も、fake の ptyd の home で `createWorkbenchLedger` を組む（`ptydPath` は存在しない path）。Workbench Ledger の method は差し替えず、transaction で `openTab` → commit の後に workbench が送る Create と Write を、本物の protocol で通す。procedure と Workbench Ledger の method は ptyd を待たずに返るので、ptyd に届いた Create・Write・Terminate は fake の `received` か `receivedAtLeast` で待ってから確かめ、Terminal Session が starting を抜けるのは `untilSettled` で待つ。Tab と Runspace は Workbench Ledger の method か workbench の router で開き、Agent Session は hook で作る。workbench の table に直に書かない。
- task の ghq は `packages/task/src/fake-ghq.ts` に差し替える。CI の ts job に ghq は無い。fake は一時 directory の `origins/<owner>/<repo>` を origin（default branch は main）にし、`get` でそれを clone して記録する。Bench の準備は本物の git で確かめる。CLI のテストの Task Ledger は失敗する ghq を持つ。
- setup の 600 秒の timeout は、`setTimeout` を `spyOn` してその callback を捕まえ、手で呼ぶ。
- await の間の競合は、await の途中で止めて決まった順で起こす。sync の途中は fake GitHub の `hold()`、git の ref の更新（`branch -D` など）の途中は checkout の `.git/hooks/reference-transaction` が file を待つ script、ptyd の応答の途中は fake の ptyd の `holdNext(op)` で止める（`close.test.ts`）。
- 一定の間隔で走る処理は、`setInterval` を `spyOn` で捕まえ、間隔を確かめてから callback を手で呼ぶ。Bun の `jest.useFakeTimers()` は `Bun.sleep` と `setTimeout` も止め、一部の timer だけを偽にできないので、HTTP の応答を待つテストが進まなくなる。
- 終わった行のように procedure に出ない行は、`@tania/workbench/schema` の table を SELECT して確かめてよい。他の domain が読むのと同じ面だから。
- CLI は remote client を `createRouterClient` に差し替えて回す（ADR-0003。fixture は `apps/cli/src/testing.ts`）。Backend 側のエラーの形と接続拒否の retry だけは、router を `Bun.serve` に載せて確かめる。in-process の client は handler の生の Error を投げ、HTTP のように `ORPCError`（`INTERNAL_SERVER_ERROR`）に包まないため。
- hook の CLI（`tania workbench hook claude`）は例外で、`apps/cli/src/main.ts` を subprocess で起こし、router を `Bun.serve` に載せて確かめる。claude から見た約束（stdin の payload、stdout の allow、exit code）と 2 秒の打ち切り、trpc-cli より前の振り分けは、process の外からしか見えないため。

## contract の規約

1. 合成した contract の root は package 名で mount する（`{ workbench, task, job }`）。path の先頭が package 名になり、CLI もそれに従う（`tania task track`、`tania workbench hook claude`）。
2. 全 procedure に `.meta({ description })` と `.output()` を付ける。description は CLI の help の正本、output は `--format json` の形の正本になる（#17 の JSON の形もここに書く）。
3. CLI に出すのは `.meta({ cli: true })` を付けた procedure だけ（ADR-0003）。event iterator の procedure は付けても出ない。
4. 呼び手が分岐する domain エラー（close の guard のように `data` に理由の一覧を持つもの）だけを `.errors()` で宣言する。それ以外は oRPC の標準 code（`NOT_FOUND`、`BAD_REQUEST`）を投げる。
5. 変更の stream は domain ごとに 1 本（`workbench.changes`、`task.changes`）で、購読する画面の無い job は持たない。判別 union の event を流す。中身は `events` と同じ合図。合図は、その domain の procedure の output が変わる経路すべてで出す。stream だけを購読して読み直す client が、古い output を持ったまま残らないようにするため。他の domain の行から導く output（task の表示状態は workbench の Agent Session から導く）は、相手の合図を受けて自分の合図を出す。
6. `oc.meta(...)` と `createSchemaFactory({ coerce: { date: true } })` は各 package の `contract.ts` の中にだけ書く。oRPC 2.0 で `.meta` が plugin 制になったときに直す場所を 1 つにするため（#21）。例外は `apps/cli/src/forward.ts` で、output を持たない procedure を組み直すために contract の meta を `os.$meta` で引き継ぐ（`docs/packages/cli.md`）。

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

## ここで決めていないこと

- 設定、`$TANIA_HOME` のレイアウト、ログ（map の fog）。
- 署名と notarization（map の fog）。
