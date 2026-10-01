# Epic Brief 本文の書き手は Orchestrator のみとし、Worker はコメントで書き戻す

issue 本文は `gh issue edit --body` で全文置換するしかなく、複数の Worker が同時に書くと更新が消える。そのため本文の書き手を Orchestrator に限定し、Worker は epic issue へのコメント（追記専用、衝突しない、通知が飛ぶ）で Discovery と Human Action を書き戻す。tick は minimize されていないコメントを本文の各節に畳み込み、畳んだら Resolved で minimize する。削除はしない。通知は既に飛んでいること、チームメイトの返信が孤児になること、履歴が消えること、が理由。

## Consequences

- コメントの量は「tick はコメントを書かない」「Worker は sub-issue あたり原則 1 本、追記は自分のコメントの編集」で抑える。
- Worker が他 Worker の Discovery を読むときは、本文と未 minimize のコメントの両方を読む。
- 本文のうち人間が書く節（ゴール・スコープ外・経緯・分解方針）は GitHub UI での直接編集を許す。tick は自分が再生成する節（Status・Verification）を HTML コメントで区切り、その区間だけを置換する。
