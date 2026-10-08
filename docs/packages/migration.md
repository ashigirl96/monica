# migration

domain の package ごとの drizzle の migration の置き方と当て方。Backend が当てる順は `docs/packages/backend.md` の「起動と終了」にある。

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
- table が 0 本の package は、0 本のまま `drizzle-kit generate` を 1 回走らせ、出てきた `meta/_journal.json`（`entries: []`）を commit する。`migrate()` はこれで何もせずに通り、後で table を足せば普通に `0000_*.sql` ができる。custom migration は作らない。bun:sqlite はコメントだけの SQL を `Invalid SQL statement` で落とす。
- 履歴 table は package ごとに分ける。既定の `__drizzle_migrations` を共有すると、drizzle は `created_at` の大小しか比べないので、片方の migration が黙って飛ばされる。runtime の `migrate()` には `migrationsTable` を必ず渡す（drizzle.config の `migrations.table` は `drizzle-kit migrate` にしか効かない）。
- folder の basename は domain 名にする。`--asset` は basename の位置に mount するので、2 つの `drizzle/` を同梱すると `meta/_journal.json` が衝突して build が落ちる。
- compiled binary ではどの module の `import.meta` も entry のものになるので、package の中で `new URL("../drizzle", import.meta.url)` と書くと壊れる。folder の親に置いた `migrations/index.ts` の `import.meta.dir` を使えば、`bun run` でも compiled でも同じ source で動く。
- task の snapshot に task の table しか無いことをテストで確かめる（workbench の table を re-export すると二重に CREATE される）。
