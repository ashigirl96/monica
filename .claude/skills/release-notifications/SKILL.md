---
name: release-notifications
description: "通知センター・バナー・Dock の数・通知のクリックと、`.app` に同梱した Chat の claude と Chrome Extension を、release の Monica で実機で確かめる。.app の中でしか動かないものの受け入れ条件を確かめるときに使う。"
---

release の Shell は .app の中でだけ UNUserNotificationCenter を使い、dev は別の経路で通知を出す（`docs/packages/notifications.md`）。そのため、通知センターとバナーとクリックは release でしか確かめられない。release の Monica はユーザーが毎日使っている app なので、入れ替える前に了承を取る。

## 入れる

ユーザーの了承を得てから、`install-app` skill の手順で入れ直す。

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

## Chat の claude と Chrome Extension

`install-app` は `.app` の `Contents/MacOS/claude` に Chat の claude を、`Contents/Resources/extension` に Chrome Extension を写す（`docs/packages/dev-loop.md` の「release build と install」）。本物の claude に訊くのは、入れ替える前と後で 1 問ずつにし、「1 から 5 を並べて」のような短い質問にする。

### 入れ替える前（agent が行う）

1. `bun run install-app --stage $SCRATCH/stage` で、build と写しと署名まで済ませた `.app` を `$SCRATCH/stage/Monica.app` に置く。Monica を終了させず、`/Applications` にも触れない。
2. 中身と署名を見る。`A=$SCRATCH/stage/Monica.app`。

   ```bash
   stat -f %z "$A/Contents/MacOS/claude"            # bundledClaude() の file と同じ byte 数
   "$A/Contents/MacOS/claude" --version             # SDK の package.json の claudeCodeVersion
   jq -r .key "$A/Contents/Resources/extension/manifest.json"   # apps/extension/vite.config.ts の release の key
   codesign --verify --deep --strict --verbose=2 "$A"
   codesign -dvv "$A/Contents/MacOS/claude"         # Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)、Identifier=com.anthropic.claude-code
   plutil -p "$A/Contents/_CodeSignature/CodeResources" | grep -A3 '"MacOS/claude"'   # Anthropic の designated requirement
   ```

3. 置いた `.app` の Backend を、`backend-headless` skill の「release の build の Backend」の形で起こす。env は `env -i` で絞り、`MONICA_HOME` は使い捨てにし、`MONICA_PTYD_PATH` と `MONICA_CLAUDE_PATH` は `$A/Contents/MacOS` の `monica-ptyd` と `claude` を指す。ブラウザの口の port は渡さなくてよい（Chat は token の口に載る）。`.app` そのものは起こさない。
4. token の口へ、`backend.json` の chat の token で `chat.ask` を 1 回送る（Chrome Extension と同じ呼び方。ADR-0034）。port と chat の token は、置いた `.app` の CLI を host として起こして受け取ってもよい（`docs/packages/cli.md` の「Native Messaging の host」）。script を `apps/backend/` の下に置くと `@orpc/client` と `@monica/chat/contract` を解決できるので、終わったら消す。答えている間と答えた後に、Backend の子を `ps -A -o pid=,ppid=,command=` で読む。

   ```ts
   const { port, chatToken } = await Bun.file(`${process.env.MONICA_HOME}/backend.json`).json()
   const client: ContractRouterClient<{ chat: typeof contract }> = createORPCClient(
     new RPCLink({
       url: `http://127.0.0.1:${port}/rpc`,
       headers: { authorization: `Bearer ${chatToken}` },
     }),
   )
   const answer = await client.chat.ask({
     question: '1 から 5 を並べて',
     page: { content: { kind: 'unreadable', reason: 'restricted' } },
     history: [],
   })
   for await (const event of answer) if (event.type === 'text') process.stdout.write(event.text)
   ```

   答えの text が流れ、答えている間は Backend の子に `$A/Contents/MacOS/claude` が居て、答えた後にその pid が消える。答えた後には次の質問のための spare が別の pid で起きる（`docs/packages/chat.md` の「spare」）。
5. Backend を `backend-headless` skill の「止めて片付ける」で止め、home と `$SCRATCH/stage` を消す。SIGKILL された spare は `~/.claude/sessions/<pid>.json` を残すので、その pid の file も消す。

### 入れ替えた後（PR の確認でユーザーが行う）

1. ユーザーの了承を得て、`install-app` skill で入れ替えて起こす。最後の行が `Started: Backend pid <pid>` になる。
2. `codesign -dvv /Applications/Monica.app/Contents/MacOS/claude` が Anthropic の署名を出す。
3. `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ashigirl96.monica.json` を Shell が書き、`path` が `/Applications/Monica.app/Contents/MacOS/monica`、`allowed_origins` が release の ID だけになっている。
4. 普段の Brave の side panel から 1 問訊く。答えが返り、答えている間は新しい Backend の子に `/Applications/Monica.app/Contents/MacOS/claude` が居る。19380 に別の process を立てても（release の desktop を終了させてから `bun -e 'Bun.serve({ port: 19380, fetch: (r) => (console.log(r.method, r.url), new Response()) })'` を起こし、desktop を起こし直す）、side panel の質問はその process に届かない。

### Brave での読み込みと reload（PR の確認でユーザーが行う）

1. 普段の Brave の `brave://extensions` で「パッケージ化されていない拡張機能を読み込む」を押し、⌘⇧G で `/Applications/Monica.app/Contents/Resources/extension` を選ぶ。ID が `docs/packages/extension.md` の release の ID になる。
2. もう一度 `install-app` を流した後、reload を押す前に Brave が何を出すか（そのまま動くか、エラーか）を見る。reload の後も有効のままで、action で side panel が開く。結果は `docs/packages/extension.md` の「release の読み込み方」に書く。

## 片付ける

テスト用の Runspace を `rpc workbench/runspace/remove '{"id":"…"}'` で消し、`dock` で数が戻ったかを見る。終えたら、`/Applications/Monica.app` が今は作業中の branch の build であることをユーザーに伝える。
