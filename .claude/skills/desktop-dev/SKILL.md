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
  - 修飾キーの打鍵（Ctrl+V、Shift+Enter など）は、`window.__taniaTerminals.get(tabId).textarea` に keydown を dispatch する。tania の key handler と xterm の encode を本物の打鍵と同じ順に通るので、Tab の app に同じバイト列が届く。`keyCode` は `Object.defineProperty` で足す（xterm は Ctrl+文字を `keyCode` から作る）。

    ```js
    const ev = new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { get: () => 86 });
    window.__taniaTerminals.get(tabId).textarea.dispatchEvent(ev);
    ```

  - xterm が Tab に送ったバイト列は、`window.__taniaTerminals.get(tabId).onData` を購読して読む。合成のキーでは paste や copy のようなブラウザの既定の動作は起きないので、起きるかどうかは dispatch した event の `defaultPrevented` で見る（xterm が encode したキーは cancel される）。key の encode を変えたときは、⌘C・⌘V・⌘A でもこの 2 つを見る。
  - shell の Tab に Ctrl+V（`\x16`）を送ると、zsh は次の 1 文字を quoted-insert でそのまま入れる。続けて command を送る前に、別のキーを 1 つ送って抜ける。

- **画面の文字**は、dev の webview が晒す `window.__taniaTerminals`（tabId → xterm の `Terminal`）の buffer から読む。cursor の行までの末尾 10 行:

  ```js
  (() => { const b = window.__taniaTerminals.get(tabId).buffer.active; const end = b.baseY + b.cursorY; return Array.from({ length: 10 }, (_, i) => b.getLine(end - 9 + i)?.translateToString(true)); })()
  ```
- **Tab の切り替え**は、`[data-tab-id]` の button に `pointerdown` と `pointerup` を `dispatchEvent` する。Tab は pointerdown で切り替わるが、tauri-mcp の click は pointerdown を出さない。
- **窓の前面と背面**（未読のように窓の focus で変わる振る舞い）は、`osascript -e 'tell application "Finder" to activate'` で別の app を前に出して背面にし、tauri-mcp の `manage_window` の `focus` で前面に戻す。最小化（`manage_window` の `minimize`）では webview の JS が止まりうるので、focus の event が届いて背面と扱えたのかを見分けられない。
  - 最小化した窓は `focus` だけでは戻らず、`document.visibilityState` が `hidden` のまま残る。`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is <DESKTOP の pid>) to true'` で前に出してから `focus` する。前面に来たかは webview の `document.hasFocus()` で確かめる。
- **Dock の数**（icon の badge）は webview の外なので screenshot に写らない。`lsappinfo info -only StatusLabel "$(lsappinfo find pid=<DESKTOP の pid>)"` で読む。数があれば `{ "label"="3" }`、無ければ `[ NULL ]` か `kCFNULL` になる。Backend の落ちと respawn のように一瞬で変わるものは、50ms おきに読んで変わった時刻だけを残す。Rust の file を直すと dev の desktop が Shell を build し直して pid が変わるので、読む前に `bun run dev:list` で引き直す。
- **メニューの項目**（Tab のメニュー、そこから開く picker）: Tab のメニューは、`[data-tab-id]` の button に `clientX`・`clientY` を付けた `contextmenu` を dispatch して開く。項目には `pointerdown` を dispatch してから `click()` する。メニューは window の pointerdown で外側の押下を判定するので、pointerdown を出さない tauri-mcp の click ではその判定を通らない。
- **Tab の drag**（header の Tab を sidebar の Runspace へ）は、Tab の button に `pointerdown`（`button: 0, buttons: 1`）、`document` に 5px を超えて動く `pointermove`（`buttons: 1`）、`[data-runspace-id]` の行に `pointerenter` と `pointerup` を、この順に dispatch する。drag は閾値を越えた pointermove で始まり、行の pointerup で `tab.move` を呼ぶ。
- **端末の link**: 端末は WebGL で描くので、行の DOM は無い。座標を screenshot で読み、`document.elementFromPoint(x, y)` に `metaKey: true` の `mousemove` を送る。xterm は同じ cell への mousemove を無視するので、先に別の cell へ動かしてから狙う。link が付いたかは、見えている `.xterm-screen` の class に `xterm-cursor-pointer` があるかで分かる。⌘-click は、hover の後に `metaKey: true, buttons: 0` の `pointerdown` を送る。
- **画像の drop**: OS の drag は起こせないので、`window.__TAURI__.event.emitTo({ kind: "Webview", label: "main" }, "tauri://drag-drop", { paths, position: { x, y } })` で Tauri の drop と同じ handler を動かす。キーボードの Ctrl+V で貼るのを確かめるときは、`osascript -e 'set the clipboard to (read (POSIX file "<png>") as «class PNGf»)'` で画像を clipboard に置く。
  - clipboard を上書きする前に、全形式を退避して、最後に戻す。`pbpaste` と `pbcopy` は文字しか運ばないので、ユーザーの画像や file が消える。

    ```bash
    cat > $SCRATCH/clipboard.swift <<'EOF'
    import AppKit
    let (mode, path) = (CommandLine.arguments[1], URL(fileURLWithPath: CommandLine.arguments[2]))
    let pasteboard = NSPasteboard.general
    if mode == "save" {
      let items = (pasteboard.pasteboardItems ?? []).map { item in
        Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type.rawValue, $0) } })
      }
      try PropertyListSerialization.data(fromPropertyList: items, format: .binary, options: 0).write(to: path)
    } else {
      let items = try PropertyListSerialization.propertyList(from: Data(contentsOf: path), format: nil) as! [[String: Data]]
      pasteboard.clearContents()
      pasteboard.writeObjects(items.map { types in
        let item = NSPasteboardItem()
        for (type, data) in types { item.setData(data, forType: NSPasteboard.PasteboardType(type)) }
        return item
      })
    }
    EOF
    swift $SCRATCH/clipboard.swift save $SCRATCH/clipboard.plist     # 上書きの前
    swift $SCRATCH/clipboard.swift restore $SCRATCH/clipboard.plist  # 確かめ終えたら
    ```

- **ファイルの paste**: 合成の paste event は OS の clipboard を運ばない。ただ、text の無い paste を受けた Tab は Shell の `clipboard_read_file_paths` で本物の clipboard を読むので、clipboard に file URL を置き（退避と復元は上の「画像の drop」の手順）、`window.__taniaTerminals.get(tabId).textarea` に `new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })` を dispatch すれば Shell から先を確かめられる。Finder のコピーは file reference URL（`file:///.file/id=…`）で来るので、同じ形で置く。

  ```bash
  cat > $SCRATCH/put-files.swift <<'EOF'
  import AppKit
  let urls = CommandLine.arguments.dropFirst().map { NSURL(fileURLWithPath: $0).fileReferenceURL()! as NSURL }
  NSPasteboard.general.clearContents()
  print(NSPasteboard.general.writeObjects(urls))
  EOF
  swift $SCRATCH/put-files.swift <file>...
  ```

  - Tab の claude が受け取ったものは、Agent Session Transcript（`~/.claude/projects/<cwd の / と . を - にした名前>/<session id>.jsonl`）の `[Image: source: …]` で分かる。ファイルの中身ならその path、clipboard の画像なら claude の `images/<n>.png` になる。claude は prompt を送るまで Agent Session Transcript を書かないので、貼った後に短い prompt を送る。Agent Session Transcript が他の Agent Session の分と混ざらないよう、一時 directory に cd してから claude を起こす。
- **clipboard への書き込み**（`navigator.clipboard.writeText`）は、合成のキーイベントでは user activation が無いので `NotAllowedError` で断られる。確かめるのは binding が拾って書きにいくところまでにし、実キーでの確認はユーザーに頼む。
- **Agent Session の状態**（status dot）は、backend-headless の「Agent Session の状態を claude 無しで動かす」の手順で作る。`TANIA_HOME` は desktop の home にする。
- **Task の Bench**（sidebar のラベル、Bench の Tab）は、backend-headless の「Task の Bench を確かめる」の手順で ghq と origin を一時 directory に閉じ込めて作る。`GHQ_ROOT` は `bun run desktop` の env に渡す。
- **starting の Tab**（Create の応答を待つ Terminal Session）は、`bun run dev:list` の PTYD の pid に `kill -STOP` を送ってから Tab を開いて作り、`kill -CONT` で進める。Backend の接続は切れないので、行は starting のまま留まる。Shell の command は webview から横取りできない（`__TAURI_INTERNALS__.invoke` は書き換えられない property）ので、attach したかは画面の文字で見る。
- **一瞬だけ出る表示**（Exit で閉じる Tab の overlay など）は、webview の中で `requestAnimationFrame` ごとに DOM を見て、変わった時刻だけを配列に残す。操作も同じ script の中で起こし、frame の時刻とずれないようにする。
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
  - replay の末尾 256 KB から落ちたモードを確かめるときは、起こし直す前に、Tab の pty へ外から書いて Terminal Session Transcript を押し出す。shell の pid は `terminal-session list` の `pid` にある。

    ```bash
    yes 'filler' | head -c 300000 > /dev/$(ps -o tty= -p <shell の pid> | tr -d ' ')
    ```

  - 末尾に何が残ったかは `$TANIA_HOME/terminal-sessions/<Terminal Session の id>.log` の末尾 256 KB で見る。claude は繋ぎ直した後に自分でも kitty の flag を push し直すので、ptyd が足した分と見分けるには、Terminal Session Transcript の末尾に無い CSI が replay の先頭に流れたかを見る。
- **app の終了**（localStorage の UI 状態のように、終了の手順を通った後に残るものを確かめるとき）は、pid 宛てに AppKit の正規の quit を送る。dev の binary は bundle として登録されていないので、identifier 宛ての `tell application id … to quit` は届かない。

  ```bash
  echo "import AppKit; print(NSRunningApplication(processIdentifier: <DESKTOP の pid>)?.terminate() ?? false)" > $SCRATCH/quit.swift
  swift $SCRATCH/quit.swift
  ```

## 止めて片付ける

止めるのは、手順 3 で自分が起こした desktop だけ。手順 2 で別の session の desktop に繋いだときは、そのまま残してその session に任せる。`dev:kill` は desktop・Backend・端末をまとめて止め、home も消すため。

自分で起こした desktop は、`bun run dev:kill tania-<名前>` で desktop → Backend → ptyd の順に止め、home を消す。desktop が止まると background の job も終わる。

Tab で claude を起こしたなら、claude が cwd ごとに作る `~/.claude/projects/<cwd の / と . を - にした名前>` と、clipboard の画像を保存した directory（Agent Session Transcript の `[Image: source: …]` にある `images/` の 2 つ上）も消す。

片付いたのは、`bun run dev:list` に `tania-<名前>` の行が無いとき。
