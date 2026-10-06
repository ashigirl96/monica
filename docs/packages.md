# パッケージ構成と dev loop

tania の repo の形、package の entry、domain 間の呼び出し、CLI の組み立て、dev と release の手順を決める。骨格を実装するときに最初に読む文書で、実装が進んだらここを今の形に合わせて直す。決定の理由は `docs/adr/` にある（とくに ADR-0002 / 0003 / 0006 / 0009 / 0010 / 0011）。出発点は branch `prototype/stack`・`prototype/workbench`・`prototype/terminal-session` で、骨格の実装 issue は #25 の sub-issue。

## 索引

この文書には、どの作業も読む規則を置く。ほかの規則は `docs/packages/` に分けてあり、作業がその範囲に触るときに読む。

- `docs/packages/workbench-ledger.md`: Workbench Ledger。workbench の contract と、Runspace・Tab・Terminal Session の起動と終了・他の domain から呼ばれる書き込み・pin・終わった行・Agent Session の終了の規則、fake の ptyd。workbench の procedure、ptyd に送るもの、reconcile、Agent Session の行に触るとき、他の domain から Tab を開くか移すとき、テストで ptyd を使うとき。
- `docs/packages/workbench-ui-state.md`: Workbench の UI 状態と status dot。webview に置く画面の状態と、Agent Session の状態の dot。Workbench の画面の状態か dot に触るとき。
- `docs/packages/tab-env-and-shim.md`: tab の env と shim。Tab に渡す env、shim、claude wrapper、hook の settings、hook CLI、payload の decoder。Tab の env、claude の起動、hook の受け口に触るとき。
- `docs/packages/notifications.md`: 通知。出す遷移、title と body、Backend から Shell への渡し方。通知の判定と本文、Agent Session の遷移に触るとき。
- `docs/packages/task-ledger.md`: Task Ledger。task の contract と、Run・Attach・Bench・Run の起動・close と reopen・sync の規則、system の Job の並び、fake の GitHub と ghq。task の procedure に触るとき、テストで GitHub か ghq を使うとき。
- `docs/packages/note-ledger.md`: Note Ledger。note の contract と、種類ごとの不変条件・保存の楽観ロック・削除と取り消し・`body` entry の規則。note の procedure か本文の扱いに触るとき。
- `docs/packages/note-ui.md`: note の ui。monica のコードを移すときの規則と、エディタの置き場所、依存、node 型を減らせない理由、直書きの文字列の置き場所。`packages/note/src/ui` に触るとき、monica のコードを移すとき。
- `docs/packages/backend.md`: Backend（apps/backend）。起動時の PATH、spawn の env、Ledger を作って start する順、notes の口（Host と CSRF の照合、載せるもの、SPA の配り方）。apps/backend に触るとき、Ledger を足すか deps を変えるとき、Backend で process を spawn するとき、notes の口に載せるものを変えるとき。
- `docs/packages/cli.md`: CLI（apps/cli）。argv の振り分け、Backend の探索、転送 router、`--format`、エラーと exit code、SKILL.md の検査、CLI と hook CLI のテスト。`cli: true` の procedure か SKILL.md を足すとき、apps/cli に触るとき。
- `docs/packages/desktop.md`: desktop（apps/desktop）。webview の枠、キーの扱い、Backend の endpoint、Task の slot、Shell の責務と command、窓。apps/desktop と domain の ui の載せ方に触るとき。
- `docs/packages/dev-loop.md`: dev loop、release、検査、版。dev の起動、scripts、release の build、CI、依存と tsconfig に触るとき。
- `docs/packages/migration.md`: migration。generate、`migrations/index.ts`、package ごとの履歴 table、compiled binary での読み方。table を足すか変えるとき、domain の package を足すとき。

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
│   ├── desktop/        @tania/desktop   src/ が webview、src-tauri/ が Shell
│   └── web/            @tania/web       ブラウザに配る notes の画面の組み立て
├── packages/
│   ├── workbench/      @tania/workbench
│   ├── task/           @tania/task
│   ├── job/            @tania/job
│   ├── note/           @tania/note
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
| `@tania/<d>/contract` | oRPC の contract、zod schema、型 | どこでも | apps/desktop と apps/web（型だけ）、apps/cli、apps/backend、自分と他 package の server と ui と cli |
| `@tania/<d>/server` | router、`create<D>()`、migrations の re-export | Bun | apps/backend、他 package の server、テスト |
| `@tania/<d>/ui` | React の component と atom。画面を持たない job には無い | browser | apps/desktop、他 package の ui |
| `@tania/<d>/cli` | 出力の整形関数、補完の候補を返す関数、手で書く command | Bun | apps/cli |
| `@tania/<d>/body` | Note の本文の JSON を読む関数（`docs/packages/note-ledger.md`）。今は note だけが持つ | どこでも | 自分の server と ui |
| `@tania/<d>/testing` | 他の package のテストに出す fake。今は workbench だけが持つ（`docs/packages/workbench-ledger.md` の「テスト」） | Bun | 他 package のテストと `testing.ts` |

- 依存の向きは task → workbench だけ。workbench は task を import しない（ADR-0005）。job は task も workbench も import しない（ADR-0016）。note は他の domain を import せず、他の domain からも import されない。bun の isolated linker では package.json に書いていない依存を解決できないので、向きは package.json が守る。package の中の entry の境界（schema が import してよいもの、ui が server の entry と `bun:sqlite` を import しないこと、body が `bun:sqlite`・`drizzle-orm`・schema と server の entry を import しないこと、cli entry を import するのが apps/cli だけであること）と apps どうしの向きは、`.oxlintrc.json` の overrides が lint で守る。testing entry を import するのがテストと `testing.ts` だけであることは、lint の `tania/testing-entry` が守る。no-restricted-imports の設定は override をまたいで重ならないので、file の集合ごとの制限とは別の rule にしている。CLI と webview とブラウザで動くコード（apps/cli、apps/desktop、apps/web、各 package の cli entry と ui entry）が DB に触るもの（`bun:sqlite`、`drizzle-orm`、schema entry と server entry の値）を import しないことも同じく守る（ADR-0003）。cli entry で見るのは `cli.ts` の import だけで、`cli.ts` が import する内側のファイルは見ない。apps/cli のテストと `testing.ts` は in-memory の Backend を組むので、この制限から外す。package を足して entry の override を書き忘れると、`scripts/oxlint/entry-boundaries.test.ts` が落ちる。このテストは、各 package の `exports` にある cli・ui・body・schema の entry と同じ path に禁じた import を並べた file を一時 directory に置き、oxlint を当てて全部が止まるかを見る。
- task の schema は workbench の table を FK のために import するが、re-export しない（ADR-0010）。
- webview の bundle に `bun:sqlite` や `@orpc/server` が混ざっていないかは `vite build` で確かめる。混ざれば解決に失敗して落ちる。型だけの import は消えるので対象外。

## domain 間の呼び出し

### server entry の形

各 domain の server entry は、`migrations`（`docs/packages/migration.md`）、`router`（context は `{ db, <d>Ledger }`）、`create<D>Ledger(deps)` を出す。`<D>Ledger` は Backend が 1 つずつ作り（`docs/packages/backend.md` の「組み立て」）、`GLOSSARY.md` の <D> Ledger を扱う部品で、どれも `start()` / `stop()` を持つ。deps と `start()` / `stop()` の中身は各 Ledger の文書にある。

- `events`: その domain の変更を知らせる in-process の publisher。workbench と task だけが持つ。job と note は change stream を持たないので無い（ADR-0016・0018）。
- 他の domain から呼ばれる書き込みは Ledger の method にする。第 1 引数に transaction（`db` でもよい）を取る**同期**の method で、task は `db.transaction((tx) => { workbenchLedger.moveTab(tx, …); insertRun(tx, …) })` のように、両 domain の書き込みを 1 つの transaction にまとめる。fs への副作用は transaction に入らないので別の async method にし、呼び手が commit の後に呼ぶ。今あるのは `WorkbenchLedger` の 4 つ（`docs/packages/workbench-ledger.md` の「他の domain から呼ばれる書き込み」）。
- 他の domain が呼ばない書き込みは、同じ形（第 1 引数が tx）の module 内の関数として procedure の handler から呼び、Ledger には出さない。他の domain から呼ばれない処理は router の handler の中に書いてよい。
- import の向きに逆らう呼び出し（workbench → task、job → task）は、呼ばれる側の server entry が関数を出し、Backend の組み立てが呼ぶ側の deps に渡す（task の `nameAgentSession` と `systemJobs`）。

### domain をまたぐ規則

- **書き込み**は相手の domain の method を通す。相手の table に直接 INSERT / UPDATE / DELETE しない。lint の `tania/cross-domain-write` が、`@tania/<d>/schema` から import した table を `insert` / `update` / `delete` に渡す形を止める。package のテストと `testing.ts` も対象にする。apps/cli のテストは自分の domain を持たず、task の table に fixture を書くので外す。
- **読み出し**は相手の table を `@tania/<d>/schema` で直接 SELECT してよい。表示状態（#17）や ActiveRun guard のように Agent Session と Run を join する読み出しを procedure 経由にすると N+1 になるため。
- **event は「変わった」の合図**で、購読側は payload を信じず DB を読み直す。bun:sqlite の transaction は同期なので、tx の中で publish しても購読側が動くのは commit 後の microtask になる。rollback されても読み直すだけで害が無いので、commit 後に publish する仕組みは作らない。
- workbench の router を in-process client（`createRouterClient`）で呼ぶ形は採らない。oRPC の呼び出しは async で、drizzle の bun:sqlite の transaction に async 関数を渡すと throw しても rollback されないため（ADR-0009）。
- transaction に async 関数を渡さない。lint の `tania/sync-transaction` が、関数式と、同じ file で定義した async 関数を名前で渡す形を止める。

### テスト

package ごとに in-memory の SQLite に自分の migration を当てる（task は workbench → task の順）。外から見える振る舞いは `createRouterClient(router, { context })` を通して確かめ、他の domain から呼ばれる method と module 内の関数（`openTab` など）はそのまま呼ぶ。DB を fake に差し替えない（ADR-0002）。`bun test` を root で打つと全 package のテストが走る。

- 外の process と service は fake に差し替える。ptyd は workbench の fake（`docs/packages/workbench-ledger.md` の「テスト」）、GitHub と ghq は task の fake（`docs/packages/task-ledger.md` の「テスト」）。CLI と hook の CLI の確かめ方は `docs/packages/cli.md` の「テスト」、Backend の組み立ては `docs/packages/backend.md` の「テスト」。
- await の間の競合は、await の途中で止めて決まった順で起こす。sync の途中は fake GitHub の `hold()`、git の ref の更新（`branch -D` など）の途中は checkout の `.git/hooks/reference-transaction` が file を待つ script、ptyd の応答の途中は fake の ptyd の `holdNext(op)` で止める（`close.test.ts`）。
- 一定の間隔で走る処理は、`setInterval` を `spyOn` で捕まえ、間隔を確かめてから callback を手で呼ぶ（Bun の fake timers の落とし穴は `docs/gotchas.md`）。
- 終わった行のように procedure に出ない行は、`@tania/<d>/schema` の table を SELECT して確かめてよい。他の domain が読むのと同じ面だから。

## contract の規約

1. 合成した contract の root は package 名で mount する（`{ workbench, task, job }`、notes の口では `{ note }`）。path の先頭が package 名になり、CLI もそれに従う（`tania task track`、`tania workbench hook claude`）。
2. 全 procedure に `.meta({ description })` と `.output()` を付ける。description は CLI の help の正本、output は `--format json` の形の正本になる（#17 の JSON の形もここに書く）。
3. CLI に出すのは `.meta({ cli: true })` を付けた procedure だけ（ADR-0003）。event iterator の procedure は付けても出ない。
4. 呼び手が分岐する domain エラー（close の guard のように `data` に理由の一覧を持つもの）だけを `.errors()` で宣言する。それ以外は oRPC の標準 code（`NOT_FOUND`、`BAD_REQUEST`）を投げる。
5. 変更の stream は domain ごとに 1 本（`workbench.changes`、`task.changes`）で、購読する画面の無い job は持たない。判別 union の event を流す。中身は `events` と同じ合図。合図は、その domain の procedure の output が変わる経路すべてで出す。stream だけを購読して読み直す client が、古い output を持ったまま残らないようにするため。他の domain の行から導く output（task の表示状態は workbench の Agent Session から導く）は、相手の合図を受けて自分の合図を出す。note は画面があっても stream を持たない。notes の画面は focus のたびに取り直し（ADR-0018）、タブごとに stream を張ると Chromium の host ごとの接続数の上限（6 本）に当たるため。
6. `oc.meta(...)` と `createSchemaFactory({ coerce: { date: true } })` は各 package の `contract.ts` の中にだけ書く。oRPC 2.0 で `.meta` が plugin 制になったときに直す場所を 1 つにするため（#21）。例外は `apps/cli/src/forward.ts` で、output を持たない procedure を組み直すために contract の meta を `os.$meta` で引き継ぐ（`docs/packages/cli.md`）。

contract を走査するテストを 1 本置き、description と output が全 procedure にあること、`cli: true` の procedure に整形関数があることを確かめる。

## ここで決めていないこと

- 設定、`$TANIA_HOME` のレイアウト、ログ（map の fog）。
- 署名と notarization（map の fog）。
