---
name: backend-headless
description: "desktop 無しで Backend と monica-ptyd を起こし、CLI と RPC で振る舞いを確かめる。受け入れ条件を手で確かめるとき、Backend の起動・終了・ptyd との再接続を実機で見るとき、Tab で claude を動かして Agent Session を見るとき、Task の Bench（run・close）を確かめるとき、Job が予定の時刻に走るのを確かめるとき、notes の画面をブラウザで確かめるときに使う。"
---

Backend を本物の ptyd に繋いで起こす。Shell の役（親として生き続け、stdin の pipe の書き側を握る）は Bash の background job が演じる。

## 起こす

1. `cargo build -p monica-ptyd`
2. home は `${TMPDIR%/}/monica-s2` のように、`$TMPDIR` の下に短い名前で作る。名前は作業ごとに変える（issue 番号を入れるなど）。並行する他の agent も同じ手順で Backend を起こしている。ptyd の socket（`$MONICA_HOME/ptyd.sock`）の path が 104 byte を超えると bind できず、client には ENOENT にしか見えない。
3. Bash の `run_in_background` で、stdin を無名 pipe で握って起こす。出力は scratchpad の file に向ける。

   ```bash
   sleep 100002 | MONICA_HOME=${TMPDIR%/}/monica-s2 MONICA_PTYD_PATH=target/debug/monica-ptyd \
     bun apps/backend/src/main.ts > $SCRATCH/out.jsonl 2> $SCRATCH/err.log
   ```

   - sleep の秒数は home ごとに固有の値にする（`monica-s2` なら `100002`）。止めるときにこの秒数で自分の sleep だけを探す。他の agent と同じ秒数だと、互いの sleep を kill し、相手の Backend が stdin の EOF で黙って抜ける。
   - 親は background job のまま生かす。`( … &)` で切り離すと親がすぐ死に、Backend は ppid=1 の見張りで約 1 秒後に黙って抜ける。
   - stdin は無名 pipe にする。Bun は fifo の EOF を拾わないので、fifo では stdin の EOF で抜ける振る舞いを確かめられない。
   - `.app` でだけ起きること（gh や ghq が見つからないなど）を確かめるときは、`env -i HOME=$HOME USER=$USER SHELL=/bin/zsh LANG=$LANG TMPDIR=$TMPDIR PATH=/usr/bin:/bin:/usr/sbin:/sbin` を前に付け、bun を絶対 path（`~/.bun/bin/bun`）で起こす。PATH が launchd の渡すものと同じになり、Backend が login shell から取った PATH が効いているかを見られる。
   - release の build の Backend（同梱した SPA や migrations）を確かめるときは、`bun run build` の後に `target/release/bundle/macos/Monica.app/Contents/MacOS/` の `monica-backend` を bun の代わりに起こし、同じ directory の `monica-ptyd` を `MONICA_PTYD_PATH` に渡す。`.app` そのものは起こさない。identifier が release と同じなので、single-instance が手元の release の窓に回すか、release が居なければ `~/.monica` で Backend を起こす。
   - monica の Tab・Claude Code の中（`env | grep -E '^(MONICA_|CLAUDECODE)'` が出る）から起こすときは、`env -i HOME="$HOME" USER="$USER" SHELL=/bin/zsh TERM=xterm-256color LANG="$LANG" TMPDIR="$TMPDIR" PATH="$(printf %s "$PATH" | tr : '\n' | grep -v -E '\.monica' | paste -sd: -)"` を前に付ける。PATH は `Application Support` のように空白を含む dir を持つことがあるので、引用を外すと `env` が残りを command と読んで落ちる。ptyd は Backend の env から `MONICA_*` と Claude Code の env を落として tab に渡す。ユーザーの Job は Backend の env をそのまま受けるので、外側の `MONICA_TERMINAL_SESSION_ID` や `CLAUDECODE` も Job に届く。

4. tab の claude の hook を確かめるなら、起動した後に `ln -s $PWD/scripts/monica-dev ${TMPDIR%/}/monica-s2/bin/monica` を張る。hook の settings の command はこの path を指し、desktop では Shell が張る。

起動できたのは、`out.jsonl` に `{"type":"endpoint",…}` の行が出て、`$MONICA_HOME/backend.json` ができたとき。待つのは、Bash の `run_in_background` で `for i in $(seq 60); do [ -f ${TMPDIR%/}/monica-s2/backend.json ] && break; sleep 0.5; done` を走らせる（前景の `sleep` は harness が止める）。Backend の生死は自分の home の `backend.json` で見る。`pgrep -f apps/backend/src/main.ts` は他の agent の Backend にも当たる。30 秒たっても `backend.json` が無いか、Backend の background job が終わったと知らされたら、Backend は落ちているので `err.log` を読む。

## 確かめる

- CLI: `MONICA_HOME=${TMPDIR%/}/monica-s2 bun run monica <command> [--format json]`。exit code は 0 = 成功、1 = それ以外の失敗、2 = Backend 不在。
- RPC: CLI に出さない procedure は、CLI の `connect()` で作った client から呼ぶ。path は package 名から始まる。

  ```bash
  MONICA_HOME=${TMPDIR%/}/monica-s2 bun -e '
  const { connect } = await import(`${process.cwd()}/apps/cli/src/backend.ts`);
  const client = connect(process.env.MONICA_HOME);
  console.log(JSON.stringify(await client.workbench.layout.get()));'
  ```

- Tab への打ち込みと画面: Tab は RPC の `workbench.runspace.create` で開き、`tab.terminalSessionId` に ptyd の socket で `write`（data は base64）を送る。画面は `attach`（`replay_bytes` で末尾を指定）の応答の `replay` を base64 で解き、escape sequence を除いて読み、`detach` する。Enter は `\r`、Shift+Tab は `\x1b[Z`。claude の状態の移り変わりは、`agentSession.list` を 200ms ごとに読んで、変わったときだけ出すと取りこぼさない。

  ```bash
  MONICA_HOME=${TMPDIR%/}/monica-s2 bun -e '
  const [id, text] = ["ts-…", "claude --model haiku\r"];
  const socket = await Bun.connect({
    unix: `${process.env.MONICA_HOME}/ptyd.sock`,
    socket: { data: (_, chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const m = JSON.parse(line);
        if (m.body === "attached") console.log(Buffer.from(m.replay, "base64").toString().replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").slice(-2000));
      }
    } },
  });
  const send = (op) => socket.write(`${JSON.stringify(op)}\n`);
  send({ id: 1, op: "hello", version: 1 });
  send({ op: "write", session_id: id, data: Buffer.from(text).toString("base64") });
  await Bun.sleep(5000);
  send({ id: 2, op: "attach", session_id: id, replay_bytes: 4000 });
  await Bun.sleep(300);
  send({ op: "detach", session_id: id });
  socket.end();'
  ```

- Tab で本物の claude を起こすとき:
  - 初めての directory（`GHQ_ROOT` の下の clone や worktree）では、claude が「Yes, I trust this folder」の確認で止まり、SessionStart の hook が届かない。既定の選択は「No, exit」なので、`\x1b[B` を送ってから `\r` を送って Yes を選ぶ。
  - resume を確かめるときは、prompt を 1 つ送って答えを待ってから抜ける。claude は最初の prompt まで Agent Session Transcript を書かないので、prompt を送らずに抜けた Agent Session の `--resume` は `No conversation found` で終わる。
- Agent Session の状態（dot、通知）を claude 無しで動かすには、hook の payload を CLI の hook に流す。claude と同じ経路で `recordHook` に届き、待ちの状態や理由を狙って作れる。payload の field と場面ごとの順は `docs/research/hook-payloads.md`。field の欠けた payload（`tool_name` の無い PermissionRequest など）は記録されず、Backend の stderr に `ignored a hook it cannot read` が出る。Terminal Session は Workbench Ledger で live なもの（`runspace.create` で開いた Tab の `terminalSessionId`）を使う。それ以外は記録されない。通知は Backend の stdout（`out.jsonl`）に `{"type":"notify",…}` の行で出る。

  ```bash
  printf '%s' '{"session_id":"s-1","transcript_path":"/tmp/t.jsonl","cwd":"/Users/me/src/monica","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}' |
    MONICA_HOME=${TMPDIR%/}/monica-s2 MONICA_TERMINAL_SESSION_ID=ts-… scripts/monica-dev workbench hook claude
  ```

- HTTP: `/health` は token 無しで返る。port と token は `backend.json` にある。procedure は `POST /rpc/<domain>/<path>`（`/rpc/workbench/runspace/create` など）に `Authorization: Bearer <token>` と `{"json": <input>}` の body を送って呼び、応答の `json` が output になる。CLI に出ていない procedure（`tab.open`・`tab.pin`・`tab.close` など）もこれで呼べる。
- ptyd にだけある session を作るには、Backend を止めてから socket に直接 `hello` と `create` を送る。ptyd は Backend が止まっても残る。Backend を起こし直すと reconcile がその session を terminate し、Exit を受けて Reap するので、ptyd の `list` から消え、`create` の応答の pid の shell も終わる（ADR-0023）。protocol は `crates/terminal-protocol/src/lib.rs`。

  ```bash
  MONICA_HOME=${TMPDIR%/}/monica-s2 bun -e '
  const socket = await Bun.connect({
    unix: `${process.env.MONICA_HOME}/ptyd.sock`,
    socket: { data: (_, chunk) => console.log(chunk.toString().trim()) },
  });
  socket.write(`${JSON.stringify({ id: 1, op: "hello", version: 1 })}\n`);
  socket.write(`${JSON.stringify({ id: 2, op: "create", session_id: "ts-manual", cwd: process.env.HOME, shell: "/bin/zsh", rows: 24, cols: 80, env: null })}\n`);
  await Bun.sleep(300);
  socket.end();'
  ```

- DB は Backend が `locking_mode=EXCLUSIVE` で握っている。`sqlite3` で読むのは Backend を止めた後。
- process を `pgrep -f` / `pkill -f` で探すときは、pattern を `^` で始め、探す process の command 行の先頭に当てる。harness は command を zsh で包み、その中で `( … ) &` で起こした subshell も command の全文を command 行に持つので、pattern が command の文字列に含まれると自分に当たる。

## Task の Bench を確かめる

`run` と `close` は、checkout に branch と worktree を作り、消す。ユーザーの checkout に触れないよう、ghq と origin を一時 directory に閉じ込める。

1. 起こすときに `GHQ_ROOT=${TMPDIR%/}/monica-s2-ghq` を Backend の env に足す（`env -i` で起こすときも）。ghq は `GHQ_ROOT` を `ghq root` の答えにする。渡し忘れると、ユーザーの本物の checkout で worktree を作る。
2. Task を 1 つ `run --in-place` する。`ghq get` が GitHub から `monica-s2-ghq` の下に checkout を clone する。
3. その checkout から一時の origin を作る。`.monica/setup.sh` を commit した main を push し、checkout の `origin` をそこへ向ける。以後の worktree の Bench は、この main から作られる。setup の振る舞いは script が読む mode file で切り替えるので、commit し直さずに成功・失敗・長い setup を作れる。

   ```bash
   T=${TMPDIR%/}; C=$T/monica-s2-ghq/github.com/<owner>/<repo>; O=$T/monica-s2-origin/repo.git; W=$T/monica-s2-origin/work
   git clone --bare --quiet $C $O && git clone --quiet $O $W && mkdir -p $W/.monica
   printf '#!/bin/sh\ncase "$(cat %s)" in fail) exit 1 ;; slow) sleep 30 ;; *) sleep 3 ;; esac\n' $T/monica-s2-mode > $W/.monica/setup.sh
   chmod +x $W/.monica/setup.sh && echo ok > $T/monica-s2-mode
   git -C $W add .monica && git -C $W -c user.name=t -c user.email=t@e commit -qm setup && git -C $W push -q origin HEAD:main
   git -C $C remote set-url origin $O
   ```

4. 片付けでは、home と一緒に `monica-s2-ghq`・`monica-s2-origin`・`monica-s2-mode` も消す。

## Job を確かめる

- cron 式は分の単位で、tick は 30 秒おきなので、2 分先の式で登録する。`T=$(date -v+2M '+%M %H')` から `"$((10#${T% *})) $((10#${T#* })) * * *"` を作り、`monica job add <name> --schedule … --command … --cwd <絶対 path>` に渡す。予定の分から 30 秒以内に走る。
- 走ったのは `$MONICA_HOME/logs/jobs/<name>/` ができたとき。待つのは、Bash の `run_in_background` で `until [ -d ${TMPDIR%/}/monica-s2/logs/jobs/<name> ]; do sleep 1; done` を走らせる。結果は `monica job show <name>` の RESULT・EXIT・LOG で見る。

## notes の画面をブラウザで確かめる

画面は `apps/web` の Vite が配り、`/rpc` と `/api/assets` を同じ home の Backend のブラウザの口へ proxy する。`bun run` の Backend のブラウザの口は SPA を配らないので、開くのは Vite の URL。

1. home を作ってから、ブラウザの口と Vite の port を引く。`devInstance` は home の realpath から port を決めるので、home が無いうちに引くと `$TMPDIR` の `/var` と `/private/var` の違いで Vite と別の port になる。

   ```bash
   mkdir -p ${TMPDIR%/}/monica-s2
   MONICA_HOME=${TMPDIR%/}/monica-s2 bun -e '
   const { devInstance } = await import(`${process.cwd()}/scripts/dev-instance.ts`);
   const { browserPort, webPort } = devInstance(process.env.MONICA_HOME);
   console.log(browserPort, webPort);'
   ```

2. 「起こす」の 3 の command に `MONICA_BROWSER_PORT=<ブラウザの口の port>` を足して Backend を起こす。port が埋まっていると、`err.log` に `[backend] no browser listener on port …` が出て、口なしで起きる。
3. Bash の `run_in_background` で Vite を起こす。`web.log` に `Local:   http://localhost:<Vite の port>/` が出たら開ける。

   ```bash
   MONICA_HOME=${TMPDIR%/}/monica-s2 bun run web > $SCRATCH/web.log 2>&1
   ```

4. agent-browser で開く。並行する他の agent と競合しないよう、すべてのコマンドに同じ `--session <固有の名前>` を付ける。

   ```bash
   agent-browser --session monica-s2 open http://localhost:<Vite の port>/
   agent-browser --session monica-s2 snapshot
   ```

   `eval` の式は頁の global で評価され、2 回目の `const` の宣言で失敗する。式は `(() => { … })()` で包む。失敗に気付かずにキーを送ると、思った所と違う Note に効く。

   Backend に届かないときは、Vite が proxy の接続を応答なしで切り（release の口と同じく、画面には network error に見える）、`web.log` に `http proxy error` が出る。

5. 確かめる Note は、ブラウザの口に RPCLink を向けた script で入れる。router は `{ note }` の下にあり、GET 以外の request には `Sec-Fetch-Site: same-origin` か、`Sec-Fetch-Site: none` と `Sec-Fetch-Mode: cors` の組（Chrome Extension の fetch が付けるもの）が要る。script を `packages/note/` の下に置くと `@orpc/*` と `./src/contract.ts` を解決できるので、終わったら消す。

   ```ts
   const root: ContractRouterClient<{ note: typeof contract }> = createORPCClient(
     new RPCLink({ url: `http://localhost:${browserPort}/rpc`, headers: { 'sec-fetch-site': 'same-origin' } }),
   )
   const daily = await root.note.daily.open({ date: '2026-10-06' })
   ```

6. headless の Chromium では、キーの ⌘C / ⌘V が copy と paste にならず、agent-browser の click と mouse には修飾キーが載らない。どちらも event を合成して DOM に送る。ProseMirror は `ClipboardEvent` の `clipboardData` だけを読み書きするので、clipboard の plugin は本物の経路を通る。copy の DataTransfer を `window` に控え、移るときは画面の link で移る（`open` は頁を読み直して控えを消す）。

   ```bash
   agent-browser --session monica-s2 eval "(() => { const dt = new DataTransfer(); document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true })); window.__copied = Object.fromEntries(dt.types.map((t) => [t, dt.getData(t)])) })()"
   agent-browser --session monica-s2 eval "(() => { const dt = new DataTransfer(); for (const [t, v] of Object.entries(window.__copied)) dt.setData(t, v); document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) })()"
   agent-browser --session monica-s2 eval "document.querySelector('a[data-note-mention=\"note-3\"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))"
   ```

   エディタの中の文字は `find text … click` では押せないので、`click '[data-block-id="<id>"] [data-block-content]'` のように CSS の selector で押す。

   画像の貼り付けは、`DataTransfer` に `File` を `items.add` して送る。ドロップは `new DragEvent("drop", { dataTransfer: dt, clientX, clientY, bubbles: true, cancelable: true })` を送る。page は手元の file を読めないので、画像のバイト列は base64 で js に埋める。他の site の画像は、別の port で立てた Bun.serve の fake を `<img src>` に書く。

   block の id がまだ無い段落（新しい Daily の最初の段落など）に URL を貼ると、「Paste as」が出ない（#177）。メニューを確かめるときは、先に `press End` と `press Enter` で次の段落を作ってから貼る。

片付けでは `agent-browser --session monica-s2 close` で browser を閉じ、Vite の pid（`lsof -ti tcp:<Vite の port> -sTCP:LISTEN`）に `kill` を送ってから、下の手順で Backend を止める。

## 止めて片付ける

- stdin の EOF で止める: sleep の pid を、起こしたときの固有の秒数で `pgrep -f "^sleep 100002$"` と取り、その pid に `kill` を送る。`pkill -f` は harness の zsh にも当たり、親ごと殺す。
- SIGTERM で止める: `kill -TERM $(jq .pid ${TMPDIR%/}/monica-s2/backend.json)`。pipe の左の sleep は残り、background の job が終わらないので、続けて上の手順で sleep も止める。
- Backend は抜けるときに `backend.json` を消すので、それが消えたら止まっている。`rm -rf ${TMPDIR%/}/monica-s2` で home を消す。ptyd は socket が消えたのを 2 秒おきの確認で見つけ、shell ごと終わるので、下の判定は数秒待ってからする。
- Tab で claude を起こしたなら、claude が cwd ごとに作る `~/.claude/projects/-private-var-folders-…-monica-s2…` も消す（cwd の `/` と `.` が `-` になった名前）。`ls ~/.claude/projects | grep monica-s2` で見つかる。

片付いたのは、`backend.json` が消えた後に `pgrep -f "monica-ptyd --monica-home ${TMPDIR%/}/monica-s2"` が何も返さず、home が消えたとき。消し忘れた dev は `bun run dev:list` で見つけ、`bun run dev:kill <NAME>` で片付ける。
