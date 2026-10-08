# パッケージ構成

monica の repo の形、package の entry、domain 間の呼び出し、テスト、contract の規約を決める。決定の理由は各規則に添えた ADR（`docs/adr/`）にある。規則を変える変更は、同じ PR でここと `docs/packages/` の文書を今の形に直す。

## 索引

この文書には、どの作業も読む規則を置く。ほかの規則は `docs/packages/` に分けてあり、作業がその範囲に触るときに読む。

- `docs/packages/workbench-ledger.md`: workbench の contract と Workbench Ledger。workbench の procedure、他の domain から Workbench Ledger の method を呼ぶとき、ptyd に送るもの、reconcile、pin、Agent Session の行と未読に触るとき。
- `docs/packages/workbench-ui-state.md`: workbench の ui。Workbench の画面の状態、sidebar、status dot、未読の見せ方、通知のクリックに触るとき。
- `docs/packages/tab-env-and-shim.md`: Tab の env、shim、claude wrapper、hook の settings と CLI、payload の decoder に触るとき。
- `docs/packages/notifications.md`: 通知と Dock の数と取り下げ。通知を出す遷移、title と body、Shell が出す通知、未読の集合、Dock の数、通知センターの通知の置き換えと取り下げに触るとき。
- `docs/packages/task-ledger.md`: task の contract と Task Ledger。task の procedure、Run、Bench の準備、close、sync、task のテストの fake に触るとき。
- `docs/packages/job-ledger.md`: job の contract と Job Ledger。job の procedure、system の Job を足すとき、裏で定期的に走る処理に触るとき。
- `docs/packages/note-ledger.md`: note の contract と Note Ledger と body。note の procedure、画像、OGP、本文の JSON と markdown の変換に触るとき。
- `docs/packages/note-ui.md`: note の ui。`packages/note/src/ui` か `apps/web` に触るとき、旧 Monica のコードを移すとき。
- `docs/packages/backend.md`: Backend の組み立て（apps/backend）。起動と終了の順序、PATH、Ledger の配線、notes の口に触るとき。
- `docs/packages/cli.md`: CLI（apps/cli）。`cli: true` の procedure か SKILL.md を足すとき、argv の振り分け・出力・エラー・補完・CLI のテストに触るとき。
- `docs/packages/desktop.md`: desktop（apps/desktop）。webview の枠、キーの扱い、domain の ui の載せ方と Task の slot、Shell（`src-tauri`）に触るとき。
- `docs/packages/migration.md`: migration。table を足すか変えるとき、domain の package を足すとき。
- `docs/packages/dev-loop.md`: dev loop、release、検査、版。dev の起動、scripts、release の build、CI、依存と tsconfig に触るとき、テストが誤りを捕まえるかを変異で確かめるとき。

## 配置

```
monica/
├── package.json        workspaces・catalog・packageManager・scripts
├── tsconfig.json       1 つだけ
├── Cargo.toml          Rust の workspace（crates/* と apps/desktop/src-tauri）
├── .claude-plugin/     plugin.json・marketplace.json（ADR-0006）
├── scripts/            desktop.ts・dev-instance.ts・dev.ts・build.ts・install-app.ts・check-brief.ts・test.ts・monica-dev・oxlint/
├── apps/
│   ├── backend/        @monica/backend   Backend の組み立て
│   ├── cli/            @monica/cli       bin は monica
│   ├── desktop/        @monica/desktop   src/ が webview、src-tauri/ が Shell
│   └── web/            @monica/web       ブラウザに配る notes の画面の組み立て
├── packages/
│   ├── workbench/      @monica/workbench
│   ├── task/           @monica/task
│   ├── job/            @monica/job
│   ├── note/           @monica/note
│   └── ui/             @monica/ui        domain を持たない UI 部品
└── crates/
    ├── terminal-protocol/
    ├── terminal-daemon/
    ├── terminal-client/
    ├── ptyd/
    └── logfile/
```

- apps は packages を組み立てるだけでロジックを持たない（ADR-0002）。apps どうしは互いを import しない。
- Rust の `target/` と `Cargo.lock` は root に 1 つ。crate 名は `monica-<dir>`（`monica-ptyd` など）。terminal 5 crate は旧 Monica から持ち込んだもの（#11）。
- `packages/ui` は popover・icon・toast・fuzzy picker・drag reorder のような、domain の語を持たない部品を置く。CLI の整形関数が使う表（`@monica/ui/table`）もここに置く。cli entry は apps/cli だけが import するので、domain の cli entry どうしでは共有できないため。domain の UI は各 domain package の `ui` entry に置く。

### ドメイン package の中

```
packages/<d>/
├── package.json
├── drizzle.config.ts      out: "./migrations/<d>"
├── migrations/
│   ├── index.ts           { folder, table, latest } と _journal.json の import
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

entry は層ではなく、import してよい実行環境で切る（ADR-0009）。domain の package は root の `"."` を置かない。

| entry | 中身 | 実行環境 | import する側 |
|---|---|---|---|
| `@monica/<d>/schema` | drizzle の table。`drizzle-orm/sqlite-core` と `drizzle-orm` 本体（CHECK と index の条件を書く `sql`）と、FK のための他 package の schema だけを import する | どこでも | 自分の contract と server、他 package の schema（FK）と server（SELECT） |
| `@monica/<d>/contract` | oRPC の contract、zod schema、型 | どこでも | apps/desktop と apps/web（型だけ）、apps/cli、apps/backend、自分と他 package の server と ui と cli |
| `@monica/<d>/server` | router、`create<D>Ledger()`、migrations の re-export | Bun | apps/backend、他 package の server、テスト |
| `@monica/<d>/ui` | React の component と atom。画面を持たない job には無い | browser | apps/desktop、apps/web（note）、他 package の ui |
| `@monica/<d>/cli` | 出力の整形関数、補完の候補を返す関数、手で書く command。CLI に出す procedure の無い note には無い | Bun | apps/cli |
| `@monica/<d>/body` | Note の本文の JSON を読む関数と、本文と markdown の変換（`docs/packages/note-ledger.md`）。今は note だけが持つ | どこでも | 自分の contract と server と ui |
| `@monica/<d>/testing` | 他の package のテストに出す fake。今は workbench だけが持ち、`src/fake-ptyd.ts` の fake の ptyd（`startFakePtyd`）、短い home を作る `tempHome`、Terminal Session が starting を抜けるのを待つ `untilSettled` を出す | Bun | 他 package のテストと `testing.ts` |

- 依存の向きは task → workbench だけ。workbench は task を import しない（ADR-0005）。job は task も workbench も import しない（ADR-0016）。note は他の domain を import せず、他の domain からも import されない。
- task の schema は workbench の table を FK のために import するが、re-export しない（ADR-0010）。
- 境界は次のものが守る。
  - package の間の向き: package.json。bun の isolated linker では package.json に書いていない依存を解決できない。
  - package の中の entry の境界と apps どうしの向き: `.oxlintrc.json` の overrides。schema が import してよいもの、ui が server の entry と `bun:sqlite` を import しないこと、body が `bun:sqlite`・`drizzle-orm`・schema と server の entry を import しないこと、cli entry を import するのが apps/cli だけであることを見る。no-restricted-imports の設定は override をまたいで重ならないので、file の集合ごとの制限とは別の rule にしている。
  - CLI と webview とブラウザで動くコード（apps/cli、apps/desktop、apps/web、各 package の cli entry と ui entry）が DB に触るもの（`bun:sqlite`、`drizzle-orm`、schema entry と server entry の値）を import しないこと: 同じ overrides（ADR-0003）。cli entry で見るのは `cli.ts` の import だけで、`cli.ts` が import する内側のファイルは見ない。apps/cli のテストと `testing.ts` は in-memory の Backend を組むので、この制限から外す。
  - testing entry を import するのがテストと `testing.ts` だけであること: lint の `monica/testing-entry`。
  - body の entry から辿れる module が DB に触るものを読まないこと: `packages/note/src/body/entry.test.ts`。lint は直接の import しか見ないので、contract のような内側の module を経た import はこのテストが見る。
  - entry の override の書き忘れ: `scripts/oxlint/entry-boundaries.test.ts`。各 package の `exports` にある cli・ui・body・schema の entry と同じ path に禁じた import を並べた file を一時 directory に置き、oxlint を当てて全部が止まるかを見る。package を足して override を書き忘れると落ちる。
  - webview の bundle に `bun:sqlite` や `@orpc/server` が混ざらないこと: `vite build`。混ざれば解決に失敗して落ちる。型だけの import は消えるので対象外。

## domain 間の呼び出し

### server entry の形

```ts
// @monica/<d>/server
export { migrations } from "../migrations";
export const router = os.router({ ... });          // context は { db, <d>Ledger }
export function create<D>Ledger(deps: { db: Db; home: string; ... }): <D>Ledger;
```

- `<D>Ledger` は、Backend が domain ごとに 1 つ作り、`GLOSSARY.md` の Workbench Ledger・Task Ledger・Job Ledger・Note Ledger を扱う部品。どれも起動時と終了時の処理の `start()` / `stop()` を持つ。deps と method は domain ごとの文書の「create<D>Ledger」に、作る順と渡すものは `docs/packages/backend.md` にある。
- `WorkbenchLedger` と `TaskLedger` は `events` も持つ。その domain の変更を知らせる in-process の publisher で、job と note は change stream を持たないので無い（ADR-0016・0018）。
- server entry は、ほかに他の domain と Backend が使う関数と型を出してよい（task の `nameAgentSession`、ptyd と setup が env を絞る workbench の `inheritableEnv()`）。
- Ledger の型には、他の domain と Backend が呼ぶ method だけを出す。procedure の handler が使う中身（ghq や GitHub への口、Bench の準備の状態など）は、Ledger を key にした WeakMap に置き、`internals(<d>Ledger)` で引く。router の context に渡るのは `db` と Ledger だけなので、外の口も Ledger が持つ。
- system の Job を持つ domain（task と note）は、`@monica/<d>/server` の `systemJobs(<d>Ledger)` で `{ name, every, run }[]` を出し、Backend の組み立てがそれを `createJobLedger` に渡す。名前は `<domain>.<name>`、`run` は失敗なら reject する。domain は timer を持たない。job を import しないので、戻り値は素のオブジェクトにし、job の型を注記しない（#18、ADR-0016）。
- 他の domain から呼ばれる書き込みは、第 1 引数に transaction（`db` でもよい）を取る**同期**の method にする。呼び手は `db.transaction((tx) => { workbenchLedger.moveTab(tx, …); insertRun(tx, …) })` のように、両 domain の書き込みを 1 つの transaction にまとめる。fs への副作用は transaction に入らないので別の async method にし、呼び手が commit の後に呼ぶ。ptyd への副作用は workbench が transaction の後に自分で送る（ADR-0015）。今これを持つのは `WorkbenchLedger` だけで、method は `docs/packages/workbench-ledger.md` の「他の domain が呼ぶ書き込み」にある。
- 他の domain が呼ばない書き込みは、同じ形（第 1 引数が tx）の module 内の関数として procedure の handler から呼び、Ledger には出さない。合図や通知の口のような Ledger の deps を使う書き込みは、`internals` に置いた module の method にしてよい。そのうち呼び手と transaction を束ねないもの（workbench の hook の適用と `markSeen`）は tx を取らない。他の domain から呼ばれない処理は router の handler の中に書いてよい。

### domain をまたぐ規則

- **書き込み**は相手の domain の method を通す。相手の table に直接 INSERT / UPDATE / DELETE しない。lint の `monica/cross-domain-write` が、`@monica/<d>/schema` から import した table を `insert` / `update` / `delete` に渡す形を止める。package のテストと `testing.ts` も対象にする。apps/cli のテストは自分の domain を持たず、task の table に fixture を書くので外す。
- **読み出し**は相手の table を `@monica/<d>/schema` で直接 SELECT してよい。表示状態（#17）や ActiveRun guard のように Agent Session と Run を join する読み出しを procedure 経由にすると N+1 になるため。
- 依存の向きの下流（workbench）が上流（task）の値を要るときは、上流の server が関数を出し、Backend の組み立てが下流の deps に渡す。workbench の通知の呼び名は、task の `nameAgentSession` をこの形で受ける。
- **event は「変わった」の合図**で、購読側は payload を信じず DB を読み直す。bun:sqlite の transaction は同期なので、tx の中で publish しても購読側が動くのは commit 後の microtask になる。rollback されても読み直すだけで害が無いので、commit 後に publish する仕組みは作らない。
- workbench の router を in-process client（`createRouterClient`）で呼ぶ形は採らない。oRPC の呼び出しは async で、drizzle の bun:sqlite の transaction に async 関数を渡すと throw しても rollback されないため（ADR-0009）。
- transaction に async 関数を渡さない。lint の `monica/sync-transaction` が、関数式と、同じ file で定義した async 関数を名前で渡す形を止める。

## テスト

package ごとに in-memory の SQLite に自分の migration を当てる（task は workbench → task の順）。外から見える振る舞いは `createRouterClient(router, { context })` を通して確かめ、他の domain から呼ばれる method と module 内の関数（`openTab` など）はそのまま呼ぶ。DB を fake に差し替えない（ADR-0002）。`bun test` を root で打つと全 package のテストが走る。外の口の fake は domain ごとの文書の「テスト」に、CLI と Backend の組み立ての確かめ方は `docs/packages/cli.md` と `docs/packages/backend.md` にある。

- workbench の ptyd は `packages/workbench/src/fake-ptyd.ts` に差し替える。fake は `$home/ptyd.sock` で NDJSON を話し、List の中身を台本にし、Exit を押し込み、届いた Reap と Terminate を記録する。本物の ptyd は CI の ts job に無く、Exit と Created の競合も決まった順で起こせないため。home は `mkdtemp(tmpdir())` で短くする（socket の path の上限は 104 byte）。fake と home の helper は `@monica/workbench/testing` から他の package にも出す。
  - op が届かないことを `receivedAll(…)` が空で確かめるときは、後から送る別の op（Tab を開いた Create など）が届くのを待ってから読む。ptyd は 1 本の接続で順に受けるので、後の op が届けば先に送られた op も届いている。すぐに読むと、transaction の後に送る op が届く前の空を見て、送ってしまう変異も通す。
- task と CLI のテストの Workbench Ledger も、fake の ptyd の home で `createWorkbenchLedger` を組む（`ptydPath` は存在しない path）。Workbench Ledger の method は差し替えず、transaction で `openTab` → commit の後に workbench が送る Create と Write を、本物の protocol で通す。procedure と Workbench Ledger の method は ptyd を待たずに返るので、ptyd に届いた Create・Write・Terminate は fake の `received` か `receivedAtLeast` で待ってから確かめ、Terminal Session が starting を抜けるのは `untilSettled` で待つ。Tab と Runspace は Workbench Ledger の method か workbench の router で開き、Agent Session は hook で作る。workbench の table に直に書かない。
- await の間の競合は、await の途中で止めて決まった順で起こす。sync の途中は fake GitHub の `hold()`、git の ref の更新（`branch -D` など）の途中は checkout の `.git/hooks/reference-transaction` が file を待つ script、ptyd の応答の途中は fake の ptyd の `holdNext(op)` で止める（`close.test.ts`）。
- system の Job を足すときは、並びを出す domain のテストに、`systemJobs(<d>Ledger)` から名前で取り出した `run` を最小の場面で呼ぶテストを 1 本足し、Ledger の method に届くことを見る（`note.image-cleanup`、`task.setup-log-cleanup`）。method の規則のテストは method を直に呼ぶ。`run` が別の method を呼んでも、型も Job Ledger のテストも捕まえないため。
- 一定の間隔で走る処理は、`setInterval` を `spyOn` で捕まえ、間隔を確かめてから callback を手で呼ぶ。決まった時間の打ち切りは、`setTimeout` を `spyOn` してその callback を捕まえ、手で呼ぶ。Bun の `jest.useFakeTimers()` は `Bun.sleep` と `setTimeout` も止め、一部の timer だけを偽にできないので、HTTP の応答を待つテストが進まなくなる。
- 終わった行のように procedure に出ない行は、`@monica/<d>/schema` の table を SELECT して確かめてよい。他の domain が読むのと同じ面だから。

## contract の規約

1. 合成した contract の root は package 名で mount する（`{ workbench, task, job }`、notes の口では `{ note }`）。path の先頭が package 名になり、CLI もそれに従う（`monica task track`、`monica workbench hook claude`）。
2. 全 procedure に `.meta({ description })` と `.output()` を付ける。description は CLI の help の正本、output は `--format json` の形の正本になる（#17 の JSON の形もここに書く）。
3. CLI に出すのは `.meta({ cli: true })` を付けた procedure だけ（ADR-0003）。event iterator の procedure は付けても出ない。
4. 呼び手が分岐する domain エラー（close の guard のように `data` に理由の一覧を持つもの）だけを `.errors()` で宣言する。それ以外は oRPC の標準 code（`NOT_FOUND`、`BAD_REQUEST`）を投げる。
5. 変更の stream は domain ごとに 1 本（`workbench.changes`、`task.changes`）で、判別 union の event を流す。中身は `events` と同じ合図。合図は、その domain の procedure の output が変わる経路すべてで出す。stream だけを購読して読み直す client が、古い output を持ったまま残らないようにするため。他の domain の行から導く output（task の表示状態は workbench の Agent Session から導く）は、相手の合図を受けて自分の合図を出す。購読する画面の無い job と、focus のたびに取り直す note は stream を持たない（ADR-0016・0018）。
6. `oc.$meta(...)` と `createSchemaFactory({ coerce: { date: true } })` は各 package の `contract.ts` の中にだけ書く。oRPC 2.0 で `.meta` が plugin 制になったときに直す場所を 1 つにするため（#21）。例外は `apps/cli/src/forward.ts` で、output を持たない procedure を組み直すために contract の meta を `os.$meta` で引き継ぐ（`docs/packages/cli.md`）。

contract を走査するテストが、description と output が全 procedure にあること、`cli: true` の procedure に整形関数があることを確かめる。CLI に載る workbench・task・job は `apps/cli/src/contract.test.ts`、note は `packages/note/src/contract.test.ts` が見る。

## ここで決めていないこと

- 設定、`$MONICA_HOME` のレイアウト、ログ（map の fog）。
- 署名と notarization（map の fog）。
