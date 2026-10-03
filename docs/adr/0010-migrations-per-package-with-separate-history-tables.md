---
status: accepted
---

# migration は package ごとに持ち、履歴 table を分ける

DB は Backend が開く 1 つで、task の schema は workbench の table に FK を張る（#15）。drizzle.config を apps/backend に 1 つ置いて全 package の schema を集めれば migration の履歴も 1 本で済み、いちばん単純になる。しかしその形では、package のテストが in-memory DB を作るために apps の migration folder を読むという逆向きの依存が生まれ、列を 1 つ足す作業が package の外にはみ出す。そこで各 package が drizzle.config と migration folder を持ち、履歴 table を `__drizzle_migrations_<d>` に分け、Backend が workbench → task の順に `migrate()` を呼ぶ。列を足す作業（schema、生成物、`bun --watch` 用の journal の import）は package の中で閉じる。

## Considered Options

- **apps/backend に drizzle.config を 1 つ**: `../../packages/*/src/schema.ts` の glob で 1 本の migration に FK ごと生成できることは確かめた。履歴は 1 本で済む。上の 2 つの理由で採らない。

## Consequences

- ユーザーの DB に履歴 table が package の数だけ残る。後から 1 本にまとめるには履歴の移し替えが要る。
- 履歴 table を共有してはいけない。drizzle の migrator は「最後に適用した行の `created_at` より新しい folder の migration」しか見ず、hash を比べない。そのため 2 つの folder が既定の `__drizzle_migrations` を共有すると、片方の migration が黙って飛ばされる（実測で `no such table` になった）。runtime の `migrate()` には `migrationsTable` を必ず渡す。drizzle.config の `migrations.table` は `drizzle-kit migrate` にしか効かない。
- task の schema は workbench の table を import するだけで re-export しない。re-export すると task の migration に workbench の table の `CREATE TABLE` が入り、二重作成で落ちる。task の snapshot に task の table しか無いことをテストで確かめる。
- migration folder の basename は domain 名にする（`packages/<d>/migrations/<d>/`）。`bun build --compile --asset` は basename の位置に mount するので、2 つの `drizzle/` を同梱すると `meta/_journal.json` が衝突して build が落ちる。名前を付け替える構文は Bun に無い。
- compiled binary ではどの module の `import.meta` も entry のものになる。そのため folder の位置は folder の親に置いた `migrations/index.ts` の `import.meta.dir` から求める。この形なら `bun run` でも compiled でも同じ source で動く。
- package のテストは in-memory DB に自分の migration を当てる。task は workbench → task の順に当てる。
