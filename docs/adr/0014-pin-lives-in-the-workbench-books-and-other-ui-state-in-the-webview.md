---
status: accepted
---

# pin は Workbench の帳簿に置き、ほかの UI 状態は webview の localStorage に置く

monica は Workbench の UI 状態を tauri-plugin-store の `ui-state.json` に、Tab の pin を SQLite の `terminal_runspaces.pinned_tab_id` に持っていた。plugin-store を選んだ理由は、複数の window が同じファイルを読み書きすることと Work Board の focus だった。tania には multi-window も Work Board も無く、active な Runspace と Tab、sidebar の開閉と幅、UI zoom を読み書きするのは webview だけなので、webview の localStorage に置く。pin は #22 で「UI だけの状態」として帳簿から外したが、帳簿に戻す。pin した Tab を新しい Runspace に切り出す操作と、CLI の Attach で pin した Tab が別の Runspace へ移る操作は、どちらも layout の書き込みで、layout の書き手は Backend だけだから（ADR-0011）。pin を webview に置くと、切り出しと pin の書き込みが 2 か所に分かれ、Attach で Tab が動いたことは webview が layout の差分から推し量るしかなくなる。

## Considered Options

- **UI 状態も plugin-store に置く**（monica 踏襲）: 読み書きするのが webview だけなのに Shell に plugin が増え、Tauri にしか無いものだけを Shell に置く基準（ADR-0001）に合わない。
- **UI 状態も Backend の DB に置く**: Tab を切り替えるたびに procedure を呼ぶことになり、その書き込みだけ `workbench.changes` を流さない例外が要る。
- **pin を webview の localStorage に Tab id で持つ**: Backend には「Tab を新しい Runspace へ移す」操作だけを足せば済む。ただし上の 2 か所への書き込みと Attach の推し量りが残る。また、webview は attach 中の Tab の Exit しか受けないので、表示していない Tab や、app が落ちている間に死んだ session を張り直せない。

## Consequences

- pin された Tab の shell の張り直しは Backend が持つ。Backend の ptyd 接続はすべての session の Exit を受け（ADR-0011）、reconcile も自分で行うので、表示していない Tab の exited も、ptyd の入れ替えや再起動による lost も拾える。monica の pin の Tab は lost になるたびに手で張り直されていた。
- 張り直しに即死の歯止めを置く。session が作られてから 2 秒以内に終わったら張り直さない。`.zshrc` が壊れていて即死を繰り返す shell を、Backend が起こし続けないため。
- `tab.close`、`terminalSession.terminate`、`runspace.remove` は pin された Tab を `CONFLICT` で断る。所有された Runspace の remove を断るのと同じ形にする（ADR-0012）。Task の close（`removeRunspace`）は pin を見ない。close は worktree を消すので、pin した Tab を残しても shell は消えた directory に居ることになる。
- dev と release の localStorage は混ざらない。release は app の identifier ごとに分かれる。dev の binary は bundle ではないので、実行ファイル名（`tania-desktop`）の WebKit data に入り、その中で origin（vite の port）ごとに分かれる。vite の port は `TANIA_HOME` ごとに決まる（ADR-0007）が、塞がっていて別の port で起きると、別の home の id が残ることがある。見つからない id は先頭の Runspace と Tab に戻すので害は無い。
