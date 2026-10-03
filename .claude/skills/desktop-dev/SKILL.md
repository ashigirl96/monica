---
name: desktop-dev
description: "dev の desktop を起こし、tauri-mcp で画面を確かめる。受け入れ条件を画面で確かめるとき、一瞬だけ出る表示を捉えるとき、窓の枠（信号機・vibrancy）を撮るときに使う。"
---

dev の desktop（identifier `com.ashigirl96.tania.dev`）は single-instance で、vite も port 1420 に固定されている。1 台に 1 つしか起きないので、ユーザーが同じ dev app を使っていることがある。その間は、自分で開いた Tab だけを触る。

## 起こす

1. `pgrep -f target/debug/tania-desktop` で、もう起きていないか確かめる。起きていれば、それに繋ぐ。
2. Bash の `run_in_background` で起こし、出力は scratchpad の file に向ける。home は `$TMPDIR` の下に短い名前で作る（ptyd の socket の path の上限は 104 byte）。

   ```bash
   TANIA_HOME=${TMPDIR%/}/tania-<name> bun run desktop > $SCRATCH/desktop.log 2>&1
   ```

3. tauri-mcp の `driver_session` を `start`（port 9223）で繋ぐ。

起動できたのは、log に `MCP Bridge plugin initialized` と `[backend] listening on` が出たとき。

## 確かめる

- **書き込み**は、Terminal Session に直接送る。id は `TANIA_HOME=… bun run tania workbench terminal-session list --format json` の `tabId` から引く。

  ```js
  window.__TAURI__.core.invoke("terminal_write", { sessionId, data: btoa("echo ok\r") })
  ```

  - `webview_keyboard` の `type` は、最初に一致した要素に打つ。隠れた pane の textarea にも当たるので、使うなら先に、見えている pane（祖先に `display: none` が無いもの）の textarea に固有の id を付け、その id を狙う。
  - 合成のキーイベントは keydown だけを送る。keypress も送ると、xterm が両方を拾って文字が二重になる。
- **Tab の切り替え**は、`[data-tab-id]` の button に `pointerdown` と `pointerup` を `dispatchEvent` する。Tab は pointerdown で切り替わるが、tauri-mcp の click は pointerdown を出さない。
- **一瞬だけ出る表示**（overlay、Detached の行）は、webview の中で `requestAnimationFrame` ごとに DOM を見て、変わった時刻だけを配列に残す。操作も同じ script の中で起こし、frame の時刻とずれないようにする。
- **長い script**: `webview_execute_js` は約 10 秒で timeout するが、async の処理は裏で走り続ける。数秒を超えるものは await せずに走らせ、結果は `window.__…` に貯めて、後の呼び出しで読む。timeout した後に同じ script を走らせると、2 本が重なる。
- **窓の枠**: `webview_screenshot` には信号機も vibrancy も写らない。CGWindowID を取って `screencapture` で撮る。

  ```bash
  cat > $SCRATCH/winid.swift <<'EOF'
  import CoreGraphics
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for w in list where (w[kCGWindowOwnerName as String] as? String ?? "").contains("tania") {
    print(w[kCGWindowNumber as String]!)
  }
  EOF
  screencapture -x -o -l$(swift $SCRATCH/winid.swift | head -1) $SCRATCH/window.png
  ```

- **Shell の起こし直し**は、`kill -TERM $(pgrep -f target/debug/tania-desktop)` の後に、起こすの手順 2 をやり直す。background の job を TaskStop すると、子孫の ptyd まで止まる。ptyd が生き残れば、再 attach と replay まで確かめられる。

## 止めて片付ける

1. 自分で開いた Tab は、`exit` を送って閉じる。
2. ユーザーが使っていなければ、background の job を TaskStop で止め、`rm -rf ${TMPDIR%/}/tania-<name>` で home を消す。ptyd は socket が消えたのを 2 秒おきの確認で見つけ、shell ごと終わるので、下の判定は数秒待ってからする。

片付いたのは、`pgrep -f target/debug/tania-desktop` と `pgrep -f "tania-ptyd --tania-home ${TMPDIR%/}/tania-<name>"` が何も返さず、home が消えたとき。ユーザーが使っている dev app は止めず、起こしたままだと伝える。消し忘れた dev は `bun run dev:list` で見つけ、`bun run dev:kill <NAME>` で片付ける。
