---
status: accepted
---

# backend が DB を唯一所有し、CLI は同じ contract から生えた remote client にする

monica では CLI（clap）と desktop（Tauri command）と web（axum）が別々の入口を持ち、画面操作と CLI の実装が分かれていた。tania ではドメインごとに oRPC の contract と router を 1 つ定義し、tania-backend（desktop が起動する sidecar）だけがそれを実装して SQLite を開く。hono が webview に配信し、CLI は contract から機械的に組んだ remote client として同じ procedure を HTTP で呼ぶ。CLI は backend が立っていないと動かず、それを仕様とする。

当初は「CLI は router を in-process で実行して DB を直接開く」と決めたが、2026-10-02 に反転した。desktop 無しで CLI を使う要件を捨てると、却下理由だった「CLI に in-process か remote かの抽象が入る」が消え（remote 専用なら分岐が無い）、DB の書き手が 1 プロセスになることで migration の競合、deferred transaction の `SQLITE_BUSY_SNAPSHOT`、CLI の書き込みを desktop に伝える経路（DB を IPC キューにする monica の構図）がすべて不要になるため。

## Considered Options

- **CLI が router を in-process で実行し DB を直接開く**（当初の決定）: desktop 無しでも CLI が動く。代わりに 2 プロセスが同じ SQLite を開くので、drizzle 標準の `migrate()` が同時起動で片方失敗する、書き込み tx を `BEGIN IMMEDIATE` に統一しないと落ちる、backend が CLI の書き込みを知る経路が別途要る、の 3 つを構造で強制し続ける必要がある（`docs/research/drizzle-bun-sqlite.md`）。

## Consequences

- DB を開くのは backend の 1 プロセスだけ（ADR-0007 で `locking_mode=EXCLUSIVE` により DB 自身に守らせる）。migrate は backend の起動時に drizzle 標準の `migrate()` で行う。bun:sqlite は同期 API なので 1 接続で書き込みが直列化され、busy handling は要らない。
- backend は自分の書き込みを知っているので、変更は in-process の event として webview に SSE で push する。polling も `PRAGMA data_version` も使わない。
- CLI は `$TANIA_HOME/backend.json`（port と token と pid）を procedure を呼ぶたびに読んで backend を見つける。Workbench の tab にも `TANIA_HOME` だけを渡し、port と token は env に入れない。backend が居なければ「desktop を起動してください」で終了する。retry の条件は ADR-0007。
- CLI のテストは remote link を `createRouterClient`（in-process）に差し替える。差し替え点はこの 1 箇所だけ。
- skill は CLI の command を呼ぶので、router の procedure が skill の語彙になる。
- 賭けるのは oRPC、保険をかけるのは trpc-cli。router の定義は oRPC に依存するが、trpc-cli は「router を走査して command にする」変換器にすぎず、同じ要領で自前の CLI adapter や MCP adapter を書ける。trpc-cli は router を in-process で `call()` するので、CLI 側には contract を走査して各 procedure を remote client に転送する router を機械的に組んで渡す。これが動かないとき、trpc-cli が oRPC の新 major に追従しなくなったとき、または CLI の UX を細かく作り込みたくなったときは、`apps/cli` だけを自前 adapter に書き換える。そのために次を守る。
  - trpc-cli 固有の機能（`meta({positional})`、custom logger による streaming の回避）を `apps/cli` の外に漏らさない。
  - 出力形式（`--format json`）と exit code の写像は自分のコードで持ち、trpc-cli の logger に頼らない。
  - event iterator（streaming）の procedure は trpc-cli では動かない。流し続けたい command（`--follow` など）は trpc-cli の外で remote client の event iterator を iterate して書く。
  - personal agent に着手する時点で、同じ contract から MCP adapter を生やす research を行う。
- oRPC は trpc-cli が対応する major（現時点では 1.x）に固定する。
- CLI に出すのは、contract で `.meta({ cli: true })` を付けた procedure だけ（opt-in）。CLI は Skill の語彙なので、意図して選んだものに限る。opt-out にすると、隠し忘れた webview 専用の procedure（layout の保存、Terminal Session の作成など）が、Skill から呼べる語彙として黙って増える。`cli` は tania 独自の meta key で、trpc-cli 固有の機能ではない。
- exit code は 0 = 成功、1 = それ以外の失敗（usage・domain・想定外）、2 = Backend 不在。Skill が分けて扱う必要があるのは「desktop を起動してと言うべきか」だけで、guard の理由は stderr の 1 行目 `CODE: message` で読める。trpc-cli は usage エラーも handler の throw も 1 で `process.exit` を自分で呼ぶので、`run({ process: { exit } })` で差し替えて写像する。
- 手で書く command（hook、`--follow`）は各 package の `cli` entry に置き、`apps/cli` の main は argv を見て trpc-cli を import する前に振り分ける。hook は tool 1 回ごとに起動するため。compiled で比べると、trpc-cli と contract の実体を import すると約 46ms、その前に振り分けると約 18ms だった。
- CLI は Backend と別の compiled binary にする（externalBin が 2 つ）。1 つの binary に同居させれば Bun の runtime 分の約 60MB が減るが、どちらかの entry が両方の apps を import することになり、hook も約 30ms に遅くなる。どちらも同じ .app に入るので、CLI と Backend の版はずれない。
- backend の寿命（app 同寿命か、ptyd のように app より長生きさせるか）と孤児・respawn・port の再取得は CLI の可用性に直結する。ADR-0007 で app 同寿命に決めた。
