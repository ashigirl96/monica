# Tab の dot と未読

desktop の Tab には、その Tab の claude の状態が dot で出る。ユーザー待ちになった Agent Session をユーザーがまだ見ていなければ未読になり、Dock の icon に未読の数が出る。窓を前に出してその Tab を表示すると未読でなくなり、数が消える。

## Sub-features

- `dot-state`: Tab の dot の title が状態（`動作中`・`手空き`・`質問`・`許可`・`エラー`・`未観測`）を出す。
- `dot-unread`: 表示していない Tab の Agent Session が待ちに入ると、未読になる。
- `dot-dock`: Dock の数が未読の Agent Session の数になる。
- `dot-seen`: 窓を前に出してその Tab を表示すると、未読でなくなり数が消える。

## How to get to it (user POV)

- desktop の窓の上の Tab の並び。dot は Tab の名前の左。
- macOS の Dock の Monica の icon。
- 通知センターの通知のクリック（`release-notifications` skill が確かめる。dev の desktop では確かめない）。

## Driving it with dev の desktop と tauri-mcp

Preconditions:

- `surfaces/desktop.md` の「起こす」で `MONICA_HOME=${TMPDIR%/}/monica-<worktree の名前>` の desktop を起こし、tauri-mcp の `driver_session` の identifier が `com.ashigirl96.monica.dev.monica-<名前>-` で始まる。`H` はその home、`E=${TMPDIR%/}/verify-monica/<worktree の名前>` を `mkdir -p` しておく。
- `bun run dev:list` の `monica-<名前>` の行の DESKTOP の pid を控える。
- Tab が 2 つある。1 つなら `surfaces/desktop.md` の「Tab を開く」（Ctrl+T の後に `c` の keydown）で足す。`MONICA_HOME=$H scripts/monica-dev workbench terminal-session list --format json` で、前面でない Tab（A）の `tabId` と id を控える。

- **dot を出す.** A の Terminal Session で SessionStart の payload を流す（payload は `docs/research/hook-payloads.md`）。`printf '%s' '<payload>' | MONICA_HOME=$H MONICA_TERMINAL_SESSION_ID=<A の id> scripts/monica-dev workbench hook claude`。`webview_execute_js` で `document.querySelector('[data-tab-id="<A>"] span[title="手空き"]') !== null` が `true`。
- **待ちにする.** 同じく `"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"` の payload を流す。`[data-tab-id="<A>"] span[title="質問"]` が出る。
- **Dock の数を読む.** `lsappinfo info -only StatusLabel "$(lsappinfo find pid=<DESKTOP の pid>)"` が `{ "label"="1" }` を返す。Dock の数は screenshot に写らないので、この出力を証拠にする。
- **見る.** tauri-mcp の `manage_window` の `focus` で窓を前に出し、`document.hasFocus()` が `true` になってから、`[data-tab-id="<A>"]` の button に `pointerdown` と `pointerup` を `dispatchEvent` する。もう一度 `lsappinfo` を読むと `[ NULL ]` か `kCFNULL` になる。
- **証拠.** 待ちにした後と見た後の窓を、`surfaces/desktop.md` の「窓の枠と端末の字形」の `screencapture` で `$E/desktop-agent-dot-{waiting,seen}.png` に撮る。流した payload・`webview_execute_js` の結果・各回の `lsappinfo` の出力を `$E/desktop-agent-dot.transcript` に残す。

## Gotchas

- 起動直後の手空きでは通知が出ず、未読にもならない。未読を作るのは質問・許可・エラーの待ちか、turn の終わりの手空き。
- 待ちに入れた時に A を表示していると、窓が前面なら見たことになり、未読にならない。先に別の Tab を前面にする。
- `webview_screenshot` には Tab の dot は写るが、Dock の数は写らない。数は `lsappinfo` で読む。
- tauri-mcp の click は `pointerdown` を出さないので Tab が切り替わらない。必ず `dispatchEvent` で送る。
- 最小化した窓は `focus` だけでは前に出ず、見たことにならない。`surfaces/desktop.md` の「窓の前面と背面」の手順で前に出す。
- Rust の file を直すと dev の desktop が Shell を build し直して pid が変わる。`lsappinfo` の前に `dev:list` で pid を引き直す。
- 片付けは `surfaces/desktop.md` の「止めて片付ける」（`bun run dev:kill monica-<名前>`）。`cleanup.sh` は使わない。desktop の Backend は `launch.sh` で起こしていない。`$E` は残す。
