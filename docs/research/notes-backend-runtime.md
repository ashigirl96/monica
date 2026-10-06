# notes の Backend の runtime

wayfinder の map「monica の notes を tania に移す」のチケット「Rust にあった notes の処理を Backend のどこに置くか」で調べた事実。monica の側の事実は `docs/research/monica-notes.md` にある。

確かめた環境: macOS 26.6.2（arm64）、Bun 1.4.2、drizzle-orm 0.45.3、drizzle-kit 0.31.11、oRPC 1.15.4、hono 4.13.12、zod 4.6.5、prosemirror-model 1.25.12、prosemirror-markdown 1.13.8。【実機】と書いたものは scratchpad に同じ版を入れて確かめた。

## 要点

| 問い | 答え |
|---|---|
| bun:sqlite で fts5 の trigram を使えるか | 使える。macOS の Bun は system の `/usr/lib/libsqlite3.dylib`（3.51.0）を読み、compile した binary も同じ |
| drizzle で fts5 を持てるか | schema には書けない。`drizzle-kit generate --custom` の SQL に書けば snapshot に載らず、以後の generate も触れない。ただし table を作り直す migration で trigger が消える |
| oRPC で画像を受け渡せるか | input の File は multipart で通る。output の File は常に multipart に包まれ、`content-type: image/png` の生のバイト列は RPCHandler では返せない |
| 1 本の接続に複数の stream を載せられるか | batch では束ねられない。WebSocket の adapter なら 1 本に多重化できる |
| OGP を Bun で読めるか | 組み込みの HTMLRewriter で抜き出せる。entity は decode されず、Shift_JIS は先に TextDecoder を通さないと化ける |
| ProseMirror は Bun の server で動くか | prosemirror-model と prosemirror-markdown は DOM 無しで動く |

## bun:sqlite と fts5

- 【実機】`select sqlite_version()` は 3.51.0、`sqlite_source_id()` の末尾は `aapl`。compile options に `ENABLE_FTS5` がある。`otool -L` に libsqlite3 は出ず、`DYLD_PRINT_LIBRARIES=1` で実行時に `/usr/lib/libsqlite3.dylib` が読まれる。`bun build --compile`（tania と同じフラグ）の binary も同じ。`Database.setCustomSQLite()` で homebrew の 3.53.4 に差し替えられる。
- 【実機】`fts5(body, note_id UNINDEXED, tokenize='trigram')` は `:memory:` でも、`locking_mode=EXCLUSIVE` と WAL の file DB でも通る。日本語は 3 文字以上で当たり、3 文字未満の MATCH はエラーにならずに 0 件を返す。2 文字の `LIKE '%東京%'` は全件を走査して正しく返し、3 文字以上の `LIKE` は trigram の index を使う。`highlight()` と `snippet()` は日本語でも動く。
- trigram は SQLite 3.34.0 以降の機能で、古い macOS の system SQLite の版は確かめていない。tauri の設定に `minimumSystemVersion` は無い。
- 【実機】`prepare()` した文を保持したまま `db.close()` を呼ぶと EXCLUSIVE の lock が残り、開き直すと `SQLITE_BUSY` になる。`db.close(true)` なら開き直せる。

## drizzle と custom migration

- drizzle-orm の sqlite-core に virtual table を書く builder は無い。
- 【実機】`drizzle-kit generate --custom --name <name>` は 1 行のコメントだけの SQL を作り、journal と snapshot も 1 つ進める。そこに virtual table と trigger を書き、schema に列を足して generate すると、出るのは `ALTER TABLE ... ADD` だけで virtual table には触れない。`drizzle-kit check` も通る。
- 【実機】列の default を変えるなど、drizzle-kit が table を作り直す SQL（`CREATE TABLE __new_x` → `INSERT ... SELECT` → `DROP TABLE` → `RENAME`）を出すと、その table の trigger が黙って消える。`migrate()` は成功で終わり、以後の insert は fts に入らない。
- 【実機】作り直しと同時に列を足すと、0.31.11 の `INSERT ... SELECT` は旧 table に無い列も二重引用符で選ぶ。SQLite はそれを文字列 literal と読むので、新しい列に列名の文字列が入る。
- 【実機】`migrate()` は SQL を `--> statement-breakpoint` でだけ分け、各片を `prepare().run()` で流す。trigger の `BEGIN ... END;` の中の `;` では壊れない。区切りを忘れて 1 片に複数の文を並べると、bun:sqlite の `prepare()` が最初の文しか実行せず、残りは黙って捨てられる。

## oRPC で File と stream を扱う

- 【実機】input の `z.file()`（`.max()`・`.mime()` も効く）と `z.instanceof(File)` は通る。RPCLink は File を含む input を自動で `multipart/form-data` で送り、size・type・name・中身が保たれる。mime が違えば `BAD_REQUEST`。
- 【実機】output の File と Blob も client に届くが、RPC の response は常に `multipart/form-data` になる（`StandardRPCSerializer#serialize` が Blob を含む値を FormData に包む）。`ResponseHeadersPlugin` で `cache-control` は付けられるが、content-type は変えられない。method の無い procedure への GET は 405、`.route({ method: 'GET' })` を付けても本文は multipart のまま。
- 【実機】`@orpc/openapi` の `OpenAPIHandler`（tania には入っていない）は、root の output が File なら生のバイト列を `content-type`・`content-disposition`・`content-length` 付きで返す。
- 【実機】event iterator は購読 1 つにつき 1 本の SSE の response になる。`BatchLinkPlugin` で 2 本の購読を送ると、どちらも `500`（`Batch responses do not support file/blob, or event-iterator`）。client は Blob や FormData の body の request を自動で batch から外す。
- 【実機】`@orpc/server/bun-ws` と `@orpc/client/websocket` なら、1 本の socket に 2 本の購読と 1MiB の File の取得が多重化される。tania の hono の後ろに置く形は試していない。

## OGP を Bun で読む

- 【実機】組み込みの `HTMLRewriter` で `<title>`、`meta[property^="og:" i]`、`meta[name^="twitter:" i]`、`link[rel~="icon" i]` を抜き出せる。属性名の大文字小文字は区別せず、属性値は `i` を付けたときだけ区別しない。`meta[property="og:title"]` は body の中の meta にも一致する。
- 【実機】entity は decode されず（`&quot;`・`&amp;` のまま）、text の前後の空白も残る。header に `charset=shift_jis` があっても日本語は化ける。`new TextDecoder('shift_jis')` は正しく decode するので、先に decode してから渡す形なら成り立つ（その組み合わせは試していない）。
- 【実機】`fetch` に `AbortSignal.timeout()` を渡すと、header が遅い場合も body の途中で止まる場合も時間で `TimeoutError` になる。`res.body.getReader()` で数えながら読み、上限で `reader.cancel()` と abort を呼べば、server への送信も止まる。上限で `terminate()` する `TransformStream` を `HTMLRewriter.transform()` に渡しても正常に終わる。

## ProseMirror を Bun で動かす

- 【実機】`typeof document === 'undefined'` の Bun で、prosemirror-model の `new Schema()`・`Node.fromJSON()`・`check()`・`descendants()`・`textBetween()`・`toJSON()` が動く。未知の node 型は `fromJSON` が throw し、content の規則に違反した JSON は `fromJSON` を通って `check()` が throw する。
- 【実機】prosemirror-markdown 1.13.8（markdown-it 14.3.2）の既定の parser と serializer が動く。
