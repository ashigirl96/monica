---
name: backend-headless
description: "desktop 無しで Backend と tania-ptyd を起こし、CLI と RPC で振る舞いを確かめる。受け入れ条件を手で確かめるとき、Backend の起動・終了・ptyd との再接続を実機で見るときに使う。"
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
