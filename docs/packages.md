# パッケージ構成と dev loop

tania の repo の形、package の entry、domain 間の呼び出し、CLI の組み立て、dev と release の手順を決める。骨格を実装するときに最初に読む文書で、実装が進んだらここを今の形に合わせて直す。決定の理由は `docs/adr/` にある（とくに ADR-0002 / 0003 / 0006 / 0009 / 0010 / 0011）。出発点は branch `prototype/stack`・`prototype/workbench`・`prototype/terminal-session` で、骨格の実装 issue は #25 の sub-issue。

## 配置

```
tania/
├── package.json        workspaces・catalog・packageManager・scripts
├── tsconfig.json       1 つだけ
├── Cargo.toml          Rust の workspace（crates/* と apps/desktop/src-tauri）
├── .claude-plugin/     plugin.json・marketplace.json（ADR-0006）
├── scripts/            desktop.ts・build.ts・install-app.ts・tania-dev
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
- `packages/ui` は popover・icon・toast・fuzzy picker・drag reorder のような、domain の語を持たない部品を置く。domain の UI は各 domain package の `ui` entry に置く。

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
| `@tania/<d>/schema` | drizzle の table。`drizzle-orm/sqlite-core` だけを import する | どこでも | 自分の contract と server、他 package の schema（FK）と server（SELECT） |
| `@tania/<d>/contract` | oRPC の contract、zod schema、型 | どこでも | apps/desktop（型だけ）、apps/cli、自分と他 package の server と ui と cli |
| `@tania/<d>/server` | router、`create<D>()`、migrations の re-export | Bun | apps/backend、他 package の server、テスト |
| `@tania/<d>/ui` | React の component と atom | browser | apps/desktop、他 package の ui |
| `@tania/<d>/cli` | 出力の整形関数と手で書く command | Bun | apps/cli |

- 依存の向きは task → workbench だけ。workbench は task を import しない（ADR-0005）。bun の isolated linker では package.json に書いていない依存を解決できないので、向きは package.json が守る。package の中の entry の境界（schema が import してよいもの、ui が server の entry と `bun:sqlite` を import しないこと）と apps どうしの向きは、`.oxlintrc.json` の overrides が lint で守る。
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
export function createTask(deps: { db: Db; workbench: Workbench }): Task;
export function nameAgentSession(db: Db, agentSessionId: string): string | null;
```

`ptydPath` は spawn する ptyd の場所（ADR-0011）。`notify` と `nameAgentSession` は通知のための口（「通知」の節）。

`Workbench` と `Task` は次を持つ。

- `events`: その domain の変更を知らせる in-process の publisher。
- `start()` / `stop()`: 起動時と終了時の処理。workbench は ptyd への接続（無ければ spawn、版違いは入れ替え）と reconcile（ADR-0011）、task は 5 分おきの背景 sync（#18）。
- 他の domain から呼ばれる書き込み: 第 1 引数に transaction（`db` でもよい）を取る**同期**の method。task は `db.transaction((tx) => { workbench.moveTab(tx, …); insertRun(tx, …) })` のように、両 domain の書き込みを 1 つの transaction にまとめる。ptyd や fs への副作用は transaction に入らないので別の async method にし、呼び手が commit の後に呼ぶ。workbench の同期 method は `createRunspace` / `removeRunspace` / `moveTab` / `openTab`、commit 後の async は `startTerminalSession` / `terminateTerminalSessions`（#22）。どれも Task v1 の slice が使うときに `Workbench` へ足す。骨格では同じ形（第 1 引数が tx）の module 内の関数として procedure の handler から呼び、`Workbench` には出さない。`createRunspace` が作るのは所有された Runspace で、`removeRunspace(tx, id, { spare? })` は `spare` の Tab だけを残して所有を解ける（ADR-0012）。

`openTab` が書く `starting` の Terminal Session の行は、workbench の reconcile が終わってから書く。reconcile の途中で書くと、ptyd の List に無い行として lost にされる。骨格では行に書く shell を `shellWhenReady(workbench)` が reconcile を待ってから返し、handler は transaction の前にこれを await する。

他の domain から呼ばれない処理は router の handler の中に書いてよい。

### domain をまたぐ規則

- **書き込み**は相手の domain の method を通す。相手の table に直接 INSERT / UPDATE / DELETE しない。
- **読み出し**は相手の table を `@tania/<d>/schema` で直接 SELECT してよい。表示状態（#17）や ActiveRun guard のように Agent Session と Run を join する読み出しを procedure 経由にすると N+1 になるため。
- **event は「変わった」の合図**で、購読側は payload を信じず DB を読み直す。bun:sqlite の transaction は同期なので、tx の中で publish しても購読側が動くのは commit 後の microtask になる。rollback されても読み直すだけで害が無いので、commit 後に publish する仕組みは作らない。
- workbench の router を in-process client（`createRouterClient`）で呼ぶ形は採らない。oRPC の呼び出しは async で、drizzle の bun:sqlite の transaction に async 関数を渡すと throw しても rollback されないため（ADR-0009）。

### Backend の組み立て（`apps/backend/src/main.ts`）

最初に login shell から PATH を 1 回取り（`$SHELL -ilc` で区切り文字に挟んだ `$PATH` を出させる。cwd は `$HOME`、`DISABLE_AUTO_UPDATE=true`）、`process.env.PATH` に入れる。`.app` から起動した Backend は launchd の最小の PATH しか持たず、`gh`・`git`・`ghq`・setup script の中の bun や mise が見つからないため。失敗したら元の PATH のまま stderr に 1 行出す。

1. `$TANIA_HOME/tania.db` を開き、`locking_mode=EXCLUSIVE` → `journal_mode=WAL` → `foreign_keys=ON` の順に設定する（ADR-0007）。
2. `migrate()` を workbench → task の順に呼ぶ。`migrationsTable` は各 package の `migrations.table` を渡す。
3. `createWorkbench` → `createTask` の順に作る。`createWorkbench` には、env の `TANIA_PTYD_PATH`（`ptydPath`）、stdout に通知の行を書く `notify`、`@tania/task/server` の `nameAgentSession` を渡す。`TANIA_PTYD_PATH` が無ければ stderr に 1 行出して exit 1 する。
4. router を `{ workbench: workbenchRouter, task: taskRouter }` で mount し、context は `{ db, workbench, task }`。
5. hono に CORS（`tauri://localhost`・`http://tauri.localhost`・`http://localhost:1420`）、`/health`（token 無し）、`/rpc/*` の bearer を載せ、`Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 })` で立てる。
6. `start()` を workbench → task の順に呼ぶ。workbench の `start()`（ptyd への接続と reconcile）を最大 3 秒待ってから、`backend.json` と stdout の endpoint 行を書く（ADR-0007 / 0011）。
7. 終了時は `stop()` を逆順に呼んでから ADR-0007 の手順で抜ける。

domain は 2 つしかないので、汎用の「domain の登録」機構は作らずに直接並べる。

### テスト

package ごとに in-memory の SQLite に自分の migration を当てる（task は workbench → task の順）。外から見える振る舞いは `createRouterClient(router, { context })` を通して確かめ、他の domain から呼ばれる method と module 内の関数（`openTab` など）はそのまま呼ぶ。DB を fake に差し替えない（ADR-0002）。`bun test` を root で打つと全 package のテストが走る。

- workbench の ptyd は `packages/workbench/src/fake-ptyd.ts` に差し替える。fake は `$home/ptyd.sock` で NDJSON を話し、List の中身を台本にし、Exit を押し込み、届いた Reap と Terminate を記録する。本物の ptyd は CI の ts job に無く、Exit と Created の競合も決まった順で起こせないため。home は `mkdtemp(tmpdir())` で短くする（socket の path の上限は 104 byte）。
- 終わった行のように procedure に出ない行は、`@tania/workbench/schema` の table を SELECT して確かめてよい。他の domain が読むのと同じ面だから。
- CLI は remote client を `createRouterClient` に差し替えて回す（ADR-0003。fixture は `apps/cli/src/testing.ts`）。Backend 側のエラーの形と接続拒否の retry だけは、router を `Bun.serve` に載せて確かめる。in-process の client は handler の生の Error を投げ、HTTP のように `ORPCError`（`INTERNAL_SERVER_ERROR`）に包まないため。

## contract の規約

1. 合成した contract の root は package 名で mount する（`{ workbench, task }`）。path の先頭が package 名になり、CLI もそれに従う（`tania task track`、`tania workbench hook claude`）。
2. 全 procedure に `.meta({ description })` と `.output()` を付ける。description は CLI の help の正本、output は `--format json` の形の正本になる（#17 の JSON の形もここに書く）。
3. CLI に出すのは `.meta({ cli: true })` を付けた procedure だけ（ADR-0003）。event iterator の procedure は付けても出ない。
4. 呼び手が分岐する domain エラー（close の guard のように `data` に理由の一覧を持つもの）だけを `.errors()` で宣言する。それ以外は oRPC の標準 code（`NOT_FOUND`、`BAD_REQUEST`）を投げる。
5. 変更の stream は domain ごとに 1 本（`workbench.changes`、`task.changes`）で、判別 union の event を流す。中身は `events` と同じ合図。
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
- `src/backend.ts` が Backend の探索（`backend.json` の読み出し、不在時の即 exit 2、接続拒否時の 200ms × 3 秒 retry。ADR-0007）と `RPCLink` の生成を 1 箇所で持つ。手書き command には `connect(): Client | null` として渡す。
- 転送 router（`src/forward.ts`）は contract を走査し、`cli: true` の葉を「remote を呼ぶ → 整形して出力する → `undefined` を返す」handler に置き換える。`undefined` を返すので、trpc-cli の YAML / 表の logger は何も出さない。
- input に `terminalSessionId` を持つ procedure（`current`、`attach`、`close`）には、転送 router が env の `TANIA_TERMINAL_SESSION_ID` を埋める。flag には出さない。
- `--format text|json` は `buildProgram` で global option として足す（既定は text）。json は procedure の output をそのまま出す。text は `@tania/<d>/cli` の整形関数を procedure の path で引く。整形の識別子は英語（#17）。
- エラーは常に stderr に 1 行 `CODE: message` を出す。trpc-cli は `ORPCError` を cause に剥がして表示し、remote 由来の `ORPCError` は cause を持たないので、転送 handler が `` new Error(`${code}: ${message}`, { cause }) `` に包んで投げ直す（#8 の詰まった点 1）。stack を出さないよう trpc-cli の `formatError` で message だけにする。`--format json` のときも stdout には成功時の output だけを出す。
- exit code は 0 = 成功、1 = それ以外の失敗、2 = Backend 不在。trpc-cli は usage エラーも handler の throw も 1 で `process.exit` を自分で呼ぶので、`run({ process: { exit } })` で差し替え、投げ返される `FailedToExitError` を catch して写像する。
- `prompts: false` を固定する。
- completions は trpc-cli の生成に任せる（#12）。
- hook の受け口は `tania workbench hook claude`（`@tania/workbench/cli` の手書き command）。仕様は「tab の env と shim」の節。
- SKILL.md と CLI を突き合わせる検査テストは apps/cli に置く（ADR-0006）。
- oRPC 2.0 で `RPCLink` の引数が変わったときに直すのは `apps/cli/src/backend.ts` と `apps/desktop/src/backend.ts` の 2 箇所だけ（#21）。

## desktop（apps/desktop）

- `src/` は app の枠だけを持つ。layout、shortcut、Backend client の provider、Shell からの `backend-endpoint` event による再接続、Backend 不在の表示。domain の画面は `@tania/<d>/ui` から読む。
- Backend の endpoint の受け取りと不在の表示:
  - 起動時は Shell の `backend_endpoint` command で今の endpoint（無ければ null）を取り、以降は `backend-endpoint` event で受ける。listen する前に出た event を取りこぼさないため。
  - Shell は Backend の予期しない終了で endpoint を捨てたら、`backend-endpoint` に null を載せて出す。再起動を諦めたら `backend-failed` を出す（ADR-0007）。
  - webview は endpoint が 1 秒以上 null のままなら、Workbench の上端に 1 行「Backend に再接続中…」を出す。`bun --watch` の再起動（約 100ms）でちらつかないよう 1 秒待つ。`backend-failed` では「Backend を起動できません」と「再試行」を出し、再試行は Shell の `backend_restart` command（失敗回数を戻して spawn する）を呼ぶ。
  - 端末の byte は Shell を通るので、Backend が居ない間も打鍵と出力は続く。画面を塞がず、layout を変える操作だけが toast で失敗する。
- domain の ui には自分の contract の client だけを渡す（workbench の ui は `client.workbench`）。oRPC の client は callable な Proxy なので、React の state に入れるときは `setState(() => client)`（#8 の詰まった点 5）。
- Shell の terminal command と `clipboard_write_image` を呼ぶ wrapper（monica の `commands/terminal.ts`）は `packages/workbench/src/ui` に置く。
- 画像の drop は monica のとおり、Tauri の drag-drop event の path を `clipboard_write_image` に渡し、成功したら active な Tab に `terminal_write` で Ctrl-V（`\x16`）を送る。Ctrl-V で clipboard の画像を読むのは agent の振る舞いなので、Shell の command にまとめない。失敗したら `packages/ui` の toast で 1 行出す（monica は黙っていた）。
- Workbench の画面が使う、Shell に置かない monica の command は `workbench` の procedure にする（`cli: true` は付けない）。
  - `worktree.info({ cwd })` → `{ repo, branch } | null`: `git -C <cwd> rev-parse --abbrev-ref HEAD --path-format=absolute --git-dir --git-common-dir`。linked worktree のときだけ値を返し、`repo` は common dir の親の名前。Runspace の title（`repo:branch`）に使い、webview は path ごとに cache して 5 秒で間引く。
  - `editor.resolve({ cwd, candidates })` → `(string | null)[]`: `~` を展開し、相対なら cwd に join して `realpath` する。失敗したら末尾の `:<数字>` を最大 2 つ外して再試行する。terminal の link 検出が hover のたびに 1 行分をまとめて呼び、null の候補は link にしない。
  - `editor.open({ path })` → `void`: `/usr/bin/open -a Zed <path>`。Zed は固定で、line:col は渡さない。webview は失敗を握りつぶす。
- URL を開くのは webview から plugin-opener の `openUrl` で行う（http(s)・mailto・tel）。
- workbench の ui は Task の要素を出す場所を 2 つの slot として props で受け、apps/desktop が `@tania/task/ui` の component をはめる（slot は Task v1 の slice 2 と 4 が足す）。`renderRunspaceLabel(runspaceId)`（Bench のラベル `<repo>#<n> <title>`、準備中・準備失敗のときだけその語を添える）と `tabMenuItems(tab)`（「Attach to Task…」の picker）。task の ui は `task.bench.list`（`{ runspaceId, ref, title, setupState }[]`）と `task.changes` で描き直す。workbench の ui は Task を import しない（ADR-0005）。
- Tailwind の `@source` に `packages/*/src/ui` を足す。
- `src-tauri/` は Shell。Backend の監督（ADR-0007）、terminal の中継、OS への窓口だけを持つ。窓口は通知（ADR-0013）、画像の clipboard、plugin-opener、drag-drop の event。custom command は terminal の attach / detach / write / resize の 4 本（ptyd は spawn しない。ADR-0011）、`clipboard_write_image`、`backend_endpoint`、`backend_restart` の 7 本。
- Shell に置くのは、Tauri プロセスにしか無いもの（窓と webview の event、app の名義、AppKit）に触る処理と、Backend の再起動で途切れてはいけない terminal の byte だけ（ADR-0001）。fs と process の spawn で済む処理（worktree の判定、エディタ）は Backend の procedure にする。
- `clipboard_write_image(path)` は monica の objc2 の実装（`NSImage::initWithContentsOfFile` を general pasteboard に `writeObjects`）を持ち込む。NSPasteboard は main thread で呼ぶので、sync command のままにする。

## Workbench の帳簿

`packages/workbench` の contract と行の規則。table の下書きは #22 の resolution、Agent Session の遷移表は #36 の resolution にある。

### contract（root は `workbench`）

```
terminalSession.list       → TerminalSession[]（tabId を join）                               cli
terminalSession.terminate  { id }
layout.get                 → { runspaces: [{ id, cwd, sortOrder,
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
- Task v1 が足すもの: `layout.get` の Runspace の所有の印（slice 2）と、所有された Runspace を断る規則。
- `terminal_session.shell` は Backend の起動時に 1 回決める。`$SHELL`、無ければ `os.userInfo().shell`、それも無ければ `/bin/zsh`。reconcile で ptyd から取り込んだ行は `""`。

### Runspace と Tab

所有されていない Runspace は常に Tab を 1 つ以上持ち、Backend がそれを守る（`GLOSSARY.md` の Runspace）。

- `sort_order` は、Runspace と Tab を足す・移す・消すたびに、同じ transaction の中で兄弟を 0..n-1 に振り直す。`runspace.create` と `tab.open` の `index` を省けば末尾に足す。webview は active の次を渡し（monica どおり）、CLI と Task は省く。
- Tab の title は帳簿に持たない。OSC 0/2 の title は webview の memory にだけ持ち、再 attach のときは transcript の replay に含まれる OSC で戻る。表示は monica どおり title、無ければ cwd の末尾、それも無ければ `Terminal`。title はよくある zsh の theme なら command のたびに変わり、帳簿に書くとそのたびに `changes` と `layout.get` が往復するため。
- `tab.respawn` は exited / lost / failed の Tab に新しい session を結び直す。overlay の「New shell in …」と「Retry」が呼ぶ（monica どおり）。
- `tab.cwd` は最後に分かった cwd。webview は OSC 7 の cwd が前の値と変わったときだけ `tab.setCwd` を呼ぶ（OSC 7 は prompt のたびに来る）。Backend の張り直し（「pin」の節）と `tab.respawn` はこの cwd で始め、Runspace の title（`worktree.info`）も再起動の直後はこれを使う。

- `runspace.create { cwd?, rows, cols } → { runspaceId, tab }` は、Runspace・Tab・`starting` の Terminal Session を 1 transaction で作り、commit 後に Create する（`tab.open` と同じ形）。cwd を省けば `$HOME`。空の Runspace を作ってから `tab.open` を呼ぶ 2 段にすると、間で webview の reload や Backend の再起動が起きたときに空の Runspace が残り、消す規則が無いため。
- `tab.open` の cwd を省けば、新しい Terminal Session は Runspace の cwd で始める。reattach の Tab は Terminal Session の cwd を持ち、OSC 7 の `tab.setCwd` で追いつく。
- `tab.close` と `tab.move` は、Tab が抜けて 0 になった所有されていない Runspace を同じ transaction で消す。CLI の Attach のように webview の無い経路でも、空の Runspace が残らない。所有された Runspace（Bench）を残す例外は、Task v1 の slice 2 が所有の印と一緒に足す（ADR-0012）。
- layout が空になったら、webview が `runspace.create` で 1 つ作る（monica の `initialState()`）。
- shell が終わった Tab は webview が閉じる。接続中の Tab で Shell の Exit を受けたら、webview が `tab.close` を呼ぶ（monica どおり）。Backend は行を exited にするだけで、Tab を閉じない。exit の時点で接続していなかった Tab と、lost / failed の Tab は、overlay を出したまま `tab.respawn` か `tab.close` を待つ。pin された Tab は例外で、webview は閉じず、Backend が張り直す（「pin」の節）。

### pin

`GLOSSARY.md` の Pin を帳簿で守る。帳簿に置く理由は ADR-0014。

- `tab.pinned`（既定 false）に `(runspace_id) WHERE pinned` の部分 unique index を張り、`layout.get` の Tab に載せる。
- `tab.pin { id }`: Runspace に pin された別の Tab があれば、pin をこの Tab に付け替える。無ければ、所有されていない Runspace にほかの Tab があるとき、新しい Runspace（cwd は Tab の cwd、並びは末尾）を作って Tab を移してから立てる。それ以外はその場で立てる。所有された Runspace（Bench）でその場で立てる分岐は、Task v1 の slice 2 が所有の印と一緒に足す。
- `tab.unpin { id }`: 印を外すだけで、元の Runspace には戻さない。
- `tab.close`、`terminalSession.terminate`、`runspace.remove` は、pin された Tab が対象か中にあれば `CONFLICT` で断る。
- `tab.move` と `moveTab`（Attach）は、Tab を別の Runspace へ移したら同じ transaction で pin を外す。同じ Runspace の中の並べ替えでは外さない。
- `removeRunspace`（Task の close）は pin を見ない。Bench の pin された Tab も他の Tab と同じく消える。
- webview は ⌘P で pin を切り替える（monica どおり）。sidebar は pin された Tab を持つ Runspace を先頭の Pinned グループにまとめ、グループの中は `sort_order` 順に並べる。drag でグループはまたげない。

張り直し:

- Backend は Exit を受けて行を exited にし、Reap した後で、その Terminal Session を指す Tab が pin されていれば、新しい `starting` の session を作って Tab に結び直し、commit 後に Create する（`tab.respawn` と同じ形）。size は 24×80 で始め、attach の resize で追いつく。
- reconcile で exited か lost にした行も、pin された Tab が指していれば、reconcile の後に同じく張り直す。
- 張り直さないのは、failed の行と、`ended_at - created_at` が 2 秒未満の行。その Tab は overlay を出したまま `tab.respawn` を待つ。`.zshrc` が壊れていて即死を繰り返す shell を、起こし続けないため。
- Exit の時点で Tab が無いか pin されていなければ、何もしない。Task の close で消えた Bench の Tab は張り直さない。
- webview は、`changes` で Tab の `terminalSessionId` が替わったら、新しい session に attach し直す。

### 終わった行

- exited / lost / failed の `terminal_session` と、終了の `agent_session` の行は消さない。Run の行は履歴として消さず（Task v1）、`run.agent_session_id` → `agent_session.terminal_session_id` の FK が残るため。1 行は 200 byte 程度で、GC の読み手もいない。
- 一覧は画面が使う行に絞る。
  - `terminalSession.list` は、live か Tab に指されている行だけを返す。Detached グループと Tab の overlay の材料。CLI の `tania workbench terminal-session list` も同じものを出す。
  - `agentSession.list` は、終了でない行だけを返す。status dot の材料（「Workbench の UI 状態と status dot」の節）。

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
- `.zshrc` の最後で `$TANIA_HOME/bin` を PATH の先頭に置き直す。ユーザーの rc が PATH の前に何を足しても、dev の tab の `tania` と `claude` は `$TANIA_HOME/bin` のものを指す。
- `.zlogin` の最後で ZDOTDIR をユーザーの値に戻して export する（元が未設定なら unset）。tab から起こした子（dev の desktop、tmux、Claude Code の Bash tool）は shim を通らない。
- `claude` の shell 関数は定義しない。Claude Code の Bash tool は shell 関数を snapshot に取り込むので、関数にすると agent の中から起こした `claude` にも効いてしまう。

### claude wrapper（`$TANIA_HOME/bin/claude`）

- PATH から自分の directory 以外の `claude` を探して exec する。
- `TANIA_TERMINAL_SESSION_ID` があり、`CLAUDECODE` が無いときだけ `--settings $TANIA_HOME/shell/claude/settings.json` を足す。`CLAUDECODE` があるのは agent の Bash tool から起こした入れ子の claude で、hook を付けると同じ Terminal Session の SessionStart が親の Agent Session を superseded にする（ADR-0008）。
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

Agent Session がユーザー待ちに入ったときに macOS の通知を出す（ADR-0013、語は `GLOSSARY.md` の通知）。判定と本文は workbench が持ち、OS に渡すのは Shell が持つ。Task の無い Tab でも出すので、観測と同じく Workbench を持ち込む骨格の実装に含める。task が足すのは `nameAgentSession` だけで、Task v1 の Run の slice に入る。

### 出す遷移

`recordHook` が遷移を書いて commit した後、`notificationFor(前の行 | null, event, 次の行)` が通知の理由を返す。`transition` の隣に置く純関数。

| 次の状態 | 出す条件 |
|---|---|
| 質問・許可・エラーの待ち | 新しい待ちに入った（`state_changed_at` が変わった） |
| 手空き | 前の行が動作中か未観測で、event が Stop |
| それ以外 | 出さない |

- 質問とエラーは、前の行が同じ理由の待ちでないときに新しい待ちになる。PreToolUse(AskUserQuestion) と PermissionRequest(AskUserQuestion) は同じ質問なので 1 回しか出ない。
- 許可は、PermissionRequest（ExitPlanMode と AskUserQuestion を除く）が来るたびに新しい待ちになる。前の行が許可待ちでも、`transition` は `state_changed_at` を更新する。許可した tool が動いている間は許可待ちに見えたままなので、その間に background の subagent が次の許可を求めたときに取りこぼさないため。PermissionRequest に `tool_use_id` は無く、同じダイアログかどうかは見分けられない。
- SessionStart による手空き（起動・resume の直後）と、待ちから手空きへの変化では出さない。
- agent の仕事が残っている Stop は遷移しないので出ない。agent の仕事が終わった後に Claude Code が自分で起こす turn の Stop で出る。
- 未知の session_id は動作中の行を作ってから遷移を当てる（ADR-0008）ので、最初の event が Stop なら出る。
- PermissionRequest(ExitPlanMode) は遷移しないので、プランの自動承認では出ない。
- edge 1 つに通知 1 つ。dedupe key、outbox、Backend の再起動時のまとめ出しは持たない。
- test は遷移表と同じく表駆動で書く。

### title と body

- title は呼び名。`nameAgentSession(db, agentSessionId)` が文字列を返せばそれを使う。null なら Agent Session の cwd の末尾 2 つ（monica の `shortPath`）を使う。長さは切らない（macOS が切る）。
- `nameAgentSession` は table を読むだけの関数。その Agent Session の Run の Task を引き、無ければ Tab → Runspace → Bench の Task を引いて（CLI の `current` と同じ順）、Bench のラベルと同じ `<repo>#<n> <title>` を返す。後ろの経路は、SessionStart を取りこぼして Run がまだ無い Agent Session のためにある。
- body は理由。`手空き`、`質問`、`許可: <tool>`、`エラー: <error_type>`（error_type が無ければ `エラー`）。
- 音は鳴らさない。

### Backend と Shell

- apps/backend が `createWorkbench` に渡す `notify({ title, body })` は、stdout に `{"type":"notify","title","body"}` を 1 行書く。test では `notify` と `nameAgentSession` を差し替える。
- Backend の stdout は Shell 宛ての JSON 行専用（ADR-0007）。Backend の log は stderr に出す。
- Shell は stdout の行を `type` で振り分ける。`endpoint` は `backend-endpoint` event に、`notify` は tauri-plugin-notification の `app.notification().builder().title(..).body(..).show()` に渡す。解釈できない行は Shell の log に流して捨てる。
- plugin の macOS 実装は NSUserNotificationCenter なので、取り下げ、クリックの受け取り、最前面でのバナーは無い。クリックすると tania が前面に出るだけ。
- dev の通知は plugin が Terminal.app の名義で出す（`tauri::is_dev()` で切り替わる）。Terminal.app に通知の許可が要る。見た目は `bun run install-app` で入れた release で確かめる。

## dev loop

- `bun run desktop` が `scripts/desktop.ts` を走らせる。
  1. `TANIA_HOME` が無ければ `~/.tania-dev` を設定し、`TANIA_BIN=<repo>/scripts/tania-dev` を設定する。
  2. `cargo build -p tania-ptyd` を行い、externalBin の位置に `tania-ptyd`・`tania-backend`・`tania` を置く（tauri-build がファイルの存在を要求するため。debug の Shell は使わないので placeholder でよい）。
  3. `tauri dev --config src-tauri/tauri.dev.conf.json` を起動する。dev の config は identifier に `.dev` を付けて release と別 instance にし（ADR-0007）、`beforeDevCommand` は vite だけ。
- debug build の Shell は Backend として `bun --watch apps/backend/src/main.ts` を起動し、ptyd の場所 `target/debug/tania-ptyd`（`TANIA_PTYD_PATH` で差し替え可）を env `TANIA_PTYD_PATH` で Backend に渡す。ptyd を spawn するのは Backend で、場所は debug でも release でも Shell が env `TANIA_PTYD_PATH` で渡す（release は Shell の隣の `tania-ptyd`。ADR-0011）。Backend は package や apps/backend の編集と `bun run generate` で同じ pid のまま再起動し、webview は `backend-endpoint` event で再接続する。byte は Shell の ptyd 接続を通るので、この再起動で端末は切れない。
- webview は vite の HMR。package の `ui` も source のまま読む。
- `bun run tania <args>` は `scripts/tania-dev`（`bun apps/cli/src/main.ts "$@"`）を呼ぶ。`TANIA_HOME` が無ければ `~/.tania-dev`。
- desktop は起動時に `$TANIA_HOME/bin/tania` → `TANIA_BIN` の symlink を張る。release の desktop だけが `~/.local/bin/tania` にも張る（ADR-0006）。dev の desktop が張ると release の CLI を上書きするため。Workbench の tab の PATH に `$TANIA_HOME/bin` を前置するのは shim（「tab の env と shim」の節）。
- `TANIA_HOME` は direnv に書かない（ADR-0006）。
- `.claude/skills` は生成しない。Skill は plugin として repo から in-place で読まれる（ADR-0006）。
- cargo の初回 build は約 36 秒（#8）。

## release build と install

- `bun run build` が `scripts/build.ts` を走らせる。
  1. `cargo build --release -p tania-ptyd`
  2. Backend: `bun build --compile --minify-whitespace --minify-syntax --bytecode --format=esm --asset packages/workbench/migrations/workbench --asset packages/task/migrations/task apps/backend/src/main.ts`
  3. CLI: `bun build --compile --minify-whitespace --minify-syntax --bytecode --format=esm apps/cli/src/main.ts`
  4. 3 つの binary を `apps/desktop/src-tauri/binaries/<name>-<rust triple>` に置き、`tauri build --bundles app`
- `--minify` は使わない。trpc-cli が class 名で instanceof を判定しており、名前が潰れると起動しない。`--bytecode` は top-level await があるので `--format=esm` が要る。
- compiled binary は Bun の runtime だけで約 60MB あり、Backend と CLI で約 120MB になる。
- `bun run install-app` は `.app` を `/Applications` にコピーし、codesign と quarantine の解除を行う（monica の `just install-app` と同じ）。
- 署名と notarization（hardenedRuntime 下の Bun の JIT entitlements。Bun の binary は Backend と CLI の 2 つ）は配布を始めるときに決める。

## 検査と CI

- 検査は `bun run check` に集める。何を流すかの正本は `package.json` の `check:ts` と `check:rust` で、CI の job も同じ script を呼ぶ。apps/desktop ができたら、`vite build` を `check:ts` に足す（「entry」の節の bundle の検査）。
- Rust の検査は macOS の runner で流す。Tauri の crate が macOS の system library を要るため。
- Rust の検査は、Rust に関わる file が変わったときだけ走らせる（対象は `ci.yml` の `changes` job の filter）。private repo では macOS の runner の 1 分が 10 分に数えられ、crate は monica から rename しただけで骨格の後はほとんど変わらないため。GitHub Actions には job 単位の paths filter が無いので、判定は ubuntu の小さな job で行う。
- tauri の bundle build、knip、jscpd、lefthook は入れない。

## 版

- Bun は `package.json` の `packageManager` で固定し、CI も同じ版を使う。1.4 未満には `--asset` が無い。
- Rust は `rust-toolchain.toml` で `Cargo.toml` の `rust-version` と同じ版に固定し、CI も同じ file から入れる。stable を追うと、clippy に足された lint で、crate に触れた PR が変更と関係なく落ちるため。
- 依存の版は root の `workspaces.catalog` に集め、member は `catalog:` で参照する。`@orpc/*` は trpc-cli が対応する major に固定する（ADR-0003）。
- tsconfig は root の 1 つで、`types: ["bun"]` と DOM の lib を同居させる。browser 側の安全性は `vite build` に任せる。
- scripts は root の `package.json` に並べ、1 行に収まらないものは `scripts/*.ts` に書く。just は使わない。

## ここで決めていないこと

- 設定、`$TANIA_HOME` のレイアウト、ログ（map の fog）。
- 署名と notarization（map の fog）。
