# パッケージ構成

monica の repo の形を決める。配置、entry、依存の向き、server entry の形、domain の package を足すときの 5 つで、決定の理由は各規則に添えた ADR（`docs/adr/`）にある。domain ごとの contract・関数・振る舞いは書かない。code と test が正本で、写すと古くなるため（ADR-0039）。この 5 つを変える PR は、同じ PR でここを直す。

## 配置

```
monica/
├── package.json        workspaces・catalog・packageManager・scripts
├── tsconfig.json       1 つだけ
├── Cargo.toml          Rust の workspace（crates/* と apps/desktop/src-tauri）
├── .claude-plugin/     plugin.json・marketplace.json（ADR-0006）
├── scripts/
├── apps/               @monica/<dir>。backend・cli（bin は monica）・desktop（src/ が webview、src-tauri/ が Shell）・extension・web・ios（同梱 React と Swift の OS 連携）
├── packages/           @monica/<dir>。domain の workbench・task・job・note・chat・usage と、domain を持たない ui
├── mods/               @monica/mod-<dir>。Claude Code の mod（hooks module を持つ plugin）が 1 folder に 1 つ
└── crates/             Rust の crate。crate 名は monica-<dir>
```

- apps は packages を組み立てるだけでロジックを持たない（ADR-0002）。apps どうしは互いを import しない。
- mods は、user の `~/.claude/settings.json` の `env` の `CLAUDE_CODE_PLUGIN_DIRS` に main の checkout の `mods/<dir>` を書き、全 session に読み込ませる。hook がどの session にも掛かるので、hook を持たない plugin `monica`（ADR-0006）とは分ける。
- mods は apps と packages を import せず、apps と packages からも import されない。mod が子 process で動かす script の依存は、mod の `package.json` に catalog で書く。
- mod の test は `claude-code/testing` を import するので、`bun run check` の `bun test` からは外し、`claude plugin test mods/<dir>` で走らせる。
- `packages/ui` には、domain の語を持たない部品と、CLI の整形が使う `@monica/ui/table`・`@monica/ui/local-time` を置く。cli entry は apps/cli だけが import するので、domain の cli entry どうしでは共有できないため。domain の UI は各 domain の `ui` entry に置く。

### ドメイン package の中

```
packages/<d>/
├── package.json
├── drizzle.config.ts      out: "./migrations/<d>"
├── migrations/            index.ts（{ folder, table, latest } と _journal.json の import）と、drizzle-kit generate が出す <d>/
└── src/                   schema.ts・contract.ts・server.ts・cli.ts・ui/index.ts
```

entry より内側のファイル分割は自由。

## entry

entry は層ではなく、import してよい実行環境で切る（ADR-0009）。domain の package は root の `"."` を置かない。

| entry | 中身 | 実行環境 | import する側 |
|---|---|---|---|
| `@monica/<d>/schema` | drizzle の table | どこでも | 自分の contract と server、他 package の schema（FK）と server（SELECT） |
| `@monica/<d>/contract` | oRPC の contract、zod schema、型 | どこでも | apps/desktop と apps/web と apps/extension（型だけ）、apps/cli、apps/backend、自分と他 package の server と ui と cli |
| `@monica/<d>/server` | router、`create<D>Ledger()`（chat は `createChatAgent()`）、migrations の re-export | Bun | apps/backend、他 package の server、テスト |
| `@monica/<d>/ui` | React の component と atom | browser | apps/desktop、apps/web、apps/extension、他 package の ui |
| `@monica/workbench/mobile` | RemoteWorkbench の一覧・端末閲覧・基本入力と iOS 用 React。desktop 初期化を含まない | browser（同梱 WKWebView） | apps/ios |
| `@monica/<d>/cli` | 出力の整形関数、補完の候補を返す関数、手で書く command | Bun | apps/cli |
| `@monica/<d>/body` | Note の本文の JSON を読む関数と、本文と markdown の変換 | どこでも | 自分の contract と server と ui |
| `@monica/chat/native-host` | React と CSS を引かずに使えるよう、ui の index と分ける | browser（Chrome Extension） | `@monica/chat/ui`、apps/extension の service worker |
| `@monica/<d>/testing` | 他の package のテストに出す fake | Bun | 他 package のテストと `testing.ts` |
| `@monica/chat/html-worker`・`@monica/chat/pdf-worker` | HTML と PDF を本文にする Bun の Worker の module | Bun の Worker | apps/backend の Worker の entrypoint だけ |

`apps/ios/Native` は WKWebView、URLSession、QR カメラ、Keychain と TLS trust を扱う。DB と Ledger は持たず、業務判断と再接続は Workbench の `mobile` entry に置く。Swift は AppKit や別 app の実装を import しない。React は `apps/ios/dist` として同梱し、外部 HTML・script は読み込まない。

`mobile` entry は `ui` と同じ DB・server 禁止に加え、desktop の `ui`、Tauri、Node の OS module、別 app を import しない。`apps/ios/testing.ts` は native 試験用の組み立てで、実 SQLite・Workbench Ledger・fake ptyd と隔離 TLS listener を使う。native fixture は `crates/terminal-client/examples/remote-fixture.rs` で製品と同じ Shell byte relay を起こす。製品の bundle には含めない。`project.yml` を変更したら XcodeGen で `Monica.xcodeproj` を再生成して同じ差分に含める。

## 依存の向き

- 依存の向きは task → workbench だけで、workbench は task を import しない（ADR-0005）。
- job は task も workbench も import しない（ADR-0016）。note・chat・usage は他の domain を import せず、他の domain からも import されない。
- task の schema は workbench の table を FK のために import するが、re-export しない（ADR-0010）。
- import できない向きに値を渡すときは、出す側の server entry が関数を出し、Backend の組み立てが受ける側の deps に渡す。workbench の通知の呼び名は、task の `nameAgentSession` をこの形で受ける（ADR-0013）。usage が数える処理と全 Feature の一覧も、Backend の組み立てが渡す。

## server entry の形

```ts
// @monica/<d>/server
export { migrations } from "../migrations";
export const router = os.router({ ... });          // context は { db, <d>Ledger }
export function create<D>Ledger(deps: { db: Db; home: string; ... }): <D>Ledger;
```

- Ledger は Backend が domain ごとに 1 つ作り、起動と終了の処理があれば `start()` / `stop()` を持つ。change stream を持つ domain の Ledger は `events` を持つ（ADR-0016・0018）。
- Ledger の型には、他の domain と Backend が呼ぶ method だけを出す。handler が使う中身は `internals(<d>Ledger)` で引く。router の context に渡るのは `db` と Ledger だけなので、外の口も Ledger が持つ。server entry は、ほかに他の domain と Backend が使う関数と型を出してよい。
- 記録を持たない chat は、Ledger の代わりに `ChatAgent` を持ち、router の context に `db` を渡さない。
- system の Job を持つ domain は、`systemJobs(<d>Ledger)` で `{ name, every, run }[]` を出し、Backend の組み立てが Job Ledger に渡す。domain は timer を持たず、job を import しない（ADR-0016）。
- 他の domain から呼ばれる書き込みは、第 1 引数に transaction（`db` でもよい）を取る**同期**の method にする。呼び手は `db.transaction((tx) => { workbenchLedger.moveTab(tx, …); insertRun(tx, …) })` のように、両 domain の書き込みを 1 つの transaction にまとめる。fs への副作用は transaction に入らないので別の async method にし、呼び手が commit の後に呼ぶ。ptyd への副作用は workbench が transaction の後に自分で送る（ADR-0009・0015）。workbench の書き込みは、呼び手の transaction の中で `{ type: "layout" }` を 1 つ出す。ptyd への Create・Write・Terminate は commit の後に workbench が送るので、呼び手は reconcile も ptyd も待たない（ADR-0015）。
  - Terminal Session が Terminating か（live で、どの Tab にも指されていない）は、workbench の server entry の `terminating` が query の条件で返す。task の close が止める Active Run と Run の起動は、transaction の中でもこれで閉じた Tab の claude を数えない（ADR-0023）。
- 他の domain が呼ばない書き込みは、module 内の関数として handler から呼び、Ledger には出さない。

## domain の package を足すとき

- `package.json` の `exports` に entry を書き、root の `"."` は置かない。他の package への依存は `dependencies` に書く。bun の isolated linker は、書いていない依存を解決しないため（ADR-0009）。
- `.oxlintrc.json` に entry ごとの override を足す。書き忘れは `scripts/oxlint/entry-boundaries.test.ts` が落とす。
- migration は `drizzle.config.ts` の `out: "./migrations/<d>"` と `migrations/index.ts` で置く（ADR-0010）。table を持たない package は、`drizzle.config.ts`・`src/schema.ts`・`generate` の script を置かず、`migrations/<d>/meta/_journal.json` に `{"version":"7","dialect":"sqlite","entries":[]}` を手で置く。drizzle-kit は schema の file が無いと exit 1 し、`bun run generate` が落ちるため。
- Backend の組み立て（`apps/backend`）で Ledger を作り、router を package 名で口に載せる（`CODING_STANDARDS.md` の「contract」）。CLI に出すなら `apps/cli/src/contract.ts` にも足す。
- CLI に載せない domain は、contract を走査するテストを package に置く（`packages/note/src/contract.test.ts` と同じ形）。CLI に載せる domain は `apps/cli/src/contract.test.ts` が見る。
