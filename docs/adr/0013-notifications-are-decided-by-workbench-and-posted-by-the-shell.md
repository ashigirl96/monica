---
status: accepted
---

# 通知は workbench が hook の edge で決め、Shell が出す。webview も outbox も使わない

monica は hook を受ける CLI プロセスで「待ちに入った edge」を判定して SQLite の `notification_outbox` に upsert し、Desktop の drain スレッドが 2 秒おきに読んで tauri-plugin-notification で出していた。CLI と Desktop が別プロセスだったので DB を仲介にし、Desktop が起動していない間の通知もそこに溜めた。tania では hook を Backend の `agentSession.recordHook` が適用し、Backend は desktop と同寿命（ADR-0007）なので、edge を判定するプロセスと通知を出すプロセスの間に「相手が居ない時間」が無い。そこで workbench が `recordHook` の中で前の行・event・次の行から通知を決めて本文を組み、Backend の stdout に 1 行書き、Shell がその行をそのまま tauri-plugin-notification に渡す。`workbench.changes` は合図だけで前の行を運ばない（`docs/packages.md`）ので、edge を判定できるのは `recordHook` だけである。

## Considered Options

- **webview が `workbench.changes` を購読し、JS の plugin で出す**: active な Tab を知っているので見ている Tab の通知を抑えられ、Shell の責務も増えない。しかし WKWebView は最小化・hide・別 Space・完全に覆われた状態で不可視扱いになり、timer が間引かれ、macOS 14 以降は既定で JS が suspend される。Tauri の `backgroundThrottling: "disabled"` でも timer の間引きは残る。通知が要るのは tania を見ていない時なので、肝心な時に遅れるか止まる。monica も同じ理由で frontend での検知を退けた。
- **Backend が osascript で出す**: Shell に手を入れずに済むが、Script Editor の名義で出て、クリックすると Script Editor が開く。
- **Shell で UNUserNotificationCenter を使う**（user-notify などの crate）: 待ちが解けたら取り下げ、クリックで該当 Tab へ移れ、前面でもバナーが出る。ただし前面時の抑制を自前で持つために webview の active Tab を Shell に知らせる経路が要り、bundle の無い dev（`tauri dev`）では通知が出ない。v1 の基準は「待ちに気づく」で、tauri-plugin-notification で足りる。
- **outbox を置く**（monica 踏襲）: 判定する Backend と、それを子に持つ Shell の間で完結し、Backend 不在中の hook は捨てる（ADR-0007）ので、溜めるものが無い。monica では drain の 2 秒の窓が、自動承認されたプランの「承認待ち」を出す無駄撃ちも生んでいた。

## Consequences

- 出す遷移は workbench の純関数 `notificationFor(前の行, event, 次の行)` が決める。質問とエラーはその理由の待ちに入った時に、許可は PermissionRequest が来るたびに（どちらも `state_changed_at` が変わった時。ADR-0008）出し、手空きは動作中・未観測からの Stop の時だけ出す。SessionStart による手空き（起動・resume）と、待ちから手空きへの変化（許可の解消を見落とした後の Stop。deny と Esc では hook が来ない。ADR-0008）では出さない。edge 1 つに通知 1 つで、dedupe key は持たない。
- title は呼び名、body は理由（`手空き`、`質問`、`許可: Bash`、`エラー: rate_limit`）。呼び名は task が `nameAgentSession(db, agentSessionId)` で差し込み、Run の Task、無ければ Tab の Bench の Task を `<repo>#<n> <title>` で返す。引けなければ Agent Session の cwd の末尾 2 つ。workbench は task を import しない（ADR-0005）ので、apps/backend が `createWorkbench` に渡す。音は鳴らさない。
- Backend の stdout は Shell 宛ての JSON 行専用の channel になる。行は `{"type":"endpoint",…}`（ADR-0007）と `{"type":"notify","title","body"}` の 2 種で、Shell は解釈できない行を自分の log に流して捨てる。Backend の log は stderr に出す。Shell は Task も Agent Session も知らず、title と body を渡すだけ。
- 出した通知は取り下げない。クリックは OS の既定どおり tania を前面に出すだけで、Tab には移らない。tania が最前面の間はバナーが出ず、通知センターに入るだけになる（NSUserNotificationCenter の既定で、plugin の delegate は上書きできない）。前面で使っている間は sidebar の status dot が代わりになる。
- dev（`tauri dev`）の通知は plugin が Terminal.app の名義で出すので、Terminal.app に通知の許可が要る。release は app の identifier の名義で出る。
- Backend の再起動時にまとめて出さない。不在中に待ちに入ったかは分からず、不在の前からの待ちは通知済みのため。まとめて出すと、dev では `bun --watch` の再起動のたびに出てしまう。
- 通知を切る設定は v1 に無い。
