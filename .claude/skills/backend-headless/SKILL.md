---
name: backend-headless
description: "desktop 無しで Backend と tania-ptyd を起こし、CLI と RPC で振る舞いを確かめる。受け入れ条件を手で確かめるとき、Backend の起動・終了・ptyd との再接続を実機で見るとき、Tab で claude を動かして Agent Session を見るとき、Task の Bench（run・close）を確かめるときに使う。"
---

Backend を本物の ptyd に繋いで起こす。Shell の役（親として生き続け、stdin の pipe の書き側を握る）は Bash の background job が演じる。

## 起こす

1. `cargo build -p tania-ptyd`
2. home は `${TMPDIR%/}/tania-s2` のように、`$TMPDIR` の下に短い名前で作る。ptyd の socket（`$TANIA_HOME/ptyd.sock`）の path が 104 byte を超えると bind できず、client には ENOENT にしか見えない。
3. Bash の `run_in_background` で、stdin を無名 pipe で握って起こす。出力は scratchpad の file に向ける。

   ```bash
   sleep 100000 | TANIA_HOME=${TMPDIR%/}/tania-s2 TANIA_PTYD_PATH=target/debug/tania-ptyd \
     bun apps/backend/src/main.ts > $SCRATCH/out.jsonl 2> $SCRATCH/err.log
   ```

   - 親は background job のまま生かす。`( … &)` で切り離すと親がすぐ死に、Backend は ppid=1 の見張りで約 1 秒後に黙って抜ける。
   - stdin は無名 pipe にする。Bun は fifo の EOF を拾わないので、fifo では stdin の EOF で抜ける振る舞いを確かめられない。
   - `.app` でだけ起きること（gh や ghq が見つからないなど）を確かめるときは、`env -i HOME=$HOME USER=$USER SHELL=/bin/zsh LANG=$LANG TMPDIR=$TMPDIR PATH=/usr/bin:/bin:/usr/sbin:/sbin` を前に付け、bun を絶対 path（`~/.bun/bin/bun`）で起こす。PATH が launchd の渡すものと同じになり、Backend が login shell から取った PATH が効いているかを見られる。
   - Monica の tab の中（`env | grep MONICA` が出る）から起こすときは、`env -i HOME=$HOME USER=$USER SHELL=/bin/zsh TERM=xterm-256color LANG=$LANG TMPDIR=$TMPDIR PATH=<monica を含む dir を除いた PATH>` を前に付ける。ptyd は Backend の env を tab に渡すので、`MONICA_*` が残ると tab の claude に Monica の hook が付き、Monica 側に記録される。

4. tab の claude の hook を確かめるなら、起動した後に `ln -s $PWD/scripts/tania-dev ${TMPDIR%/}/tania-s2/bin/tania` を張る。hook の settings の command はこの path を指し、desktop では Shell が張る。

起動できたのは、`out.jsonl` に `{"type":"endpoint",…}` の行が出て、`$TANIA_HOME/backend.json` ができたとき。待つのは、Bash の `run_in_background` で `until [ -f ${TMPDIR%/}/tania-s2/backend.json ] || ! pgrep -qf apps/backend/src/main.ts; do sleep 0.5; done` を走らせる（前景の `sleep` は harness が止める）。抜けた後に `backend.json` が無ければ Backend は落ちているので、`err.log` を読む。

## 確かめる

- CLI: `TANIA_HOME=${TMPDIR%/}/tania-s2 bun run tania <command> [--format json]`。exit code は 0 = 成功、1 = それ以外の失敗、2 = Backend 不在。
- RPC: CLI に出さない procedure は、CLI の `connect()` で作った client から呼ぶ。path は package 名から始まる。

  ```bash
  TANIA_HOME=${TMPDIR%/}/tania-s2 bun -e '
  const { connect } = await import(`${process.cwd()}/apps/cli/src/backend.ts`);
  const client = connect(process.env.TANIA_HOME);
  console.log(JSON.stringify(await client.workbench.layout.get()));'
  ```

- Tab への打ち込みと画面: Tab は RPC の `workbench.runspace.create` で開き、`tab.terminalSessionId` に ptyd の socket で `write`（data は base64）を送る。画面は `attach`（`replay_bytes` で末尾を指定）の応答の `replay` を base64 で解き、escape sequence を除いて読み、`detach` する。Enter は `\r`、Shift+Tab は `\x1b[Z`。claude の状態の移り変わりは、`agentSession.list` を 200ms ごとに読んで、変わったときだけ出すと取りこぼさない。

  ```bash
  TANIA_HOME=${TMPDIR%/}/tania-s2 bun -e '
  const [id, text] = ["ts-…", "claude --model haiku\r"];
  const socket = await Bun.connect({
    unix: `${process.env.TANIA_HOME}/ptyd.sock`,
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
  - resume を確かめるときは、prompt を 1 つ送って答えを待ってから抜ける。claude は最初の prompt まで transcript を書かないので、prompt を送らずに抜けた Agent Session の `--resume` は `No conversation found` で終わる。
- Agent Session の状態（dot、通知）を claude 無しで動かすには、hook の payload を CLI の hook に流す。claude と同じ経路で `recordHook` に届き、待ちの状態や理由を狙って作れる。payload の field と場面ごとの順は `docs/research/hook-payloads.md`。Terminal Session は Workbench Ledger で live なもの（`runspace.create` で開いた Tab の `terminalSessionId`）を使う。それ以外は記録されない。通知は Backend の stdout（`out.jsonl`）に `{"type":"notify",…}` の行で出る。

  ```bash
  printf '%s' '{"session_id":"s-1","transcript_path":"/tmp/t.jsonl","cwd":"/Users/me/src/tania","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}' |
    TANIA_HOME=${TMPDIR%/}/tania-s2 TANIA_TERMINAL_SESSION_ID=ts-… scripts/tania-dev workbench hook claude
  ```

- HTTP: `/health` は token 無しで返る。port と token は `backend.json` にある。
- ptyd にだけある session を作るには、socket に直接 `hello` と `create` を送る。Backend を起こし直すと reconcile が取り込む。protocol は `crates/terminal-protocol/src/lib.rs`。

  ```bash
  TANIA_HOME=${TMPDIR%/}/tania-s2 bun -e '
  const socket = await Bun.connect({
    unix: `${process.env.TANIA_HOME}/ptyd.sock`,
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

1. 起こすときに `GHQ_ROOT=${TMPDIR%/}/tania-s2-ghq` を Backend の env に足す（`env -i` で起こすときも）。ghq は `GHQ_ROOT` を `ghq root` の答えにする。渡し忘れると、ユーザーの本物の checkout で worktree を作る。
2. Task を 1 つ `run --in-place` する。`ghq get` が GitHub から `tania-s2-ghq` の下に checkout を clone する。
3. その checkout から一時の origin を作る。`.tania/setup.sh` を commit した main を push し、checkout の `origin` をそこへ向ける。以後の worktree の Bench は、この main から作られる。setup の振る舞いは script が読む mode file で切り替えるので、commit し直さずに成功・失敗・長い setup を作れる。

   ```bash
   T=${TMPDIR%/}; C=$T/tania-s2-ghq/github.com/<owner>/<repo>; O=$T/tania-s2-origin/repo.git; W=$T/tania-s2-origin/work
   git clone --bare --quiet $C $O && git clone --quiet $O $W && mkdir -p $W/.tania
   printf '#!/bin/sh\ncase "$(cat %s)" in fail) exit 1 ;; slow) sleep 30 ;; *) sleep 3 ;; esac\n' $T/tania-s2-mode > $W/.tania/setup.sh
   chmod +x $W/.tania/setup.sh && echo ok > $T/tania-s2-mode
   git -C $W add .tania && git -C $W -c user.name=t -c user.email=t@e commit -qm setup && git -C $W push -q origin HEAD:main
   git -C $C remote set-url origin $O
   ```

4. 片付けでは、home と一緒に `tania-s2-ghq`・`tania-s2-origin`・`tania-s2-mode` も消す。

## 止めて片付ける

- stdin の EOF で止める: sleep の pid を `pgrep -f "^sleep 100000$"` で取り、その pid に `kill` を送る。`pkill -f` は harness の zsh にも当たり、親ごと殺す。
- SIGTERM で止める: `kill -TERM $(jq .pid ${TMPDIR%/}/tania-s2/backend.json)`。pipe の左の sleep は残り、background の job が終わらないので、続けて上の手順で sleep も止める。
- Backend が止まったら `rm -rf ${TMPDIR%/}/tania-s2` で home を消す。ptyd は socket が消えたのを 2 秒おきの確認で見つけ、shell ごと終わるので、下の判定は数秒待ってからする。
- Tab で claude を起こしたなら、claude が cwd ごとに作る `~/.claude/projects/-private-var-folders-…-tania-s2…` も消す（cwd の `/` と `.` が `-` になった名前）。`ls ~/.claude/projects | grep tania-s2` で見つかる。

片付いたのは、`pgrep -f apps/backend/src/main.ts` と `pgrep -f "tania-ptyd --tania-home ${TMPDIR%/}/tania-s2"` が何も返さず、home が消えたとき。消し忘れた dev は `bun run dev:list` で見つけ、`bun run dev:kill <NAME>` で片付ける。
