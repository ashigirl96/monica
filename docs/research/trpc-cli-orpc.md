# trpc-cli は oRPC の router をそのまま CLI にできるか

調査日 2026-10-02。issue #2（#1 の一部）。対象は trpc-cli 0.17.1 と @orpc/server 1.15.4。

## 結論

1 つの `@orpc/server` router を hono の `RPCHandler` と trpc-cli の `createCli` の両方に載せられる。ADR-0003 の前提は成立する。ただし streaming procedure だけは CLI 側で実質使えない。

- trpc-cli の oRPC 対応の有無と範囲: あり。v0.9.0 で追加され、peerDependency は `@orpc/server: ^1.0.0`。制約は 3 つ。`@orpc/contract` だけの router は不可（実装済み router が必要）、lazy router は不可（`unlazyRouter` を通せば可）、oRPC v2 beta（2.0.0-beta.41）は起動時に `traverseContractProcedures is not a function` で落ちる。
- input schema から flag と positional への対応規則: あり。`z.object` は `--kebab-case` の option、string / number / boolean 単体は positional、`z.tuple` は複数 positional（末尾の object は option）、`z.array` は可変長 positional。zod v4 と arktype は `meta({positional: true})` / `configure({positional: true})` で object の中の field を positional にできる。valibot は `@valibot/to-json-schema` の追加インストールが必要で、meta がないため positional は tuple でしか指定できない。JSON Schema に変換できない schema は `--json` 入力のみの command に退避される。
- nested router が command 階層にどう写るか: そのまま写る。`{todo: {add, list}}` は `cli todo add` / `cli todo list`。key は kebab-case 化される（`withValibot` は `with-valibot`）。
- context（DB 接続）の注入: 可。`createCli({router, context: {db}})` が oRPC の `call(procedure, input, {context})` にそのまま渡す。CLI 起動時に `bun:sqlite` を開いて渡す構成を動作確認した。hono 側は `handler.handle(c.req.raw, {prefix, context: {db}})` で同じ router に同じ context を渡す。注意点として `context` は型上 optional なので、渡し忘れはコンパイルで止まらない（型が合わない値は弾かれる）。
- 出力制御: 部分的。`--json` は入力側のフラグ（`jsonInput: 'auto'` で全 command に付く）。出力の整形は `run({logger})` で切り替える。デフォルトの `yamlTableConsoleLogger` は人間向け（object の配列は表、object は yaml）、`lineByLineConsoleLogger` は `jq` 向け JSON。出力形式を切り替える組み込みフラグはないので、「`--json` で JSON 出力」は自前で argv を見て logger を選ぶ必要がある。
- streaming / event iterator: 扱えない。`eventIterator` の procedure も command にはなるが、trpc-cli は戻り値の async generator を iterate せず logger に渡すため、`{}` が出力されて generator 本体は一度も実行されない。README も subscription 非対応と明記している。custom logger で iterate し、`process.exit` を遅延させる回避策は動いたが、公式の仕組みではない。
- shell completion の生成: あり。optional peer の `omelette` を `run({completion})` に渡す方式。zsh / bash 用スクリプトの出力と、command と option の補完候補の生成を確認した。

## 根拠

- oRPC 対応と制約（contract 不可、lazy 不可）: trpc-cli README「oRPC」節 <https://github.com/mmkal/trpc-cli#orpc>。追加されたバージョンは v0.9.0 のリリースノート <https://github.com/mmkal/trpc-cli/releases/tag/v0.9.0>。peerDependency は `package.json` <https://github.com/mmkal/trpc-cli/blob/v0.17.1/package.json>。
- oRPC router の走査と呼び出しの実装: `parseOrpcRouter` が `traverseContractProcedures` と `isProcedure` で procedure を列挙し、path を `.` で連結して command 階層にする <https://github.com/mmkal/trpc-cli/blob/v0.17.1/src/parse-router.ts>。実行時は `call(procedure, input, {context: params.context})` を呼ぶ <https://github.com/mmkal/trpc-cli/blob/v0.17.1/src/index.ts>（`caller = {[procedurePath]: ... call(procedure as never, _input, {context: params.context})}`）。
- oRPC v2 で `traverseContractProcedures` が消えている: v2 の `router-utils.ts` は `walkProcedureContractsSync` / `walkProcedureContractsAsync` に置き換わっている <https://github.com/unnoq/orpc/blob/main/packages/server/src/router-utils.ts>。v1 では `@orpc/server@1.15.4` の dist から export されている。
- flag / positional の規則: trpc-cli README「Input Types & CLI Arguments」 <https://github.com/mmkal/trpc-cli#input-types--cli-arguments>（Positional Arguments、Options、Combining Positional Arguments and Options）。変換不能 schema の `--json` 退避は「Complex Inputs with JSON」 <https://github.com/mmkal/trpc-cli#complex-inputs-with-json>。
- validator ごとの要件: README「Validators」 <https://github.com/mmkal/trpc-cli#validators>。valibot は `@valibot/to-json-schema`、arktype は組み込みの `toJsonSchema`。実装は `src/json-schema.ts` <https://github.com/mmkal/trpc-cli/blob/v0.17.1/src/json-schema.ts>。
- nested router: README「Features and Limitations」 <https://github.com/mmkal/trpc-cli#features-and-limitations>。oRPC 側で router が plain object の入れ子であること <https://v1.orpc.dev/docs/router>。
- context: oRPC v1 docs「Context」 <https://v1.orpc.dev/docs/context>（`os.$context<...>()` と、呼び出し時に `call(..., {context})` で初期 context を渡す説明）、「Server-Side Clients」 <https://v1.orpc.dev/docs/client/server-side>。hono adapter <https://v1.orpc.dev/docs/adapters/hono>。trpc-cli 側の `context?: inferRouterContext<R>` は `src/types.ts` <https://github.com/mmkal/trpc-cli/blob/v0.17.1/src/types.ts>。
- 出力制御: README「Output and Lifecycle」 <https://github.com/mmkal/trpc-cli#output-and-lifecycle>、「JSON input」 <https://github.com/mmkal/trpc-cli#json-input>。`--json` 入力は v0.15.0 で現在の形になった <https://github.com/mmkal/trpc-cli/releases/tag/v0.15.0>。logger 実装は `src/logging.ts` <https://github.com/mmkal/trpc-cli/blob/v0.17.1/src/logging.ts>。
- streaming: oRPC v1 docs「Event Iterator」 <https://v1.orpc.dev/docs/event-iterator>。trpc-cli は `if (result != null) logger.info?.(result)` で結果を渡すだけで iterate しない <https://github.com/mmkal/trpc-cli/blob/v0.17.1/src/index.ts>。README「Features and Limitations」の「Limitation: No `subscription` support」。
- completion: README「Completions」 <https://github.com/mmkal/trpc-cli#completions>、実装は `src/completions.ts` <https://github.com/mmkal/trpc-cli/blob/v0.17.1/src/completions.ts>。

## 検証したこと

scratchpad に bun プロジェクトを作り、以下のバージョンで実行した。bun 1.3.13、trpc-cli 0.17.1、@orpc/server 1.15.4、@orpc/client 1.15.4、hono 4.13.12、zod 4.6.5、valibot 1.5.0、@valibot/to-json-schema 1.8.0、arktype 2.2.7、omelette 0.4.17。別ディレクトリで @orpc/server 2.0.0-beta.41 も試した。

router は 1 ファイルに定義し、`os.$context<{db: Database}>()` を base にして、`todo.add`（zod、`title` を `meta({positional: true})`、`--done`）、`todo.list`（`--limit`）、`stream.ticks`（`eventIterator` を output にした async generator）、`other.withValibot`（valibot の tuple）、`other.withArktype`（arktype の object）を持たせた。

hono 側は `RPCHandler` を `/rpc/*` に mount し、`context: {db}` を渡して `app.request` 経由の `RPCLink` から呼んだ。`todo.add`、`todo.list`、`stream.ticks`（SSE で 2 件受信）がすべて動いた。

CLI 側は同じ router を `createCli({router, context: {db}, name: 'todo-cli', jsonInput: 'auto'})` に渡し、`bun:sqlite` の file DB を起動時に開いた。確認した挙動は次のとおり。

```
todo-cli --help                      # todo / stream / other の subcommand 一覧
todo-cli todo add --help             # Usage: todo-cli todo add [options] <title>、--done [boolean]、--json <json>
todo-cli todo add "buy milk" --done  # id/title/done が yaml 風に出力、DB に行が入る
todo-cli todo list                   # object 配列が表で出力
LINE_LOGGER=1 todo-cli todo list     # lineByLineConsoleLogger で JSON 出力
todo-cli todo add --json '{"title":"from json"}'   # 全入力を JSON で渡せる
todo-cli todo list --limit abc       # exit 1、option '--limit' に紐づく validation error と help
todo-cli other with-valibot ab --times 3           # tuple の positional と option
todo-cli other with-arktype --name bob --shout     # arktype の object が option に
todo-cli stream ticks --count 2      # 出力は {} のみ、generator 内の console.error は出ない
COMPLETION=1 todo-cli --completion   # omelette の zsh/bash スクリプトが出力される
COMPLETION=1 todo-cli --compgen 1 todo-cli "todo-cli to"    # todo / stream / other
COMPLETION=1 todo-cli --compgen 2 todo-cli "todo-cli todo " # add / list
```

型チェック（`tsc --noEmit`）も通した。`context: {db: 123}` にすると `Type 'number' is not assignable to type 'Database'` で弾かれるが、`context` を省略してもエラーにならない。

streaming の回避策として、`run({logger, process: {exit}})` で async iterable を受け取ったら `for await` で iterate して JSON 行を出し、iterate が終わるまで `process.exit` を遅らせる logger を書いたところ、generator が実行されて 3 件が出力された。

oRPC 2.0.0-beta.41 では `createCli({router}).run()` の時点で `TypeError: traverseContractProcedures is not a function` になり、`--help` すら出ない。

## 制約と注意

- oRPC は v1 系に固定する。trpc-cli の peer は `^1.0.0` で、v2 beta は現状動かない。v2 への追従は trpc-cli 側の対応を待つか自前 fork になる。
- lazy router（`os.lazy`）を使うなら CLI entry で `await unlazyRouter(router)` を挟む。hono 側は lazy のままで良い。
- router の key に `.` を含めると trpc-cli が例外を投げる。
- `context` の渡し忘れは型で検出されないので、CLI entry で `context` を必ず組み立てる構造にする。
- `jsonInput: 'auto'` にすると全 command に `--json` option が付く。schema に `json` という field があると衝突し、その command では JSON 入力が無効になる。
- 出力形式は logger 単位の切り替えで、command ごとや flag での切り替えは自前。`--json` を出力フラグとして使いたい場合は入力側の `--json` と名前が衝突するので、`--format json` など別名にする。
- streaming procedure は CLI では非対応。CLI 向けには配列を返す別 procedure を用意するか、上記の custom logger で iterate する。後者は trpc-cli の内部挙動（logger に生の戻り値が渡る）に依存する。
- completion は `omelette` を別途インストールし、`setupShellInitFile` でシェル初期化ファイルに書き込む運用が必要。README も「new feature」と断っている。
- trpc-cli は v0 で、README が「parts of the API may change」と明記している。

## 未確認

- oRPC の `.route()` / `.meta()` で付けた description が trpc-cli の help にどう反映されるか（`contract['~orpc'].meta` を読む実装は確認したが、実行はしていない）。
- `createRouterClient` ではなく `call` を使う trpc-cli の経路で、router レベルの `os.use(middleware)` が hono 側と同じ順序で走るか。
- oRPC の `ORPCError` が CLI の exit code とエラー表示にどう写るか（validation error 以外）。
- 入力の union / intersection、`z.array` option、`negatable` boolean など README に書かれた細かい規則は検証していない。
- oRPC v2 正式版での trpc-cli 対応予定。
