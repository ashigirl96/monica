---
name: backend-headless
description: "desktop 無しで Backend と tania-ptyd を起こし、CLI と RPC で振る舞いを確かめる。受け入れ条件を手で確かめるとき、Backend の起動・終了・ptyd との再接続を実機で見るとき、Tab で claude を動かして Agent Session を見るときに使う。"
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

- Agent Session の状態（dot、通知）を claude 無しで動かすには、hook の payload を CLI の hook に流す。claude と同じ経路で `recordHook` に届き、待ちの状態や理由を狙って作れる。payload の field と場面ごとの順は `docs/research/hook-payloads.md`。Terminal Session は帳簿で live なもの（`runspace.create` で開いた Tab の `terminalSessionId`）を使う。それ以外は記録されない。通知は Backend の stdout（`out.jsonl`）に `{"type":"notify",…}` の行で出る。

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

## 止めて片付ける

- stdin の EOF で止める: sleep の pid を `pgrep -f "^sleep 100000$"` で取り、その pid に `kill` を送る。harness は command を zsh で包むので、`pkill -f` はその zsh の command 行にも当たり、親ごと殺す。
- SIGTERM で止める: `kill -TERM $(jq .pid ${TMPDIR%/}/tania-s2/backend.json)`。pipe の左の sleep は残り、background の job が終わらないので、続けて上の手順で sleep も止める。
- Backend が止まったら `rm -rf ${TMPDIR%/}/tania-s2` で home を消す。ptyd は socket が消えたのを 2 秒おきの確認で見つけ、shell ごと終わるので、下の判定は数秒待ってからする。

片付いたのは、`pgrep -f apps/backend/src/main.ts` と `pgrep -f "tania-ptyd --tania-home ${TMPDIR%/}/tania-s2"` が何も返さず、home が消えたとき。消し忘れた dev は `bun run dev:list` で見つけ、`bun run dev:kill <NAME>` で片付ける。
