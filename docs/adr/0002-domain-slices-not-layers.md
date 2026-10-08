---
status: accepted
---

# 層ではなくドメインでフォルダを切り、1 つの概念は 1 箇所で定義する

旧 Monica ではフィールドを 1 つ足すたびに migration、storage の行マッピング、port trait、全 port の fake、application の型、API の写し型と変換、Tauri command、生成 bindings、TS の 9 段に手が入り、小さな変更が数十ファイルに波及した。原因は Rust ではなく、同じ概念を層ごとに写す clean architecture の構成にある。monica では port / adapter / usecase / DTO の分割を採用せず、`packages/<domain>/` が schema（drizzle）、router（oRPC）、CLI、skill、UI を縦に持つ。型は schema から推論して client まで 1 定義で流し、写し型を作らない。

## Consequences

- v1 のドメインは `task` と `workbench` の 2 つ。GitHub client は `task` の内部に置き、2 つ目の利用者が出たら切り出す。
- テストで DB を fake に差し替えることはせず、in-memory SQLite で本物を使う。
- apps（desktop / cli / backend）は packages を組み立てるだけで、ロジックを持たない。package の entry の切り方は ADR-0009。
