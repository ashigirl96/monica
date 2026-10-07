---
status: accepted
---

# 未読は Workbench の帳簿に置き、webview は見た時だけ書く

未読は「通知を出した Agent Session の待ちを、私がまだ見ていないこと」で、2 つの事実を合わせて決まる。通知を出したことは、前の行と hook の event を比べる Backend の `recordHook` だけが知っている（ADR-0013）。`workbench.changes` は合図しか流さず、`state_changed_at` は通知を出さない遷移でも動くので、webview はこれを導けない。見たこと（desktop の窓が前面にあり、その Agent Session の Tab を表示した）は webview だけが知っている。両方を Agent Session の行に、通知した時刻と見た時刻として置き、未読は Backend が導いて `agentSession.list` で渡す。webview が procedure を呼ぶのは、表示した Tab の Agent Session が未読の時だけで、Tab を切り替えるたびではない。ADR-0014 が UI 状態を DB に置く案を退けた理由はここには当たらない。

## Considered Options

- **見た時刻を webview の localStorage に置く**（ADR-0014 の延長）: procedure を足さずに済むが、未読の判定が Backend の通知した時刻と webview の見た時刻の 2 か所に分かれる。また窓が隠れている間は WKWebView の JS が止まるので（ADR-0013）、Dock の数のように webview の外へ出す数を裏で更新できない。
- **待ちに入った時刻（`state_changed_at`）と見た時刻を比べる**: Backend に手を入れずに済むが、通知の飛ばない待ち（claude の起動直後の手空きなど）も未読になり、通知と数が合わない。

## Consequences

- `docs/packages/workbench-ui-state.md` の「見たかどうか（既読）は持たない」を覆す。
- 見たことは UI 状態ではなく通知への応答として帳簿に置く。active な Runspace と Tab は今までどおり webview の localStorage に置く。
- webview は窓が前面かどうかを読む必要がある。今は Shell も webview も追っていない。
