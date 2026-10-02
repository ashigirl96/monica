# drizzle × bun:sqlite の migration 運用と 2 プロセス共有

Issue #3 の調査結果。ADR-0003 の「CLI と sidecar が同じ SQLite ファイルを WAL で開く」「schema から型を 1 定義で流す」が drizzle + `bun:sqlite` で成立するかを、一次資料と小さな検証プロジェクトで確認した。

## 結論

| 問い | 答え |
|---|---|
| drizzle-kit generate → 起動時 migrate。両プロセスが起動時に migrate して衝突しないか | **部分的に成立**。generate はそのまま使える。drizzle 標準の `migrate()` は 2 プロセス同時起動で片方が必ず失敗した（5/5 回）。`BEGIN IMMEDIATE` の中で判定と適用を行う自前 migrator なら衝突しない（6/6 回）。`drizzle-kit migrate` は bun:sqlite に接続できない |
| `bun build --compile` に migration ファイルを同梱する方法 | **Yes**。Bun 1.4.0 以降は `--asset ./drizzle` で drizzle 標準の `migrate()` がそのまま動く。1.3.x には `--asset` が無いので、`.sql` を `with { type: "text" }` で import して自前 migrator に渡す |
| WAL + busy_timeout で 2 プロセス同時書き込み | **Yes、条件付き**。書き込み tx は `BEGIN IMMEDIATE` 必須。deferred だと busy_timeout が効かず SQLITE_BUSY_SNAPSHOT で落ちる。新規 DB の WAL 切替と crash 後の recovery でも SQLITE_BUSY が出るので retry が要る |
| in-memory DB でテストする方法（migration 含む） | **Yes**。`new Database(":memory:")` に `migrate()` がそのまま効く。ただし journal_mode は `memory` のままで、WAL 固有の挙動は in-memory では再現できない |
| drizzle-zod / drizzle-valibot → oRPC の input / output | **Yes**。両方 Standard Schema なので `.input()` `.output()` に直接渡せる。timestamp 列は `z.date()` になるので JSON 境界では coerce が要る。json 列の `$type` は型にだけ効き、実行時は任意の JSON を通す |
| 他プロセスの書き込み検知（#G3 の材料） | **data_version は Yes、update hook は No**。`PRAGMA data_version` は他プロセスの commit で変わり、自分の commit では変わらない（1 回 約 1μs）。bun:sqlite は `sqlite3_update_hook` を公開していない。そもそも update hook は登録した connection の変更しか拾わない |

## 根拠

### migration の仕組み

- `drizzle-orm/bun-sqlite/migrator` の `migrate()` は `readMigrationFiles()` で `meta/_journal.json` と `.sql` を読み、`SQLiteSyncDialect.migrate()` に渡す。https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/bun-sqlite/migrator.ts
- `SQLiteSyncDialect.migrate()` の手順は (1) `CREATE TABLE IF NOT EXISTS __drizzle_migrations` (2) `SELECT ... ORDER BY created_at DESC LIMIT 1` で最後の適用済みを読む (3) `BEGIN`（deferred） (4) `created_at < folderMillis` の migration を実行して INSERT (5) `COMMIT`。「どれを適用するか」の判断 (2) がトランザクションの外にあり、これが衝突の原因。https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/sqlite-core/dialect.ts
- `readMigrationFiles()` は `drizzle-orm/migrator` から公開 export されている。hash は `.sql` 全文の sha256、`folderMillis` は journal の `when`。https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/migrator.ts
- `drizzle-kit migrate` は SQLite 接続に `better-sqlite3` か `@libsql/client` を要求する（drizzle-kit 0.31.11 の `bin.cjs` のメッセージ。実行でも確認）。https://orm.drizzle.team/docs/drizzle-kit-migrate
- 起動時に `migrate()` を呼ぶ運用は公式の案内に沿う。https://orm.drizzle.team/docs/migrations

### 単一バイナリへの同梱

- `--asset <dir>` で埋め込んだディレクトリは `import.meta.dir` 直下に現れ、`node:fs` の `existsSync` `readdirSync` `readFileSync` と `Bun.file()` から読める。https://bun.sh/docs/bundler/executables
- `--asset` は PR #36302（2026-07-29 merge）で入り、tag `bun-v1.4.0` に含まれ `bun-v1.3.13` には含まれない（GitHub compare API で確認）。https://github.com/oven-sh/bun/pull/36302
- `with { type: "file" }` の import は `/$bunfs/root/<name>-<hash>.<ext>` にフラット化されるので、フォルダ構造を前提にする `readMigrationFiles()` には使えない。

### WAL と 2 プロセス書き込み

- "writers and readers can run at the same time. However, since there is only one WAL file, there can only be one writer at a time." https://sqlite.org/wal.html
- WAL は永続。"after being set it stays in effect across multiple database connections and after closing and reopening the database" https://sqlite.org/pragma.html#pragma_journal_mode
- deferred tx で read から write に昇格する時、他 connection が先に commit していると SQLITE_BUSY_SNAPSHOT。https://sqlite.org/rescode.html#busy_snapshot
- busy handler は deadlock になりうる場合は呼ばれず即 SQLITE_BUSY を返す。例として "one process is holding a read lock that it is trying to promote to a reserved lock" が挙がる。https://sqlite.org/c3ref/busy_handler.html
- `BEGIN IMMEDIATE` は write tx を即時に開始し、WAL では EXCLUSIVE と同じ。https://sqlite.org/lang_transaction.html
- WAL でも SQLITE_BUSY が返るケース: 最後の connection の close 中、crash 後の recovery 中。https://sqlite.org/wal.html の §9
- `PRAGMA busy_timeout` は `sqlite3_busy_timeout()` の pragma 版。https://sqlite.org/pragma.html#pragma_busy_timeout
- bun:sqlite の `db.transaction(fn)` は `.deferred()` `.immediate()` `.exclusive()` を持つ。docs は WAL を推奨し、macOS では `-wal` `-shm` が close 後も残ると明記。https://bun.sh/docs/runtime/sqlite
- drizzle の bun-sqlite session は `db.transaction(fn, { behavior })` を `nativeTx[behavior]()` に流す（既定は `deferred`）。https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/bun-sqlite/session.ts

### 変更検知

- data_version: "will be different if changes were committed to the database by any other connection in the interim. The 'PRAGMA data_version' value is unchanged for commits made on the same database connection. The behavior ... is the same for all database connections, including database connections in separate processes" https://sqlite.org/pragma.html#pragma_data_version
- update hook は "registers a callback function with the database connection identified by the first argument" で connection 単位。他プロセスの変更への言及は無い。https://sqlite.org/c3ref/update_hook.html
- bun:sqlite の update hook は issue #4175 が open、PR #12631 も未 merge。https://github.com/oven-sh/bun/issues/4175 https://github.com/oven-sh/bun/pull/12631

### schema から oRPC へ

- oRPC は "supports Zod, Valibot, Arktype, and any other Standard Schema library"。https://orpc.dev/docs/procedure
- drizzle-zod は `createSelectSchema` `createInsertSchema` `createUpdateSchema`、refinement は callback で拡張・schema で上書き、`createSchemaFactory` で coerce を設定。peer は `zod ^3.25 || ^4`。https://orm.drizzle.team/docs/zod
- drizzle-valibot は同じ 3 関数。peer は `valibot >=1.0.0-beta.7`。https://orm.drizzle.team/docs/valibot

## 検証したこと

環境: macOS arm64、Bun 1.3.13（bun:sqlite の SQLite は 3.51.0）。`--asset` のみ Bun 1.4.2 でも実行。drizzle-orm 0.45.3、drizzle-kit 0.31.11、drizzle-zod 0.8.3、zod 4.6.5、drizzle-valibot 0.4.2、valibot 1.5.0、@orpc/server 1.15.4。schema は `tasks` 1 表（integer pk autoincrement、text、integer mode boolean、text mode json に `$type`、integer mode timestamp）。

1. 2 プロセス同時書き込み。WAL 済み DB に対し各 300 tx、tx 内で SELECT → 2ms の busy loop → INSERT。
   - `BEGIN IMMEDIATE` + `busy_timeout=5000`: 両方 300/300 成功、合計 600 行。
   - deferred `BEGIN` + `busy_timeout=5000`: 片方 300 成功、もう片方 0 成功（SQLITE_BUSY_SNAPSHOT 298、SQLITE_BUSY 2）。
   - `busy_timeout=0`: 片方が起動直後の `CREATE TABLE IF NOT EXISTS`（SQLITE_BUSY）や `PRAGMA journal_mode=WAL`（SQLITE_BUSY_RECOVERY）で即死。
   - 新規ファイルに 2 プロセスが同時に `PRAGMA journal_mode = WAL` を打つと、busy_timeout を先に設定していても片方が SQLITE_BUSY。
2. drizzle 標準 `migrate()` を 2 プロセス同時起動。5/5 回で片方が失敗（新規 DB では 2 回が WAL 切替の SQLITE_BUSY、3 回が `CREATE TABLE tasks` の already exists。WAL 済み DB でも 3/3 回 already exists）。
3. 自前 migrator。`readMigrationFiles()` の結果を bun:sqlite の `transaction(fn).immediate()` の中で `__drizzle_migrations` と突き合わせて適用、WAL 切替は SQLITE_BUSY なら retry。6/6 回で両方成功（適用 1 + 0、履歴 1 行）。hash は drizzle 標準と同一の値。
4. in-memory。`drizzle({ client: new Database(":memory:") })` に `migrate()` で表が作られ、json / boolean / timestamp の insert と select が往復した。2 回目の `migrate()` は no-op。`PRAGMA journal_mode` は `memory`。
5. `PRAGMA data_version`。自 commit で 2 → 2、別プロセスの commit で 2 → 3、再読で 3。open read tx の最中は 3 のまま固定で、COMMIT 後に 4。10,000 回読んで 12.5ms。
6. update hook。`Database.prototype` に hook 系 API は無く、bun-types にも `SQLITE_FCNTL_BUSYHANDLER` 定数以外は無い。
7. `bun build --compile`。Bun 1.3.13 では `--asset` が未知の flag（`--asset-naming` のみ）で、`.sql` を `with { type: "text" }`、journal を JSON import して自前 migrator に流すと動いた。Bun 1.4.2 では `--asset ./drizzle` で `import.meta.dir/drizzle` に `0000_init.sql` と `meta/` が現れ、標準 `migrate()` がそのまま成功した（binary 62MB）。
8. drizzle-zod / drizzle-valibot → oRPC。`os.input(createInsertSchema(tasks).omit({ id: true })).output(createSelectSchema(tasks))` と valibot 版が tsc strict で通った。`~standard.vendor` は `zod`。`createdAt` は `z.date()` で ISO 文字列を reject、`createSchemaFactory({ coerce: { date: true } })` で accept。`meta` は型レベルでは `$type` が効く（`{ nope: 1 }` は型エラー）が、実行時は任意の JSON を通す。`z.toJSONSchema` では date が空 schema になる。

## 制約と注意

- 起動時 migrate は、1 本の `BEGIN IMMEDIATE` の中で「判定 + 適用」を行う自前 migrator にする。`readMigrationFiles()` と `__drizzle_migrations` の形式はそのまま流用できるので、drizzle-kit generate の成果物と履歴表は標準と共有できる。sidecar だけが migrate する設計にする場合は、CLI 側に schema 不一致の検出が別途要る。
- 書き込み tx は必ず immediate にする。drizzle 経由なら `db.transaction(fn, { behavior: "immediate" })`。auto-commit の単発 INSERT は busy handler で待てるが、「読んでから書く」tx は deferred だと待てない。
- 接続直後の順序は `busy_timeout` → `journal_mode = WAL`（SQLITE_BUSY なら retry）→ migrate。WAL は永続なので、retry が必要なのは新規作成直後と recovery 時だけ。
- macOS では `-wal` `-shm` が close 後も残る。消したいなら `SQLITE_FCNTL_PERSIST_WAL` を 0 にして `wal_checkpoint(TRUNCATE)`。WAL は同一ホスト限定で、network filesystem では使えない。
- `--asset` は Bun 1.4.0 以上。`with { type: "sqlite", embed: "true" }` は DB ファイル自体をメモリに埋める機能で、migration 同梱には使わない。
- in-memory テストでは WAL の挙動（BUSY、data_version の他プロセス検知）は再現できない。それらは一時ファイル + 子プロセスで検証する。
- drizzle-zod の timestamp は `z.date()`。素の JSON で Date を運ぶ経路では `createSchemaFactory({ coerce: { date: true } })` か refinement が要る。json 列は `$type` の shape を refinement で上書きしないと実行時検証にならない。
- 変更検知は `data_version` の polling が現実的。「変わった」ことしか分からず、どの表かは分からない。書き手が通知する設計にするなら DB 外の経路になる。

## 未確認

- drizzle `migrate()` の衝突が Linux でも同じ頻度で起きるか（原理上は同じ）。
- drizzle-kit の将来版が bun:sqlite 接続を持つか。
- Bun の update hook PR #12631 が merge されるか。
- `--asset` を複数指定した時の配置（issue #44062 で basename に潰れる仕様が議論中）。
- oRPC の client link が Date をどうシリアライズするか。今回は server 側の型と validation だけ確認した。
