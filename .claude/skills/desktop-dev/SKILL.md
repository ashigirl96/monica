---
name: desktop-dev
description: "dev の desktop を起こし、tauri-mcp で画面を確かめる。受け入れ条件を画面で確かめるとき、一瞬だけ出る表示を捉えるとき、窓の枠（信号機・vibrancy）を撮るときに使う。"
---

dev の desktop は `MONICA_HOME` ごとに identifier と vite の port が分かれ、ほかの home の desktop と並んで動く。同じ home での 2 つ目の起動は、single-instance が既存の窓を前に出して終わる。ユーザーや別の worktree の desktop も同じ machine で動いているので、自分の desktop は home の名前で見分ける。

## 起こす

1. home は `${TMPDIR%/}/monica-<worktree の名前>` に固定する（名前は `basename "$(git rev-parse --show-toplevel)"`）。session ごとに新しい名前を作らない。identifier と vite の port は home から決まり、変わると desktop の crate を build し直すため。ptyd の socket（`$MONICA_HOME/ptyd.sock`）の path は 104 byte が上限なので、超えるときは名前を先頭から収まる長さで切ったものに固定する。
2. `bun run dev:list` で、`monica-<名前>` の行の KIND が `desktop` なら、同じ worktree の別の session が起こしたもの。起こさずに、その行の BRIDGE の port で手順 4 に進む。
3. Bash の `run_in_background` で起こし、出力は scratchpad の file に向ける。終わったら印の行を足し、待つ側が抜けられるようにする。

   ```bash
   MONICA_HOME=${TMPDIR%/}/monica-<名前> bun run desktop > $SCRATCH/desktop.log 2>&1; echo '[desktop exited]' >> $SCRATCH/desktop.log
   ```

4. tauri-mcp の `driver_session` を `start` で繋ぐ。port は log の `MCP Bridge plugin initialized for 'monica-dev' (<identifier>) on 127.0.0.1:<port>` から取る。繋いだら `status` の identifier が `com.ashigirl96.monica.dev.monica-<名前>-` で始まるかを確かめる（名前の英数字と `-` 以外は `-` になる）。bridge は 9223 から空きを選び、driver_session は最後に繋いだ app を既定にするので、別の desktop を触っていることがある。

起動できたのは、log に `MCP Bridge plugin initialized` と `[backend] listening on` が出たとき。待つのは、Bash の `run_in_background` で `until grep -qE '^\[backend\] listening on|^\[desktop exited\]' $SCRATCH/desktop.log; do sleep 0.5; done` を走らせる（前景の `sleep` は harness が止める）。MCP の WebSocket の行も `listening on` を含むので、`[backend]` まで含めて探す。`[desktop exited]` で抜けたら log を読む。

`[desktop exited]` で抜け、log に vite の `Port <port> is already in use` があれば、同じ頃に起こした別の home の desktop と同じ port を選んでいる。手順 3 をやり直すと次の空きを選ぶ。

起動を待つ間（desktop の crate の build）は `bun run check:brief` を流さない。build が CPU を取り、変更と関係の無いテストが 5 秒の timeout で落ちる。

自分の desktop の pid は、`bun run dev:list` の `monica-<名前>` の行の DESKTOP から引く。`pgrep -f target/debug/monica-desktop` はユーザーや別の worktree の desktop にも当たる。

## 確かめる

起こした後の編集は、起こし直さずに届く。webview は vite の HMR で届き、package の `ui` も source のまま読む。Backend は、packages と apps/backend の編集と `bun run generate` で `bun --watch` が同じ pid のまま起こし直し、webview が繋ぎ直す。端末は切れない。

`node_modules` の中身（`bun patch` や依存の入れ直し）を変えたときだけは、`node_modules/.vite` を消して desktop を起こし直す。vite は依存を起動時に束ねて `.vite/deps` から配り、HMR でも reload でも読み直さない。webview に届いたかは、`performance.getEntriesByType('resource')` の `.vite/deps/<依存>.js` を `fetch` して中身を見る。

- **書き込み**は、Terminal Session に直接送る。id は `MONICA_HOME=… bun run monica workbench terminal-session list --format json` の `tabId` から引く。

  ```js
  window.__TAURI__.core.invoke("terminal_write", { sessionId, data: btoa("echo ok\r") })
  ```

  - `webview_keyboard` の `type` は、最初に一致した要素に打つ。隠れた pane の textarea にも当たるので、使うなら先に、見えている pane（祖先に `display: none` が無いもの）の textarea に固有の id を付け、その id を狙う。
  - 合成のキーイベントは keydown だけを送る。keypress も送ると、xterm が両方を拾って文字が二重になる。
  - 修飾キーの打鍵（Ctrl+V、Shift+Enter など）は、`window.__monicaTerminals.get(tabId).textarea` に keydown を dispatch する。monica の key handler と xterm の encode を本物の打鍵と同じ順に通るので、Tab の app に同じバイト列が届く。`keyCode` は `Object.defineProperty` で足す（xterm は Ctrl+文字を `keyCode` から作る）。

    ```js
    const ev = new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { get: () => 86 });
    window.__monicaTerminals.get(tabId).textarea.dispatchEvent(ev);
    ```

  - xterm が Tab に送ったバイト列は、`window.__monicaTerminals.get(tabId).onData` を購読して読む。合成のキーでは paste や copy のようなブラウザの既定の動作は起きないので、起きるかどうかは dispatch した event の `defaultPrevented` で見る（xterm が encode したキーは cancel される）。key の encode を変えたときは、⌘C・⌘V・⌘A でもこの 2 つを見る。
  - shell の Tab に Ctrl+V（`\x16`）を送ると、zsh は次の 1 文字を quoted-insert でそのまま入れる。続けて command を送る前に、別のキーを 1 つ送って抜ける。

- **画面の文字**は、dev の webview が晒す `window.__monicaTerminals`（tabId → xterm の `Terminal`）の buffer から読む。cursor の行までの末尾 10 行:

  ```js
  (() => { const b = window.__monicaTerminals.get(tabId).buffer.active; const end = b.baseY + b.cursorY; return Array.from({ length: 10 }, (_, i) => b.getLine(end - 9 + i)?.translateToString(true)); })()
  ```

- **Tab の env**は、上の「書き込み」で `env > $MONICA_HOME/tab-env.txt` を Tab に送り、その file を読む。macOS の `ps eww` は Tab の shell の env を出さない。
- **Tab の切り替え**は、`[data-tab-id]` の button に `pointerdown` と `pointerup` を `dispatchEvent` する。Tab は pointerdown で切り替わるが、tauri-mcp の click は pointerdown を出さない。
- **Tab を開く・閉じる**: 開くのは、CLI に出ていないので `button[title^="New tab"]` の `click()`。webview の Close Tab は、前面の Tab の textarea に上の「書き込み」の手順で Ctrl+T（`keyCode` 84）と `d`（68）の keydown を送る Jump Mode の d。CLI の経路は `monica workbench tab close <id>`。
- **窓の前面と背面**（未読のように窓の focus で変わる振る舞い）は、`osascript -e 'tell application "Finder" to activate'` で別の app を前に出して背面にし、tauri-mcp の `manage_window` の `focus` で前面に戻す。最小化（`manage_window` の `minimize`）では webview の JS が止まりうるので、focus の event が届いて背面と扱えたのかを見分けられない。
  - 最小化した窓は `focus` だけでは戻らず、`document.visibilityState` が `hidden` のまま残る。`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is <DESKTOP の pid>) to true'` で前に出してから `focus` する。前面に来たかは webview の `document.hasFocus()` で確かめる。
- **Dock の数**（icon の badge）は webview の外なので screenshot に写らない。`lsappinfo info -only StatusLabel "$(lsappinfo find pid=<DESKTOP の pid>)"` で読む。数があれば `{ "label"="3" }`、無ければ `[ NULL ]` か `kCFNULL` になる。Backend の落ちと respawn のように一瞬で変わるものは、50ms おきに読んで変わった時刻だけを残す。Rust の file を直すと dev の desktop が Shell を build し直して pid が変わるので、読む前に `bun run dev:list` で引き直す。
- **メニューの項目**（Tab のメニュー、そこから開く picker）: Tab のメニューは、`[data-tab-id]` の button に `clientX`・`clientY` を付けた `contextmenu` を dispatch して開く。項目には `pointerdown` を dispatch してから `click()` する。メニューは window の pointerdown で外側の押下を判定するので、pointerdown を出さない tauri-mcp の click ではその判定を通らない。
- **Tab を開く**は、window に Ctrl+T の keydown（`{ key: 't', code: 'KeyT', ctrlKey: true }`）を dispatch して jump mode に入り、続けて `{ key: 'c', code: 'KeyC' }` を dispatch する。active な Runspace の active な Tab の隣に開く。Tab を開く procedure は CLI に出ていない。
- **Repo の Tile**は、window に ⌥P の keydown（`{ key: 'π', code: 'KeyP', altKey: true }`）を dispatch して Runspace を作り、その Tab に上の「書き込み」で `cd <ghq の checkout>\r` を送って作る。Runspace を作る procedure は CLI に出ていない。
- **Tile の drag**（Rail の Repo の Tile を並べ替える）は、Tile の button（`[data-reorder-id]`）に `pointerdown`（`button: 0, buttons: 1, clientX, clientY`）、`document` に 5px を超えて動く `pointermove`（`buttons: 1`）を落とし先の Tile の上の座標で、最後に `document` に `pointerup` を、この順に dispatch する。落とし先は pointermove の座標で決まる。写しと線は drag の間だけ `document.body` に出るので、screenshot は pointerup の前に撮る。
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

- **ファイルの paste**: 合成の paste event は OS の clipboard を運ばない。ただ、text の無い paste を受けた Tab は Shell の `clipboard_read_file_paths` で本物の clipboard を読むので、clipboard に file URL を置き（退避と復元は上の「画像の drop」の手順）、`window.__monicaTerminals.get(tabId).textarea` に `new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })` を dispatch すれば Shell から先を確かめられる。Finder のコピーは file reference URL（`file:///.file/id=…`）で来るので、同じ形で置く。

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
- **Agent Session の状態**（status dot）は、backend-headless の「Agent Session の状態を claude 無しで動かす」の手順で作る。`MONICA_HOME` は desktop の home にする。
- **Task の Bench**（sidebar のラベル、Bench の Tab）は、backend-headless の「Task の Bench を確かめる」の手順で ghq と origin を一時 directory に閉じ込めて作る。`GHQ_ROOT` は `bun run desktop` の env に渡す。
- **starting の Tab**（Create の応答を待つ Terminal Session）は、`bun run dev:list` の PTYD の pid に `kill -STOP` を送ってから Tab を開いて作り、`kill -CONT` で進める。Backend の接続は切れないので、行は starting のまま留まる。Shell の command は webview から横取りできない（`__TAURI_INTERNALS__.invoke` は書き換えられない property）ので、attach したかは画面の文字で見る。
- **一瞬だけ出る表示**（Tab を閉じた直後の画面など）は、webview の中で `requestAnimationFrame` ごとに DOM を見て、変わった時刻だけを配列に残す。操作も同じ script の中で起こし、frame の時刻とずれないようにする。
- **長い script**: `webview_execute_js` は約 5 秒で timeout し、`timeout` を大きく渡しても延びない。async の処理は裏で走り続ける。数秒を超えるものは await せずに走らせ、結果は `window.__…` に貯めて、後の呼び出しで読む。timeout した後に同じ script を走らせると、2 本が重なる。
- **窓の枠と端末の字形**: `webview_screenshot` には信号機も vibrancy も、WebGL で描く端末の文字も写らない。自分の desktop の pid が持つ窓の CGWindowID を取って `screencapture` で撮る。背面の窓は描き直されず古い絵が写るので、撮る前に `manage_window` の `focus` で前に出す。

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

  - 末尾に何が残ったかは `$MONICA_HOME/terminal-sessions/<Terminal Session の id>.log` の末尾 256 KB で見る。claude は繋ぎ直した後に自分でも kitty の flag を push し直すので、ptyd が足した分と見分けるには、Terminal Session Transcript の末尾に無い CSI が replay の先頭に流れたかを見る。
- **app の終了**（localStorage の UI 状態のように、終了の手順を通った後に残るものを確かめるとき）は、pid 宛てに AppKit の正規の quit を送る。dev の binary は bundle として登録されていないので、identifier 宛ての `tell application id … to quit` は届かない。

  ```bash
  echo "import AppKit; print(NSRunningApplication(processIdentifier: <DESKTOP の pid>)?.terminate() ?? false)" > $SCRATCH/quit.swift
  swift $SCRATCH/quit.swift
  ```

## Remote 登録を隔離 home で確かめる

1. 上の手順で自分の dev desktop を起こし、Workbench 右上の **Remote access** を開く。初回の表示が「無効」であることを確かめる。ユーザーの `~/.monica` は試験に使わない。
2. Mac の Tailscale address と専用 TLS port（既定 19443）を入力して有効化する。「TLS 接続を受付中」と接続先、identity の SHA-256、有効期限が出たら bind できている。「Remote を開始できません」なら address、port の競合、`<home>/remote` の所有者と権限を確認する。local の Tab はそのまま操作できることを確かめる。
3. tailnet 管理者に、指定 iPhone から指定 Mac のこの port だけを許す grants と、重なる広い許可を確認してもらう。試験のために policy を書き換えない。Serve、Funnel、ルーター公開は使わない。
4. **5 分間の招待 QR を作成** を押す。QR を自分の端末だけに読み取らせる。QR、招待、端末 secret を screenshot、URL、ログへ保存しない。申請の端末名と TCP source を Tailscale の iPhone と照合して **承認** または **拒否** を押す。申請は同時に 1 件で、招待も申請も 5 分で失効する。
5. 登録済み端末の **失効** を押す。接続確認の WSS が閉じ、同じ資格の新規 HTTPS 接続確認が拒否されることを確かめる。**無効化** でも接続が閉じる。これは Tab を閉じる操作ではない。iPhone の一覧購読も閉じ、利用可能な一覧が消えることを確認する。一覧と選んだ既存 Terminal Session の出力を閲覧できる。入力は同じ Mac renderer が利用可能な間だけ許可する。解除 ACK が届かなければ「拒否済み・解除待ち」であり、完了と扱わない。
6. identity の期限切れや Mac の address 変更時は **Identity の更新と再登録** から全端末を失効して identity を破棄する。有効化すると新しい identity になる。新しい QR で明示的に再登録する。port 変更時も grants と端末の登録先を更新する。証明書検証を無効化して繋ぎ直さない。
7. iPhone で Mac と別の Tab を選び、Mac の選択と未読が変わらず、空一覧から Runspace が自動作成されないことを確かめる。Mac で Tab を開く・閉じると iPhone の一覧が変わる。iOS 導入は `.claude/skills/ios-dev/SKILL.md` に従う。
8. 同じ home で Backend を起こし直す。登録済み端末と identity は残り、未消費の招待と未承認申請は消える。desktop の入力が続くことも確かめる。最後に remote を無効化してから、下の手順で自分の desktop と home を片付ける。

### 端末の閲覧と表示解除

1. Mac で継続出力する作業を開き、iPhone で同じ Tab を選ぶ。保持された末尾の後に live 出力が出ることと、履歴・TUI 復元の制限表示を確認する。Mac の選択、focus、未読は変わらない。iPhone の xterm 自動応答から Write は出ない。基本入力欄から送った文字と改行だけが同じ PTY に届く。
2. Mac の窓を resize する。iPhone は Mac が適用した rows/cols に追従する。iPhone の回転と表示領域の変更では PTY サイズが変わらない。Shell は通知への登録後に attach し、resize 通知の送信成功ではなく非同期 List の read-back を確認する。
3. iPhone の「一覧へ戻る · 表示解除」、別 Tab の選択、背景移行を順に試す。専用 ptyd 接続だけが減り、Mac の出力と入力、PTY の running とサイズが残ることを確認する。表示解除は Close Tab ではない。`lsof -U -a -p <Shell の pid>` で専用接続の増減を比べ、共有 desktop 接続まで消えていないことを見る。
4. 閲覧中に Backend を終了し、Shell が専用接続を片付けても desktop の入力が続くことを確認する。iPhone は購読 ACK 後に一覧を取り直し、同じ Tab と Terminal Session の場合だけ新しい専用接続へ復帰する。置換後は一覧から選び直す。既存 desktop の attach 失敗を lost として自動再接続しない規則は変えない。失効・無効化は先に認可を拒否し、Shell の socket shutdown と reader 終了の ACK が確認できたときだけ完了になる。
5. 自動境界試験は `bun test packages/workbench/src/remote-access.test.ts` と `cargo test -p monica-ptyd --test daemon`。前者は既存 fake ptyd と実 Rust relay、隔離 TLS/WSS、実 Ledger を使う。後者は実 ptyd の EOF と desktop 継続を見る。実機・desktop 画面の確認をこれだけで済ませない。

### hidden Tab の入力と Mac renderer

1. 隔離 HOME・ZDOTDIR・MONICA_HOME を指定して起こす。既存 tool cache が必要なら CARGO_HOME・RUSTUP_HOME だけを別途明示する。Mac で一度も選択していない Tab を iPhone から選ぶ。既存の `window.__monicaTerminals.get(tabId)` が非表示 DOM へ open され、同じ instance のまま ready になることを確かめる。Mac の選択、focus、未読、PTY grid は変わらず、WebGL の取得と fit は前面 Tab だけに残る。
2. 共有入力欄の「送信（改行）」で短い command を送る。両画面の同じ Terminal Session に結果が出ることを確認する。「受理」は中継の受理であり command の成功ではない。表示解除後も Mac の renderer と入力は残る。正常な local 接続の Attach を増やさない。
3. hidden open 前に出した DA・DSR・OSC 10/11・kitty query は replay から再回答されない。open 後の新しい query は Mac から一度だけ応答される。過去の未回答 query を待つ TUI が回復する保証はない。
4. renderer を reload・破棄した旧世代、Terminal Session の置換前の ready では入力できないことを確認する。heartbeat は2秒。6秒の不応答または未解析出力の滞留で remote だけを入力不可にする。desktop 自身の入力・自動応答にこの判定を流用しない。
5. 失効と入力を競合させる。Backend は認可・Tab/session 検証から private socket への送信まで await を挟まず受理し、失効は新しい受理を先に拒否する。失効前に受理した入力は失効開始後に届き得る。解除完了は専用接続と reader の終了 ACK 後だけ。ACK を失えば送達不明・解除待ちを維持し、再送しない。
6. `bun test packages/workbench/src/remote-access.test.ts packages/workbench/src/ui/terminal-connections.test.ts` と `cargo test -p monica-ptyd --test remote` は世代、失効、入力 ACK 喪失、細かい echo burst、Exit/Reap を見る。出力 queue は隣接 Output を最大8個の45KiB chunkへまとめ、満杯なら remote だけを切る。実 Mac WKWebView の focus・非表示 open と query 応答は実行中の隔離 desktop でも確認する。

iPhone の IME・補助キー・text paste・長押し選択・コピー・TUIスクロール・倍率・accessibility の確認は `.claude/skills/ios-dev/SKILL.md` に従う。desktop の file paste や clipboard と混同せず、phone の回転と keyboard 開閉で Mac の grid と focus が変わらないことを見る。

### Backend 再起動と phone の復帰

1. 自分の隔離 home の `backend.json` の PID を読み、他の app の Backend でないことを確認する。その PID だけを一時停止して、Mac xterm のユーザー入力と新しい DSR 等への自動応答が続くことを見る。停止試験は finally で継続、またはその同じ PID を終了し、停止した process を残さない。
2. その Backend を終了して Shell に再起動させる。`backend.json` の新 PID、同じ Tab/session ID と PTY PID、desktop の選択・focus・grid を照合する。remote だけが切れ、再認証・購読 ACK・一覧・fresh attach を経て戻る。stdin EOF と private socket EOF は自動試験でも確認する。phone から Backend の起動命令は送らない。
3. iPhone を背景・foreground へ繰り返し移し、`lsof -U -a -p <Shell の pid>` と relay 試験で専用 socket の増減を見る。古い listener と接続が積み上がらないことを確認する。送達不明の入力は replay 後も送達不明で、自動再送されない。Tab 置換・削除・lost・終了と失効の確認は ios-dev の復帰手順に従う。

Shell は Backend の起動ごとに同 UID 専用の 0700 directory と 0600 Unix socket、起動ごとの secret を用意する。socket path と secret は Backend の環境だけへ渡し、PTY へは継承しない。資格を調べるために process の全環境をログへ出さない。

端末を承認すると Mac ユーザーの shell 権限を与える。API の限定は shell コマンドの sandbox ではない。既に実行したコマンドは失効しても取り消せない。

## 止めて片付ける

止めるのは、手順 3 で自分が起こした desktop だけ。手順 2 で別の session の desktop に繋いだときは、そのまま残してその session に任せる。`dev:kill` は desktop・Backend・端末をまとめて止め、home も消すため。

自分で起こした desktop は、`bun run dev:kill monica-<名前>` で desktop → Backend → ptyd の順に止め、home を消す。desktop が止まると background の job も終わる。

Tab で claude を起こしたなら、claude が cwd ごとに作る `~/.claude/projects/<cwd の / と . を - にした名前>` と、clipboard の画像を保存した directory（Agent Session Transcript の `[Image: source: …]` にある `images/` の 2 つ上）も消す。

片付いたのは、`bun run dev:list` に `monica-<名前>` の行が無いとき。
