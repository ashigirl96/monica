---
name: release-app
description: "`bun run install-app` で入れた release の Monica を動かして確かめる。通知センター・バナー・通知のクリック、`.app` に同梱した Chat の claude と Chrome Extension のように .app の中でしか動かないものを、受け入れ条件として実機で確かめるときに使う。"
---

release の Shell は .app の中でだけ UNUserNotificationCenter を使い、dev は別の経路で通知を出す（`docs/packages/notifications.md`）。そのため、通知センターとバナーとクリックは release でしか確かめられない。release の Monica はユーザーが毎日使っている app なので、入れ替える前に了承を取る。

## 入れる

1. `bun run build` を Bash の `run_in_background` で走らせる。出力は scratchpad の file に向ける。起きている Monica には触れない。
2. ユーザーの了承を得てから `bun run install-app` を走らせる。install-app は Monica を終了させて入れ替えるが、起動はしない（`docs/packages/dev-loop.md` の「release build と install」）。Tab の shell と claude は ptyd が持つので切れない。
3. env を絞った `open` で起こす。`~/.monica/backend.json` の pid が新しくなり、その port の `/health` が答えたら起きている。

   ```bash
   env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TMPDIR="$TMPDIR" \
     PATH=/usr/bin:/bin:/usr/sbin:/sbin open /Applications/Monica.app
   ```

   `open` で起こした `.app` は、`open` を呼んだ process の env を継ぐ。素の `open` では、agent の `CLAUDECODE`・`CLAUDE_CODE_*`・`MONICA_TERMINAL_SESSION_ID` が Shell と Backend に入り、Backend の env をそのまま受ける Job に届く（Chat の claude は env を絞るので届かない。ADR-0033）。ユーザーに Dock から起こしてもらってもよい。

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
- **終了と起動**: `osascript -e 'tell application id "com.ashigirl96.monica" to quit'` で終了させ、「入れる」の 3 の `open` で起こす。Backend だけを起こし直すなら release の `monica-backend` の pid に `kill -TERM` を送る。Shell がすぐ respawn する。
- 通知センターの DB（`~/Library/Group Containers/group.com.apple.usernoted/db2/db`）は読み取り専用で開けるが、書き込みが数分遅れることがある。今の通知の確認には使わない。

## Chat の claude と Chrome Extension

`install-app` は `.app` の `Contents/MacOS/claude` に Chat の claude を、`Contents/Resources/extension` に Chrome Extension を写す（`docs/packages/dev-loop.md` の「release build と install」）。本物の claude に訊くのは、入れ替える前と後で 1 問ずつにし、「1 から 5 を並べて」のような短い質問にする。

### 入れ替える前（agent が行う）

1. `bun run build` の後、`bun run install-app --stage $SCRATCH/stage` で、写しと署名まで済ませた `.app` を `$SCRATCH/stage/Monica.app` に置く。Monica を終了させず、`/Applications` にも触れない。
2. 中身と署名を見る。`A=$SCRATCH/stage/Monica.app`。

   ```bash
   stat -f %z "$A/Contents/MacOS/claude"            # bundledClaude() の file と同じ byte 数
   "$A/Contents/MacOS/claude" --version             # SDK の package.json の claudeCodeVersion
   jq -r .key "$A/Contents/Resources/extension/manifest.json"   # apps/extension/vite.config.ts の release の key
   codesign --verify --deep --strict --verbose=2 "$A"
   codesign -dvv "$A/Contents/MacOS/claude"         # Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)、Identifier=com.anthropic.claude-code
   plutil -p "$A/Contents/_CodeSignature/CodeResources" | grep -A3 '"MacOS/claude"'   # Anthropic の designated requirement
   ```

3. 置いた `.app` の Backend を、`backend-headless` skill の「release の build の Backend」の形で起こす。env は `env -i` で絞り、`MONICA_HOME` は使い捨てにし、`MONICA_PTYD_PATH` と `MONICA_CLAUDE_PATH` は `$A/Contents/MacOS` の `monica-ptyd` と `claude` を指す。ブラウザの口の port は 19380 以外にする（release の Backend が持っている）。`.app` そのものは起こさない。
4. ブラウザの口へ `chat.ask` を 1 回送る。script を `apps/backend/` の下に置くと `@orpc/client` と `@monica/chat/contract` を解決できるので、終わったら消す。答えている間と答えた後に、Backend の子を `ps -A -o pid=,ppid=,command=` で読む。

   ```ts
   const client: ContractRouterClient<{ chat: typeof contract }> = createORPCClient(
     new RPCLink({
       url: `http://127.0.0.1:${port}/rpc`,
       headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' },
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

1. ユーザーの了承を得て、「入れる」の 2 と 3 で入れ替えて起こす。
2. `~/.monica/backend.json` の pid が新しくなり、その port の `/health` が答える。
3. `codesign -dvv /Applications/Monica.app/Contents/MacOS/claude` が Anthropic の署名を出す。
4. 19380 のブラウザの口に `chat.ask` を 1 回送る（side panel から訊ければそれでよい）。答えが返り、答えている間は新しい Backend の子に `/Applications/Monica.app/Contents/MacOS/claude` が居る。

### Brave での読み込みと reload（PR の確認でユーザーが行う）

1. 普段の Brave の `brave://extensions` で「パッケージ化されていない拡張機能を読み込む」を押し、⌘⇧G で `/Applications/Monica.app/Contents/Resources/extension` を選ぶ。ID が `docs/packages/extension.md` の release の ID になる。
2. もう一度 `install-app` を流した後、reload を押す前に Brave が何を出すか（そのまま動くか、エラーか）を見る。reload の後も有効のままで、action で side panel が開く。結果は `docs/packages/extension.md` の「release の読み込み方」に書く。

## 片付ける

テスト用の Runspace を `rpc workbench/runspace/remove '{"id":"…"}'` で消し、`dock` で数が戻ったかを見る。終えたら、`/Applications/Monica.app` が今は作業中の branch の build であることをユーザーに伝える。
