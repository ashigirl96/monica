# RPC 層の選択の見直し: oRPC は最良か

調査日 2026-10-02。issue #21（#1 の一部、#20 を block）。見直し対象は ADR-0003 の「賭けるのは oRPC、保険は trpc-cli」。候補は oRPC 1.15.4 / 2.0.0-beta.41、tRPC 11.19.0、Hono RPC（`hc`、hono 4.13.12）、HonoX 0.1.61、ts-rest 3.52.1、@hono/zod-openapi 1.6.3、Elysia 1.4.30 + Eden。採点要件は ticket の 1〜6、実機の比較基準は #8 の `apps/cli/src/forward.ts`（25 行）を各候補で書き直せるか。

## 結論

**oRPC 1.x を維持する。ADR-0003 は変えず、「撤退条件」を 1 行足す。**

- 6 要件すべてで最上位なのは oRPC だけ。契約（`oc`）と実装（`implement`）が公式に分かれ、契約の木を実行時に辿る API があり、SSE が型付きで `for await` でき、Standard Schema を直接受け、OpenAPI 生成が first-party。これらを同時に満たす候補は他に無い。
- 次点は tRPC v11。成熟度では最上位（v11 GA 2025-03、core 2 名、v12 の計画無し、trpc-cli の本家）だが、契約と実装を分ける公式手段が無く、CLI の走査は "unstable-core-do-not-import" 配下の `_def` に依存し、SSE の client は observer 形式で `for await` できない。#8 の構成（webview は contract だけ import、CLI は contract を走査）を tRPC で再現すると、契約は「resolver を付けていない builder の木」という非公式の構造になる。
- Hono RPC（`hc`）と HonoX は、実行時に辿れる契約が存在しない（`hc` は `import type` の型だけ、`app.routes` は path / method / handler のみで validator の schema を持たない）ので、forward.ts が書けず要件 1・2 で脱落する。typed SSE も無い（issue #3309 が 2024 年から open）。
- ts-rest は契約の木と `isAppRoute` があり走査は書けるが、zod 4 / Standard Schema が 2025-06 から 16 か月 RC のまま、最終安定版 3.52.1 から直近 12 か月の公開ゼロ、SSE は maintainer が「スコープ外」と明言。手元でも 3.52.1 + zod 4.6.5 は実行は通るが型が崩れた。
- @hono/zod-openapi は `createRoute` の route object が handler 無しの契約として使え、zod 4 + drizzle-zod で型も通ったが、CLI 生成器は無く自前、`hc` の型は handler 登録後の app 型からしか得られず、SSE の型付けは無い（middleware#735 open）。
- Elysia + Eden は SSE を `for await` でき Standard Schema も受けるが、契約オブジェクトが無く（`treaty<typeof app>`）、hono を置き換えるので ADR-0001 と衝突する。
- **oRPC v2 への移行時期**（map の fog）: 「2.0 GA 後、かつ trpc-cli が追従するか `apps/cli` を自前 adapter に書き換えると決めた後」。prototype の contract / router / forward は rename だけで v2 に載ることを確認した（半日仕事）。一方 trpc-cli 0.17.1 は v2 で `traverseContractProcedures is not a function` のまま起動せず、upstream に v2 対応の issue / PR は無い。v1 は beta と同日に patch が出続けている（1.15.4 と 2.0.0-beta.40 が 2026-09-23 の同日）ので、待つコストは低い。GA 時期の公式表明は無い（beta.1 2026-06-21 → beta.41 2026-10-01）。

## 採点表

◎ = 要件を満たし実証済 / ○ = 満たすが条件付き / △ = 自前の作り込みか非公式 API が要る / × = 満たさない

| 候補 | 1. 一定義 → server / webview / CLI | 2. 契約と実装の分離、実行時の契約の木 | 3. 型付き SSE | 4. Standard Schema（drizzle-zod 直渡し） | 5. 成熟度と変更の速さ | 6. MCP / OpenAPI の材料 |
|---|---|---|---|---|---|---|
| **oRPC 1.15.4** | ◎ #8 で実証。CLI は trpc-cli（25 行の転送 router） | ◎ `oc` / `implement(contract)` が公式。`isContractProcedure` で木を走査 | ◎ `eventIterator` を webview で `for await`（#8 (f)） | ◎ #3 で確認。`@orpc/contract` 自体が "powered by Standard Schema" | ○ 1 人メンテ（直近 12 か月の人間 commit の約 95% が dinwwwh）。1.x は 2025-04 から、直近 12 か月で stable 50 回（1.9〜1.15）。trpc-cli も 1 人メンテで v0 | ○ OpenAPI 生成は first-party（`@orpc/openapi`）。MCP は community の `orpc-mcp`（v2 専用、14 stars）。maintainer は MCP の core 入りを 2026-07 に見送り |
| **oRPC 2.0.0-beta.41** | ○ forward は rename で動く（検証）。trpc-cli は起動しないので自前 adapter か追従待ち | ◎ `instanceof ProcedureContract` と `walkProcedureContractsSync` が公式 export | ◎ `asyncIteratorObject`（旧 `eventIterator` は alias）。検証で SSE 受信 | ◎ 同上 | △ beta 41 回、GA 未告知。wire format が v1 と非互換（server / client 同時更新）。`.meta` が plugin 制になり `.meta({description})` が型エラー兼 無視される | ○ `orpc-mcp` は v2 専用なので MCP はむしろ v2 側。AI SDK tool 化は first-party |
| **tRPC 11.19.0** | ○ trpc-cli の本家。webview は `import type { AppRouter }`。CLI は contract 相当（builder の木）を自分で定義すれば trpc-cli で動く（検証） | △ 公式の契約分離無し。`router._def.procedures` は "unstable-core-do-not-import"。契約側に query / mutation の区別が無く、CLI に対応表が要った（検証） | ○ SSE subscription は安定 API（`httpSubscriptionLink`、`tracked`）。client は `subscribe({onData})` の observer で `for await` 不可。Bun では `EventSource` ponyfill が要る（検証） | ◎ Standard Schema 対応（PR #6079、v11.0.0 に含む） | ◎ 最成熟。v11 GA 2025-03-21、18 か月で 19 minor、人間 commit の 57% が core 2 名（Nick-Lucas、KATT）、v12 計画無し | ○ `@trpc/openapi` は alpha（SSE 除外）。MCP は community `trpc-to-mcp` 2.0.0 |
| **Hono RPC `hc`** | × 実行時の契約が無く CLI の材料が無い。`app.routes` は basePath / path / method / handler のみ | × 型のみ（`import type { AppType }`）。契約オブジェクト無し | × SSE は素の `Response`、typed SSE は #3309 が 2024-08 から open。WS も素の `WebSocket` | ○ `@hono/standard-validator` 0.4.0 | ◎ Hono 本体は 12 か月で 71 リリース、363 contributors、v5 準備中（#5106）。ただし RPC 層としての機能は変わらない | △ `@hono/mcp` は transport のみ（tool 生成無し）。OpenAPI は別パッケージ |
| **HonoX 0.1.61** | × alpha の SSR meta-framework（file-based routing / islands / Vite）。RPC には `hc` 以上の物を足さない。Tauri webview + Bun sidecar の構成に噛み合わない | × 同上 | × | – | △ "alpha stage"、"Breaking changes are introduced within the same major version" | – |
| **ts-rest 3.52.1** | △ 契約の木 + `isAppRoute` で走査は書ける（検証）。CLI 生成器は無く自前 | ◎ contract-first が設計思想。`initClient(contract)` | × "SSE is beyond the scope of ts-rest"（maintainer、#594）。#775 は放置 | × 3.52.1 の peer は zod 3。zod 4.6.5 では実行は通るが型が崩れる（検証）。Standard Schema は 3.53.0-rc.1（2025-06-02）のまま 16 か月 | × 直近 12 か月の npm 公開 0、main の最終 commit 2025-06-02、"Future of ts-rest" #797 に maintainer の返信無し、v4 は 1 日分の draft PR | ○ `@ts-rest/open-api` は first-party（既定 transformer は zod 3、v4 で削除予定）。MCP 無し |
| **@hono/zod-openapi 1.6.3** | △ `createRoute` の route object は handler 無しで import でき走査できる（検証、marker 関数は無く shape で判定）。CLI は自前。`hc` の型は handler 登録後の app 型 | ○ 契約 object はあるが client 型は実装から | × SSE の型付け無し（middleware#735 が 2024-09 から open） | △ zod 4 専用（Standard Schema 非対応）。drizzle-zod は通る（検証） | ○ Hono org 管理、zod 4 対応は 1.0.0（2025-07-18） | ◎ OpenAPI が本業。MCP は `@hono/mcp` transport のみ |
| **Elysia 1.4.30 + Eden** | × 契約オブジェクト無し（`treaty<typeof app>`）。hono を置き換える（ADR-0001 と衝突） | × | ◎ `sse()` + Eden が `AsyncGenerator` を返し `for await` | ○ 1.4（2025-09）で Standard Schema。`response` への適用は未確認 | △ 1 人メンテ（人間 commit の約 67%）。2.0 は "complete rewrite" の beta。Node は adapter | ○ `@elysia/openapi` first-party。MCP は community |

### forward.ts を各候補で書き直した結果

| 候補 | 書けるか | 中身 |
|---|---|---|
| oRPC 1.15.4 | ◎ 25 行（#8） | `isContractProcedure` な葉を `implement(c).handler(({input, signal}) => remote(path, input, signal))` に置換、`getEventIteratorSchemaDetails` で event iterator を除外 |
| oRPC 2.0.0-beta.41 | ◎ 19 行 | rename 4 つ: `AnyContractRouter`→`RouterContract`、`isContractProcedure`→`instanceof ProcedureContract`、`getEventIteratorSchemaDetails`→`getAsyncIteratorObjectSchemaDetails`、`outputSchema`→`outputSchemas[]`。`createRouterClient` 経由の in-process 呼び出しと SSE は動いた。trpc-cli は `traverseContractProcedures is not a function` |
| tRPC 11.19.0 | ○ 26 行 + 対応表 | 契約を「resolver 無しの `t.procedure.input().output().meta()` の木」として定義し、葉に `.query(fn)` / `.mutation(fn)` を付ける。builder に query / mutation の区別が無いので CLI 側に `{"issue.create": "mutation"}` の表が要る。trpc-cli で help / flag / validation / 実行まで動いた |
| ts-rest 3.52.1 | △ 走査 8 行 | `isAppRoute(node)` で葉判定、`method` / `path` / `body` / `summary` が読める。CLI にするには自前 adapter |
| @hono/zod-openapi 1.6.3 | △ 走査 8 行 | `createRoute` の戻り値を木に置き、`method` / `path` / `responses` を持つ object を葉と判定。CLI は自前 |
| Hono `hc` / HonoX / Elysia | × | 実行時の契約が無い。`app.routes` は handler への参照だけで schema を持たない |

### 自前 CLI adapter の見積（撤退条件が発動した場合）

trpc-cli 0.17.1 の src は `index.ts` 890 行、`parse-procedure.ts` 551 行、`json-schema.ts` 408 行、`parse-router.ts` 313 行（他に completions / prompts / logging）。monica が ADR-0003 で trpc-cli に求めている最小機能（object input → `--flag`、nested command、`--format json`、exit code、`description` の help）だけなら、oRPC 2.0 の `walkProcedureContractsSync` + Standard JSON Schema（zod 4 の `z.toJSONSchema`）+ commander で **200〜300 行**と見積もる。positional、union、completion、prompt は捨てる前提。この見積は未検証。trpc-cli 側を直すなら `parse-router.ts` の `traverseContractProcedures` 呼び出しを `walkProcedureContractsSync(router, (contract, path) => ...)` に置き換える 10 行程度だが、upstream に issue / PR は無い。

## 推奨と ADR-0003 への反映案

ADR-0003 は維持する。Consequences の末尾付近「oRPC は trpc-cli が対応する major（現時点では 1.x）に固定する。」の直後に次の 1 行を足す。

> - 撤退条件: oRPC 2.0 GA 後に trpc-cli が 2.0 に追従しなければ（upstream に issue / PR が無い状態が続けば）、`apps/cli` だけを自前 adapter（`walkProcedureContractsSync` + commander、200〜300 行見積）に書き換えて 2.0 へ上げる。wire format が非互換なので server / webview / CLI は同時に上げる。

あわせて守ると移行が楽になる点（ADR 本文に書くか、package 構成の ticket #20 に流す）:

- contract の説明文は v1 では `.meta({description})`、v2 では `defineMeta("description", ...)` で作った plugin を `.meta(description("..."))` と渡す形になる。どちらも `~orpc.meta.description` に入るので trpc-cli が読む形は同じ。契約側で `description("...")` の小さな helper を 1 つ用意し、`oc.meta(...)` の直接呼び出しを contract 以外に書かないようにしておくと、移行時の差分が 1 ファイルに閉じる。
- `EventPublisher`（`@orpc/server`）は v2 で `MemoryPublisher`（`@orpc/publisher/memory`、`publish` が async）に変わる。router の中でしか使わないので影響は `packages/*/src/router.ts` に閉じる。
- `RPCLink` の `url: "http://127.0.0.1:${port}/rpc"` は v2 で `origin` + `url: "/rpc"` に分かれる。client を作る箇所は desktop の `backend.ts` と CLI の 2 箇所。

## 根拠

### oRPC

- GitHub は `middleapi/orpc`（旧 `unnoq/orpc`）、docs は `orpc.dev`（v1 docs は `v1.orpc.dev`）。npm `@orpc/server` の `repository.url` が `github.com/middleapi/orpc`、homepage が `https://orpc.dev`。stars 5,660、open issues 26、最終 push 2026-10-01。
- メンテナ数: GitHub contributors API の上位は dinwwwh 1,273、bot 3 種、以下 4 commit 以下。直近 12 か月（2025-10-02 以降）の commit は dinwwwh 497 に対し他の人間は合計 20 件程度 <https://github.com/middleapi/orpc/graphs/contributors>。
- リリース: npm の time から、1.x stable は 1.0.3（2025-04-15）が最初、直近 12 か月で stable 50 回（1.9〜1.15）、2.0.0-beta は beta.1（2026-06-21）〜beta.41（2026-10-01）の 41 回。v1 patch と beta が同日に出る（1.15.4 / 2.0.0-beta.40 が 2026-09-23）<https://github.com/middleapi/orpc/releases>。
- contract-first（v2 docs）: "First you write a **contract**: a description of every procedure, its input, and its output, with no logic inside. Then you implement the contract, and TypeScript checks that the implementation matches it exactly." / "Keep this file free of server code. That is what lets the client import it safely later." <https://orpc.dev/docs/contract-first>。実装側は `implement(contract)` <https://orpc.dev/docs/contract/implementation>。v1 の同じページ <https://v1.orpc.dev/docs/contract-first/define-contract>。
- 契約の木の走査: v1 は `isContractProcedure`（`packages/contract/src/procedure.ts`）と `traverseContractProcedures`（`packages/server/src/router-utils.ts`、tag v1.15.4）。v2 は `ProcedureContract` class の `instanceof` と `walkProcedureContractsSync(router, (contract, path) => void)` / `walkProcedureContractsAsync` に置き換わり、`@orpc/server` から export される <https://github.com/middleapi/orpc/blob/main/packages/server/src/router-utils.ts>。`traverseContractProcedures` は v2 の export に無い（beta.41 の `Object.keys(await import("@orpc/server"))` で確認）。
- v1→v2 移行ガイド <https://orpc.dev/docs/migrations/from-v1>: "Most of your code keeps working: many v1 names still compile through deprecated aliases" / "The RPC serializer format and the error response format changed, so v1 RPC Link and OpenAPI Link clients cannot talk to a v2 server. Deploy the upgraded server and client together." / "The 'Event Iterator' concept was renamed to AsyncIteratorObject"（`eventIterator`→`asyncIteratorObject`）/ "`EventPublisher` was removed from `@orpc/server`. Use the Publisher Helpers instead. Note that `publish` is now async."（`MemoryPublisher`）/ "`url` is now a path prefix starting with `/`, and the origin moves to a separate `origin` option" / "Contract types and utilities changed word order from `ContractRouter*` to `RouterContract*`"（`AnyContractRouter`→`RouterContract`、`ContractRouterClient`→`RouterContractClient`）/ "`.meta` now accepts meta plugins created with `defineMeta`, and `.$meta<T>()` was removed" / middleware の自動 dedupe 廃止 / `.route`→`meta(openapi(...))`。
- v2 の metadata は `defineMeta(name, merge)` が `[metaPlugin, getMeta]` を返し、`meta[name]` に格納される <https://orpc.dev/docs/metadata>。v1 は `.meta({...})` の spread merge <https://v1.orpc.dev/docs/metadata>。
- SSE: v1 "Event Iterator" <https://v1.orpc.dev/docs/event-iterator>、v2 "AsyncIteratorObject" <https://orpc.dev/docs/async-iterator-object>。
- Hono adapter（v1 / v2 とも `RPCHandler` from `@orpc/server/fetch` を `app.use("/rpc/*", ...)` で `handler.handle(c.req.raw, {prefix, context})`）<https://orpc.dev/docs/adapters/hono> <https://v1.orpc.dev/docs/adapters/hono>。
- Standard Schema: `@orpc/contract` の package description "Define typesafe API contracts as the single source of truth for oRPC, powered by Standard Schema"。drizzle-zod の直渡しは #3 で確認済（`docs/research/drizzle-bun-sqlite.md`）<https://orpc.dev/docs/integrations/standard-schema>。
- OpenAPI 生成（first-party）<https://orpc.dev/docs/openapi/specification> <https://v1.orpc.dev/docs/openapi/openapi-specification>。AI SDK tool 化（first-party、v2 は `createToolFactory`）<https://orpc.dev/docs/integrations/ai-sdk>。
- MCP: ecosystem ページが community の `mi3lix9/orpc-mcp` を掲載 <https://orpc.dev/docs/ecosystem>。README: "This is a **community package**, not part of oRPC core. It was proposed in middleapi/orpc#1604; the maintainer opted to keep MCP out of core for now" / peer は "`2.0.0-beta.16` or later" <https://github.com/mi3lix9/orpc-mcp>（14 stars、npm 0.1.3、2026-07-30）。PR #1604 で maintainer（2026-07-11）: "For now, I want to keep this as a separate package instead of merging it into core, and promote it as part of the oRPC ecosystem. ... Right now my resources are stretched thin ... my read right now is that MCP interest is trending downward" <https://github.com/middleapi/orpc/pull/1604>。
- oRPC 自身の比較表（tRPC / Hono と）<https://orpc.dev/docs/comparison>。oRPC 側の主張なので一次資料としては割り引く。

### trpc-cli

- 0.17.1（2026-10-01）。peer は `@orpc/server: ^1.0.0`、`@trpc/server: ^10.45.2 || ^11.0.1`。2026 年のリリースは 0.12.2〜0.17.1 の 11 回。GitHub は mmkal 263 commit に対し他は 1 commit の個人 3 名、stars 373 <https://github.com/mmkal/trpc-cli>。
- oRPC の走査は `parseOrpcRouter` が `getOrpcServerModule()` から `traverseContractProcedures` と `isProcedure` を取り、`contract['~orpc'].inputSchema` と `contract['~orpc'].meta`（`TrpcCliMeta`）を読む <https://github.com/mmkal/trpc-cli/blob/v0.17.1/src/parse-router.ts>。
- README <https://github.com/mmkal/trpc-cli/blob/v0.17.1/README.md>: oRPC 節 "it needs to be an `@orpc/server` router, not an `@orpc/contract`" / "lazy procedures aren't supported right now" / "Limitation: No `subscription` support." / "Note that this library is still v0, so parts of the API may change slightly. The basic usage of `createCli({router}).run()` will remain though" / Standalone mode（`t` / `os` を trpc-cli 自身が提供、"experimental and may change"）。oRPC v2 への言及は無い。
- oRPC 対応は PR #105（2025-06-11、v0.9.0）。oRPC v2 / `traverseContractProcedures` に関する issue / PR は 2026-10-02 時点で存在しない（`search/issues?q=repo:mmkal/trpc-cli+orpc` の全件を確認）。

### tRPC v11

- client は型だけ import する設計。"By using `import type` you ensure that the reference will be stripped at compile-time, meaning you don't inadvertently import server-side code into your client." <https://trpc.io/docs/client/vanilla/setup>、"Export only the type of a router! This prevents us from importing server code on the client." <https://trpc.io/docs/server/routers>。契約を実行時オブジェクトとして分ける公式手段は無い。
- 実行時の router: `_def.procedures` はドットパスを key にした平坦な record（`procedures[newPath] = item`）、procedure の `_def` は `type` / `inputs: Parser[]` / `output?` / `meta?` / `middlewares` を持つ <https://github.com/trpc/trpc/blob/main/packages/server/src/unstable-core-do-not-import/router.ts> <https://github.com/trpc/trpc/blob/main/packages/server/src/unstable-core-do-not-import/procedureBuilder.ts>。ディレクトリ名のとおり "DO NOT IMPORT FROM THIS FILE" で、公式 docs に `_def.procedures` の記述は無い。
- Standard Schema: "tRPC works out of the box with a number of popular validation and parsing libraries, including any library conforming to Standard Schema." <https://trpc.io/docs/server/validators>。導入 PR #6079（2025-01-25、v11.0.0 GA より前）<https://github.com/trpc/trpc/pull/6079>。
- SSE: "we recommend using SSE for subscriptions as it's easier to setup" / `tracked()` で再接続 <https://trpc.io/docs/server/subscriptions>。`httpSubscriptionLink` は "a terminating link that uses Server-sent Events (SSE) for subscriptions"、`EventSource` 非対応環境は ponyfill が要る <https://trpc.io/docs/client/links/httpSubscriptionLink>。client の型は `subscribe(input, {onData, onError, ...}) => Unsubscribable` の observer（`packages/client/src/createTRPCClient.ts`）。`unstable_httpSubscriptionLink` は alias として残る <https://github.com/trpc/trpc/blob/main/packages/client/src/links/httpSubscriptionLink.ts>。
- Hono adapter `@hono/trpc-server` 0.4.2 は `fetchRequestHandler` の薄い wrapper <https://github.com/honojs/middleware/tree/main/packages/trpc-server>。
- 成熟度: npm latest 11.19.0（2026-09-16）、v11.0.0 は 2025-03-21 <https://trpc.io/blog/announcing-trpc-v11>。18 か月で 19 minor。直近 12 か月の人間 commit 142 のうち Nick-Lucas 50、KATT 31。移行ガイド <https://trpc.io/docs/migrate-from-v10-to-v11>。v12 の計画は milestone / discussions / blog に無い。
- OpenAPI / MCP: `@trpc/openapi` は "This package is in alpha. APIs may change without notice." / "Subscriptions — currently excluded from the generated spec. SSE support is planned." <https://trpc.io/docs/openapi>（npm 11.19.0-alpha、2026-03-15 初出）。MCP は community の `trpc-to-mcp` 2.0.0（2026-09-24）<https://github.com/iboughtbed/trpc-to-mcp>、awesome-trpc 掲載 <https://trpc.io/docs/community/awesome-trpc>。

### Hono RPC / HonoX / @hono/zod-openapi / @hono/mcp

- `hc`: "export the `typeof` your Hono app (commonly called `AppType`) ... By accepting `AppType` as a generic parameter, the Hono Client can infer both the input type(s) specified by the Validator, and the output type(s)" / client は `import type { AppType } from '.'` <https://hono.dev/docs/guides/rpc>。"IDE performance" 節は route が増えると tsserver が重くなるとし、client 型のコンパイルや app 分割を推奨。
- `app.routes` は `RouterRoute { basePath; path; method; handler }` のみ <https://github.com/honojs/hono/blob/main/src/types.ts>。validator の schema は露出しない。
- SSE: `streamSSE` は素の streaming helper で `hc` との型結合は無い <https://hono.dev/docs/helpers/streaming>。typed SSE の要望 "RPC support for SSE" #3309 は 2024-08-22 から open <https://github.com/honojs/hono/issues/3309>。WebSocket は `client.ws.$ws()` が素の `WebSocket` を返す <https://hono.dev/docs/helpers/websocket>。
- `@hono/standard-validator` 0.4.0（peer `@standard-schema/spec ^1.0.0`）<https://github.com/honojs/middleware/tree/main/packages/standard-validator>。
- HonoX: "a simple and fast meta-framework for creating full-stack websites or Web APIs ... built on Hono, Vite, and UI libraries" / "HonoX is currently in the 'alpha stage'. Breaking changes are introduced within the same major version" <https://github.com/honojs/honox>。npm 0.1.61（2026-08-18）。README に `hc` / RPC の記述は無い。
- `@hono/zod-openapi` 1.6.3（2026-09-04、peer `zod ^4.0.0`、`hono >=4.10.0`、依存 `@asteasolutions/zod-to-openapi`）。`createRoute` は `{...routeConfig, getRoutingPath()}` の plain object、`hc` は `hc<typeof appRoutes>`（handler 登録後の app 型）<https://github.com/honojs/middleware/tree/main/packages/zod-openapi>。zod 4 対応は 1.0.0（2025-07-18）。SSE の型問題 #735 は 2024-09-09 から open <https://github.com/honojs/middleware/issues/735>。Standard Schema 版の代替は個人メンテの `hono-openapi` 1.3.3 <https://github.com/rhinobase/hono-openapi>。
- `@hono/mcp` 0.3.2 は `@modelcontextprotocol/sdk` の Streamable HTTP transport（+ OAuth helper）で、route から tool を生成する機能は無い <https://github.com/honojs/middleware/tree/main/packages/mcp>。
- Hono 本体: 4.13.12（2026-09-30）、直近 12 か月で 71 リリース、contributors 363、直近 12 か月の commit は yusukebe 199 / usualoma 49 / 他は 1 桁。v5 は features list #5106（2026-07-11）と `v5` branch <https://github.com/honojs/hono/issues/5106>。

### ts-rest

- 契約は plain object の木。`isAppRoute = (obj) => 'method' in obj && 'path' in obj` が `@ts-rest/core` から export <https://github.com/ts-rest/ts-rest/blob/main/libs/ts-rest/core/src/lib/dsl.ts>。契約を shared に置く構成 <https://ts-rest.com/contract/overview>。
- fetch handler: "The default `@ts-rest/serverless/fetch` handler is able to handle and route requests for any runtime that follows the WinterCG Minimum Common Web Platform API" <https://ts-rest.com/server/serverless/fetch-runtimes>。Hono 公式 adapter は無い（`feat/hono-adapter` branch は 2023-05 で停止）。
- Standard Schema / zod 4: 3.53.0-rc.1（2025-06-02）"Support the 'Standard Schema' validation interface to enable support for Zod4, Valibot, Arktype etc." <https://github.com/ts-rest/ts-rest/releases/tag/v3.53.0-rc.1>。npm `latest` は 3.52.1（2025-03-04、peer `zod ^3.22.3`）のまま、`rc` が 3.53.0-rc.1。公式サイトのバナーも "available as a release candidate `3.53.0-rc.1`" <https://ts-rest.com/openapi>。
- SSE: maintainer（Gabrola、2024-05-01）"SSE is beyond the scope of ts-rest as event schemas are inherently not defined by paths, headers, or anything similar." <https://github.com/ts-rest/ts-rest/issues/594>。#775 "Support for EventSource" は 2025-03 から open。
- 保守状況: main の最終 commit 2025-06-02、直近 12 か月の npm 公開 0、"Future of ts-rest" #797（2025-05〜）に maintainer 返信無し <https://github.com/ts-rest/ts-rest/issues/797>、v4 は draft PR #863（2026-02-06 の 1 日分）<https://github.com/ts-rest/ts-rest/pull/863>。
- OpenAPI: `@ts-rest/open-api` の `generateOpenApi`、既定 transformer は zod 3 で "this built-in support will be removed in v4" <https://ts-rest.com/openapi>。

### Elysia + Eden

- Eden Treaty は `treaty<App>(url)` に `typeof app` の型だけ渡す。契約オブジェクトは無い <https://elysiajs.com/eden/treaty/overview>。
- Standard Schema は 1.4 "Supersymmetry"（2025-09）"Elysia now supports Standard Schema" <https://elysiajs.com/blog/elysia-14>。
- SSE: `sse()` helper と generator、"Eden will interpret a stream response as `AsyncGenerator` allowing us to use `for await` loop" <https://elysiajs.com/essential/handler.html>。
- 2.0 は "a complete rewrite of Elysia" で beta（npm `next` 2.0.0-beta.20）<https://elysiajs.com/blog/elysia-20>。直近 12 か月の commit は SaltyAom 256 / 383。Hono との相互 mount は可能 <https://elysiajs.com/patterns/mount.html> だが、ADR-0001 の「hono が webview に配信」を置き換える判断になる。

## 検証したこと

scratchpad `rpc-options/` に候補ごとの bun プロジェクトを作り、bun 1.3.13 で実行した。各ディレクトリは残してある。

### `orpc2/` — oRPC 2.0.0-beta.41（+ `@orpc/publisher` 2.0.0-beta.41、hono 4.13.12、zod 4.6.5、drizzle-zod 0.8.3、trpc-cli 0.17.1）

- `contract.ts`: #8 の contract を `asyncIteratorObject` と `oc` で移植。drizzle-zod の `createSelectSchema` / `createInsertSchema` をそのまま `.input` / `.output` に渡した。
- `router.ts`: `implement(contract).$context<TaskContext>()`、`EventPublisher` を `MemoryPublisher`（`publish` を await）に置換。
- `forward.ts`（19 行）: `instanceof ProcedureContract`、`getAsyncIteratorObjectSchemaDetails(outputSchemas[i])` で event iterator を除外、`implement(contract).handler(({input, signal}) => call(path, input, signal))`。
- `server.ts`: hono + `RPCHandler`（`@orpc/server/fetch`）を `/rpc/*` に mount、`Bun.serve({port: 0})`。
- `cli.ts walk`: `walkProcedureContractsSync(router, (c, path) => ...)` が `issue.list` / `issue.create` を列挙（`changes` は forward が除外済）。
- `cli.ts direct`: 転送 router を `createRouterClient` と `call()` で in-process 実行 → remote の `issue.create` / `issue.list` が通った。
- `cli.ts sse`: `RPCLink({origin, url: "/rpc"})` で `issue.changes` を `for await` し、`issue.create` 後に `{"type":"issue.created",...}` を受信。
- `cli.ts`（trpc-cli）: `createCli({router}).run()` が `TypeError: traverseContractProcedures is not a function` で `--help` も出ない（#2 と同じ）。
- `tsc`: `.meta({description: "..."})` が `MetaPlugin` 型に合わず型エラーになり、実行時も `~orpc.meta` が `{}` になる（description が捨てられる）。`meta-check.ts` で `const [description] = defineMeta("description", (incoming: string) => incoming)` → `.meta(description("List issues"))` にすると `~orpc.meta` が `{"description":"List issues"}` になり型も通った（trpc-cli が読む `TrpcCliMeta` の形と一致）。

### `trpc/` — @trpc/server 11.19.0、@trpc/client、@hono/trpc-server 0.4.2、trpc-cli 0.17.1、eventsource

- `contract.ts`: `initTRPC.meta<Meta>().create()` の `c.procedure.input(NewIssueSchema).output(IssueSchema).meta({description})` を resolver 無しで木に置いた（契約相当）。
- `router.ts`: `contract.issue.create.mutation(fn)` のように葉に resolver を付けて `t.router`。`tsc` では契約側の builder に context 型が無く `ctx.db` が `{}` 扱いでエラー。契約側を `initTRPC.context<Context>()` にすれば通るが、契約が server の context 型を知る構造になる。
- `defshape.ts`: `router._def.procedures` の key は `["issue.list","issue.create","issue.changes"]`、各 `_def` に `type` / `inputs` / `output` / `meta` が入っていることを確認。
- `forward.ts`（26 行）+ `cli.ts`: 契約の木を走査し `.query(forward)` / `.mutation(forward)` を付けて `t.router` に包み trpc-cli へ。builder に query / mutation の区別が無いので `kinds` 表を手書きした。結果: `--help` で `issue` → `list` / `create` が description 付きで出る、`issue create --repo ... --number 21 --title ...` が remote に届き結果が yaml で出る、`issue list` が表で出る、`--number abc` は exit 1 で validation error。
- `subscribe.ts`: `splitLink` + `httpSubscriptionLink`。Bun 1.3.13 は `typeof EventSource === "undefined"` で初回は空の `TRPCClientError`。`eventsource` package を `EventSource` option に渡すと `issue.changes` が `onData` で 1 件受信。curl でも `event: connected` が返り、server 側 SSE は `@hono/trpc-server` 経由で動く。

### `tsrest/` — @ts-rest/core / serverless / open-api 3.52.1、zod 4.6.5、drizzle-zod 0.8.3

- `contract.ts`: `initContract().router({issue: c.router({list, create})})`、`body` / `responses` に drizzle-zod の schema。
- `main.ts`: `isAppRoute` で木を走査（`issue.list GET /issues`、`issue.create POST /issues body: yes`）。`fetchRequestHandler` を hono の `app.all("/api/*")` から呼び、`initClient` で `create` 201 / `list` 200 / 不正 body 400（ZodError 本文）。**実行はすべて通るが `tsc` は 7 件エラー**（`tsr.router` の実装型が合わない、`initClient` の戻りが callable でない）。3.52.1 の型が zod 3 の `ZodTypeAny` 前提で、zod 4 の schema を型として解釈できないため。

### `zodopenapi/` — @hono/zod-openapi 1.6.3、hono 4.13.12、zod 4.6.5、drizzle-zod 0.8.3

- `contract.ts`: `createRoute` の戻り値を `routes.issue.{list, create}` の木に置いた（handler 無し）。
- `main.ts`: shape（`method` / `path` / `responses`）で葉を判定して走査。`OpenAPIHono().openapi(route, handler)` を 2 つ chain し、`hc<typeof app>` で `$post` 201 / `$get` 200 / 不正 body 400、`/openapi.json` に `/issues` が出る。`tsc` はエラー無し。

## 制約と注意

- tRPC で #8 の構成を再現する場合、契約は「resolver 無しの builder の木」という非公式の構造で、(a) builder が query / mutation を知らないので CLI に対応表が要る、(b) 契約側の `initTRPC` に server の context 型が要る、(c) `_def` は "unstable-core-do-not-import" 配下で semver の保証が無い。tRPC の client は observer なので CLI の `--follow` は `subscribe` を自前で async iterable に包み、Bun では `EventSource` ponyfill を入れる。
- Hono RPC で CLI を作るなら OpenAPI 文書（`@hono/zod-openapi` か `hono-openapi`）を中間表現にして別の生成系へ渡す迂回しか無く、契約が TypeScript の型と OpenAPI の 2 系統になる。
- oRPC v2 では `.meta()` の引数が plugin になるので、#8 の「`.meta({description})` を trpc-cli が読む」convention はそのままでは壊れる。`defineMeta("description")` の helper を契約側に 1 つ置けば形は保てる（上記検証）。trpc-cli が v2 で動かない以上、v2 でこれを読むのは自前 adapter か追従後の trpc-cli。
- oRPC v2 は wire format が v1 と非互換なので、server / webview / CLI を別々に上げられない。monica は 1 repo なので同時更新は可能だが、desktop の sidecar と CLI の配布単位が違う場合は version 不一致を検出する手当てが要る。
- oRPC の bus factor は 1。trpc-cli も 1。この 2 つが同時に止まると「契約の走査 → CLI」の経路は自前になるが、`walkProcedureContractsSync` と `~orpc` の形が残る限り 200〜300 行の見積で書き直せる（未検証の見積）。
- GitHub の blob URL は本調査中に curl で 503 を返したが、内容は API 経由で読んだ。リンク先は存在する。

## 未確認

- oRPC 2.0 GA の時期。issue / discussion / README に表明が無い。
- trpc-cli の oRPC v2 対応予定。issue / PR が無い。
- `orpc-mcp` の品質（14 stars、0.1.3、2026-07-30 が最終更新）。personal agent 着手時に改めて見る。
- oRPC v2 の `defineMeta("description")` を trpc-cli が help に出すか。trpc-cli が v2 で起動しないため、`~orpc.meta` の形が一致することだけ確認した。
- tRPC の `_def.procedures` に依存する既存 OSS（trpc-to-openapi / trpc-to-mcp / trpc-cli）の実装詳細。
- ts-rest 3.53.0-rc.1 の実機検証（3.52.1 のみ試した）。
- Elysia + Eden と HonoX の実機検証（一次資料のみ）。
- 自前 CLI adapter の 200〜300 行という見積。
