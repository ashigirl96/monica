---
name: desktop-dev
description: "dev の desktop を起こし、tauri-mcp で画面を確かめる。受け入れ条件を画面で確かめるとき、一瞬だけ出る表示を捉えるとき、窓の枠（信号機・vibrancy）を撮るときに使う。"
---

dev の desktop は `TANIA_HOME` ごとに identifier と vite の port が分かれ、ほかの home の desktop と並んで動く。同じ home での 2 つ目の起動は、single-instance が既存の窓を前に出して終わる。ユーザーや別の worktree の desktop も同じ machine で動いているので、自分の desktop は home の名前で見分ける。

## 起こす

1. home は `${TMPDIR%/}/tania-<worktree の名前>` に固定する（名前は `basename "$(git rev-parse --show-toplevel)"`）。session ごとに新しい名前を作らない。identifier と vite の port は home から決まり、変わると desktop の crate を build し直すため。ptyd の socket（`$TANIA_HOME/ptyd.sock`）の path は 104 byte が上限なので、超えるときは名前を先頭から収まる長さで切ったものに固定する。
2. `bun run dev:list` で、`tania-<名前>` の行の KIND が `desktop` なら、同じ worktree の別の session が起こしたもの。起こさずに、その行の BRIDGE の port で手順 4 に進む。
3. Bash の `run_in_background` で起こし、出力は scratchpad の file に向ける。終わったら印の行を足し、待つ側が抜けられるようにする。

   ```bash
   TANIA_HOME=${TMPDIR%/}/tania-<名前> bun run desktop > $SCRATCH/desktop.log 2>&1; echo '[desktop exited]' >> $SCRATCH/desktop.log
   ```

4. tauri-mcp の `driver_session` を `start` で繋ぐ。port は log の `MCP Bridge plugin initialized for 'tania-dev' (<identifier>) on 127.0.0.1:<port>` から取る。繋いだら `status` の identifier が `com.ashigirl96.tania.dev.tania-<名前>-` で始まるかを確かめる（名前の英数字と `-` 以外は `-` になる）。bridge は 9223 から空きを選び、driver_session は最後に繋いだ app を既定にするので、別の desktop を触っていることがある。

起動できたのは、log に `MCP Bridge plugin initialized` と `[backend] listening on` が出たとき。待つのは、Bash の `run_in_background` で `until grep -qE '^\[backend\] listening on|^\[desktop exited\]' $SCRATCH/desktop.log; do sleep 0.5; done` を走らせる（前景の `sleep` は harness が止める）。MCP の WebSocket の行も `listening on` を含むので、`[backend]` まで含めて探す。`[desktop exited]` で抜けたら log を読む。

自分の desktop の pid は、`bun run dev:list` の `tania-<名前>` の行の DESKTOP から引く。`pgrep -f target/debug/tania-desktop` はユーザーや別の worktree の desktop にも当たる。

## 確かめる

- **書き込み**は、Terminal Session に直接送る。id は `TANIA_HOME=… bun run tania workbench terminal-session list --format json` の `tabId` から引く。

  ```js
  window.__TAURI__.core.invoke("terminal_write", { sessionId, data: btoa("echo ok\r") })
  ```

  - `webview_keyboard` の `type` は、最初に一致した要素に打つ。隠れた pane の textarea にも当たるので、使うなら先に、見えている pane（祖先に `display: none` が無いもの）の textarea に固有の id を付け、その id を狙う。
  - 合成のキーイベントは keydown だけを送る。keypress も送ると、xterm が両方を拾って文字が二重になる。
- **Tab の切り替え**は、`[data-tab-id]` の button に `pointerdown` と `pointerup` を `dispatchEvent` する。Tab は pointerdown で切り替わるが、tauri-mcp の click は pointerdown を出さない。
- **端末の link**: 端末は WebGL で描くので、行の DOM は無い。座標を screenshot で読み、`document.elementFromPoint(x, y)` に `metaKey: true` の `mousemove` を送る。xterm は同じ cell への mousemove を無視するので、先に別の cell へ動かしてから狙う。link が付いたかは、見えている `.xterm-screen` の class に `xterm-cursor-pointer` があるかで分かる。⌘-click は、hover の後に `metaKey: true, buttons: 0` の `pointerdown` を送る。
- **画像の drop**: OS の drag は起こせないので、`window.__TAURI__.event.emitTo({ kind: "Webview", label: "main" }, "tauri://drag-drop", { paths, position: { x, y } })` で Tauri の drop と同じ handler を動かす。clipboard を上書きする確かめ方は、先に `pbpaste` で退避し、最後に `pbcopy` で戻す。
- **clipboard への書き込み**（`navigator.clipboard.writeText`）は、合成のキーイベントでは user activation が無いので `NotAllowedError` で断られる。確かめるのは binding が拾って書きにいくところまでにし、実キーでの確認はユーザーに頼む。
- **Agent Session の状態**（status dot）は、backend-headless の「Agent Session の状態を claude 無しで動かす」の手順で作る。`TANIA_HOME` は desktop の home にする。
- **一瞬だけ出る表示**（overlay、Detached の行）は、webview の中で `requestAnimationFrame` ごとに DOM を見て、変わった時刻だけを配列に残す。操作も同じ script の中で起こし、frame の時刻とずれないようにする。
- **長い script**: `webview_execute_js` は約 5 秒で timeout し、`timeout` を大きく渡しても延びない。async の処理は裏で走り続ける。数秒を超えるものは await せずに走らせ、結果は `window.__…` に貯めて、後の呼び出しで読む。timeout した後に同じ script を走らせると、2 本が重なる。
- **窓の枠**: `webview_screenshot` には信号機も vibrancy も写らない。自分の desktop の pid が持つ窓の CGWindowID を取って `screencapture` で撮る。

  ```bash
  cat > $SCRATCH/winid.swift <<'EOF'
  import CoreGraphics
  let pid = Int(CommandLine.arguments[1])!
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for w in list where w[kCGWindowOwnerPID as String] as? Int == pid {
    print(w[kCGWindowNumber as String]!)
  }
  EOF
  screencapture -x -o -l$(swift $SCRATCH/winid.swift <DESKTOP の pid> | head -1) $SCRATCH/window.png
  ```

- **Shell の起こし直し**は、`kill -TERM <DESKTOP の pid>` の後に、起こすの手順 3 をやり直す。background の job を TaskStop すると、子孫の ptyd まで止まる。ptyd が生き残れば、再 attach と replay まで確かめられる。
- **app の終了**（localStorage の UI 状態のように、終了の手順を通った後に残るものを確かめるとき）は、pid 宛てに AppKit の正規の quit を送る。dev の binary は bundle として登録されていないので、identifier 宛ての `tell application id … to quit` は届かない。

  ```bash
  echo "import AppKit; print(NSRunningApplication(processIdentifier: <DESKTOP の pid>)?.terminate() ?? false)" > $SCRATCH/quit.swift
  swift $SCRATCH/quit.swift
  ```

## 止めて片付ける

止めるのは、手順 3 で自分が起こした desktop だけ。手順 2 で別の session の desktop に繋いだときは、そのまま残してその session に任せる。`dev:kill` は desktop・Backend・端末をまとめて止め、home も消すため。

自分で起こした desktop は、`bun run dev:kill tania-<名前>` で desktop → Backend → ptyd の順に止め、home を消す。desktop が止まると background の job も終わる。

片付いたのは、`bun run dev:list` に `tania-<名前>` の行が無いとき。
