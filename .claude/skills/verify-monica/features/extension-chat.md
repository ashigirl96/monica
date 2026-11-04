# side panel の Chat

ユーザーは Brave の toolbar の Monica の action で side panel を開き、今の頁について質問すると、monica の Backend が claude に訊いて答えを流す。答えている間は止められる。

## Sub-features

- `chat-open`: action で side panel が開き、入力欄が出る。
- `chat-ask`: 質問を送ると答えが流れ、終わると送るボタンに戻る。
- `chat-stop`: 答えている間に止めると `止めました` が出る。
- `chat-model`: 入力欄の横の model と effort の欄で、次の質問の model と effort を選ぶ。
- `chat-unreachable`: Backend に届かないと `monica の desktop が起動していません` が出る。

## How to get to it (user POV)

- Brave の toolbar の Monica の action を押す。
- 入力欄（placeholder `このページについて質問`）に書いて Enter か `送る` を押す。答えている間は同じ位置が `止める` になる。
- 入力欄の横の model（`select[aria-label="model"]`）と effort（`select[aria-label="effort"]`）の欄。

## Driving it with headless の Brave と extension-panel.ts

Preconditions:

- `surfaces/extension.md` の「起こす」で `bun run extension --headless` を起こし、log に `[extension] ready` が出た。home は `${TMPDIR%/}/monica-<worktree の名前>`。
- 同じ節の 3 で `launch.sh <worktree の名前>` の Backend を起こし、`doctor.sh <worktree の名前>` が `OK`。以下の `extension-panel.ts` はすべて `MONICA_HOME=$H` を前に付けて流す。

- **開く.** `bun scripts/extension-panel.ts open` を流す。side panel の target id が出る。描かれるまで数秒おきに `eval 'document.querySelector("textarea[aria-label=\"質問\"]") !== null'` を流し、`true` になるのを待つ。`true` になった後の`eval 'document.body.innerText.includes("monica の desktop が起動していません")'` が `false`。
- **model と effort の欄を見る.** `eval '[...document.querySelectorAll("select[aria-label=model] option, select[aria-label=effort] option")].map(o => o.parentElement.getAttribute("aria-label") + ":" + o.textContent)'` に、`model:Default (recommended)` から始まる model の名前と `effort:low` から `effort:max` が並ぶ。
- **request を見張る.** Bash の `run_in_background` で `bun scripts/extension-panel.ts requests /rpc/chat/ask > $E/extension-chat.requests.jsonl` を起こす。
- **書く.** `eval '(() => { const t = document.querySelector("textarea[aria-label=\"質問\"]"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "1 から 5 を並べて"); t.dispatchEvent(new Event("input", { bubbles: true })); return t.value })()'` が書いた質問を返す。
- **送る.** 別の `eval` で `document.querySelector("button[aria-label=\"送る\"]").click()` を流す。直後の `eval 'document.querySelector("button[aria-label=\"止める\"]") !== null'` が `true`。
- **答えを待つ.** `eval` を数秒おきに流し、`button[aria-label="止める"]` が消えるのを待つ。`eval 'document.querySelector(".typeset")?.innerText'` に 1〜5 が並ぶ。
- **副作用を見る.** `$E/extension-chat.requests.jsonl` に、body に質問を含む `/rpc/chat/ask` の行がある。Backend の子の claude は、side panel を開いた時点で次の質問の分が起きているので、送った証拠にはしない。
- **止める.** 長めの答えになる質問（`1 から 50 まで 1 行ずつ数えて`）を同じく書いて送り、1 秒後に別の `eval` で `document.querySelector("button[aria-label=\"止める\"]").click()` を流す。`eval 'document.body.innerText.includes("止めました")'` が `true`。
- **届かない.** 最後に、Backend だけを `kill -TERM $(jq .pid $H/backend.json)` で止め、`backend.json` が消えたのを見てから `close` と `open` で開き直す。`eval 'document.body.innerText.includes("monica の desktop が起動していません")'` が数秒のうちに `true` になる。
- **証拠.** `launch.sh` を同じ名前で起こし直すと `out.jsonl` と `err.log` が空になるので、Backend を止める前に `$E` の中で別の名前に写す。送る前と答えた後に `bun scripts/extension-panel.ts screenshot $E/extension-chat-{before,after}.png` を撮る。各 `eval` の出力を `$E/extension-chat.transcript` に残す。

## Gotchas

- `open` の直後はまだ描かれておらず、入力欄の確認は `false`、screenshot は白になる。`false` を失敗と読まずに待つ。
- headless の Brave の最初の Browser Tab は `chrome://` の頁なので、header は `読めないページ` になり、request の `page` は `unreadable`・`restricted` になる。頁の中身を読む振る舞いを確かめるときは、先に `agent-browser --session <名前> --cdp <port>` で Web の頁を開く（`surfaces/extension.md` の「agent-browser」）。
- 書くのと送るのは別の `eval` にする。同じ式で続けて click すると、React が draft を書き換える前に押され、空の質問になる。
- textarea の `value` を代入するだけでは React に届かない。prototype の setter を呼んでから `input` を送る。
- `requests` は有効にする前の request を拾わない。送る前に起こしておく。
- `packages/chat/src/ui` を編集した後は、HMR の後も前の module の listener が残る。`close` と `open` で開き直してから確かめる。
- `monica の desktop が起動していません` が出たら、side panel が同じ home の Backend を見つけていない。Brave と Backend の home の名前が揃っているかと、`doctor.sh` を見る。
- 答えは本物の claude が返す。1 回ごとに課金されるので、質問は短くする。
- worktree の session では guard が `eval` の語を見て止める。止められたら言い換えずに、確かめられなかったと報告する。
- 片付けは `surfaces/extension.md` の「止める」のとおり `cleanup.sh <worktree の名前>`。Brave も止まる。`$E` は残る。
