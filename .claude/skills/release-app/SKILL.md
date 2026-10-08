---
name: release-app
description: "`bun run install-app` で入れた release の Monica を動かして確かめる。通知センター・バナー・通知のクリックのように .app の中でしか動かないものを、受け入れ条件として実機で確かめるときに使う。"
---

release の Shell は .app の中でだけ UNUserNotificationCenter を使い、dev は別の経路で通知を出す（`docs/packages/notifications.md`）。そのため、通知センターとバナーとクリックは release でしか確かめられない。release の Monica はユーザーが毎日使っている app なので、入れ替える前に了承を取る。

## 入れる

1. `bun run build` を Bash の `run_in_background` で走らせる。出力は scratchpad の file に向ける。起きている Monica には触れない。
2. ユーザーの了承を得てから `bun run install-app` を走らせる。install-app は Monica を終了させて入れ替えるが、起動はしない（`docs/packages/dev-loop.md` の「release build と install」）。Tab の shell と claude は ptyd が持つので切れない。
3. `open /Applications/Monica.app` で起こす。`~/.monica/backend.json` の pid が新しくなり、その port の `/health` が答えたら起きている。

Monica が終了している間、Monica の Tab で会話を読んでいるユーザーには返事が見えない。終了と起動はひと続きで行い、その間に質問しない。

## 待ちを作る

claude の代わりに hook の CLI で待ちを作る。scratchpad に次の関数を置き、`source` して使う。

```bash
export MONICA_HOME="$HOME/.monica"
rpc() {  # rpc workbench/runspace/create '{"cwd":"…","rows":24,"cols":80}'
  local port token
  port=$(bun -e 'console.log((await Bun.file(process.env.MONICA_HOME + "/backend.json").json()).port)')
  token=$(bun -e 'console.log((await Bun.file(process.env.MONICA_HOME + "/backend.json").json()).token)')
  curl -s -X POST "http://127.0.0.1:$port/rpc/$1" -H "authorization: Bearer $token" \
    -H 'content-type: application/json' -d "{\"json\": ${2:-{\}}}"
}
hook() {  # hook <terminalSessionId> <sessionId> <cwd> <event> [,"tool_name":"Bash",…]
  printf '{"session_id":"%s","transcript_path":"/tmp/%s.jsonl","cwd":"%s","hook_event_name":"%s"%s}' "$2" "$2" "$3" "$4" "$5" |
    MONICA_TERMINAL_SESSION_ID=$1 "$HOME/.local/bin/monica" workbench hook claude
}
dock() {
  lsappinfo info -only StatusLabel "$(lsappinfo find pid=$(pgrep -f '^/Applications/Monica.app/Contents/MacOS/monica-desktop'))"
}
```

- テスト用の Runspace は `rpc workbench/runspace/create` で、scratchpad の下の `tab-a`・`tab-b` のように cwd を分けて開く。通知の title は Agent Session の cwd の末尾 2 つなので、通知センターで見分けられる。外から開いた Runspace を webview は自動では選ばない。
- 手空きは `Stop`、許可は `PermissionRequest`（`tool_name` と `tool_input` が要る）、待ちを解くのは `UserPromptSubmit`（`prompt` が要る）、claude の終了は `SessionEnd`（`reason`）。payload の field は `docs/research/hook-payloads.md`。
- 終了した Agent Session の session id に `Stop` を送っても、遷移せずに捨てられる。作り直すときは新しい session id を使う。Runspace が閉じられた Terminal Session の hook も捨てられる。
- 未読と、いつ見たかは `rpc workbench/agentSession/list` の `unread`・`notifiedAt`・`seenAt` で読む。

## ユーザーに見てもらう

- 通知センターの見え方はユーザーに見てもらう。文章で尋ね、文章か screenshot で答えてもらう。
- monica の窓が前面のときに Tab を表示すると、その Agent Session は既読になり、通知も取り下がる。確かめてもらうのは通知センターだけにし、テスト用の Runspace は開かないよう先に伝える。通知を押す手順の後は、次の手順の前に会話の Tab へ戻ってもらう。
- 返事を受けたら `seenAt` を読み、思わぬ既読で場面が崩れていないかを確かめてから次へ進む。

## 自分で見られるもの

- **Dock の数**: `dock`。数があれば `{ "label"="3" }`、無ければ `kCFNULL` か `[ NULL ]`。
- **バナー**: `osascript -e 'tell application "Finder" to activate'` で monica を背面にしてから待ちを作り、`screencapture -x` で撮る。`sips -c 260 520 --cropOffset 0 <幅-520> <png> --out <切り抜き>` で右上を切り抜いて読む。同じ時に出ている別の app のバナーを、時間切れで消えたのではないことの比べる相手にする。
- **終了と起動**: `osascript -e 'tell application id "com.ashigirl96.monica" to quit'` で終了させ、`open` で起こす。Backend だけを起こし直すなら release の `monica-backend` の pid に `kill -TERM` を送る。Shell がすぐ respawn する。
- 通知センターの DB（`~/Library/Group Containers/group.com.apple.usernoted/db2/db`）は読み取り専用で開けるが、書き込みが数分遅れることがある。今の通知の確認には使わない。

## 片付ける

テスト用の Runspace を `rpc workbench/runspace/remove '{"id":"…"}'` で消し、`dock` で数が戻ったかを見る。終えたら、`/Applications/Monica.app` が今は作業中の branch の build であることをユーザーに伝える。
