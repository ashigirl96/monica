---
status: accepted
---

# notes の画面は TanStack Query で組み、外の更新は focus のたびに取り直す

ブラウザで開く notes の画面（`apps/web` と `@tania/notes/ui`）は、データ取得に TanStack Query を使う。desktop の webview は jotai か useState に状態を持ち、domain ごとの変更の stream を購読して読み直すが、notes の画面はその形を採らない。Chromium の HTTP/1.1 の接続は host:port ごとに 6 本までなので、タブごとに stream を張ると、タブが増えたところで読み込みが止まる（ADR-0017）。そのため外の更新は、monica と同じく focus のたびに取り直す。これには cache、Repo Note の一覧のページング、focus での取り直し、作成や削除の後の cache の書き換えが要り、どれも TanStack Query が持っている。monica の notes の画面もすでに TanStack Query で組まれており、query の層を oRPC の client に替えるだけで移せる。

## Considered Options

- **jotai と oRPC の client（workbench の形）**: repo の中のやり方が 1 つで済む。代わりに、cache、無限スクロールのページング、focus での取り直し、cache の書き換えを自前で作り直すことになる。
- **`@orpc/tanstack-query` で query key と queryOptions を contract から組む**: monica の query key をそのまま使えなくなり、依存も 1 つ増える。

## Consequences

- repo の中にデータ取得のやり方が 2 つある。desktop は jotai（か useState）と変更の stream、web は TanStack Query と focus での取り直し。
- 入れるのは `@tanstack/react-query` だけ。queryFn は oRPC の client を呼び、QueryClient は `@tania/notes/ui` の root で作る。`apps/web` は TanStack Query を知らない。
- autosave と競合の判定は TanStack Query に依存しない（monica と同じ）。保存は query の cache を通らない。
- Backend が notes の変更の stream を持つことになっても、合図を受けて query を invalidate すればよく、この形は崩れない。
