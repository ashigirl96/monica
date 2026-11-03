# Daily

ユーザーは notes の画面で今日の Daily を開いて書き、別の時に開き直しても書いた本文が残っている。

## Sub-features

- `daily-open`: Daily を開くと、無ければ作られる。
- `daily-write`: エディタに書いた本文が保存される。
- `daily-reopen`: 読み込み直しても本文が残る。
- `daily-dates`: Daily のある日付の一覧に出る。

## How to get to it (user POV)

- notes の画面（desktop の Note の画面、または `apps/web` をブラウザで開く）。⌃1〜3 で画面を移る。
- Chrome Extension にも notes の口がある（`surfaces/extension.md`）。

## Driving it with headless の Backend・Vite・agent-browser

Preconditions:

- `surfaces/headless.md` の「notes の画面をブラウザで確かめる」の 1 でブラウザの口と Vite の port を引き、`launch.sh <name> MONICA_BROWSER_PORT=<ブラウザの口の port>` で起こした。
- 同じ節の 3 で `MONICA_HOME=$H bun run web` を起こし、log に `Local:` が出た。
- agent-browser は `--session verify-<name>` を付けて使う。

- **開く.** `agent-browser --session verify-<name> open http://localhost:<Vite の port>/` の後に `snapshot` を取る。今日の Daily のエディタ（`.ProseMirror`）がある。
- **書く.** `click '[data-block-content]'` で最初の段落に入り、1 秒待ってから `type 'verify-daily-ok'` を送る。画面に文字が出る。
- **読み込み直す.** autosave を待ってから `open` で頁を読み直し、`snapshot` に `verify-daily-ok` がある。
- **別の経路で読む.** ブラウザの口の `POST /rpc/note/daily/open`（`Sec-Fetch-Site: same-origin`）で今日の Daily を読み、本文に `verify-daily-ok` がある。
- **証拠.** 書いた後と読み直した後の `screenshot` を `$E/note-daily-*.png` に、RPC の応答を `$E/note-daily.transcript` に残す。

## Gotchas

- Logical Date は 5 時が境目。0 時から 5 時に確かめると、今日の Daily は前の日付になる。RPC で読む日付を合わせる。
- `open` は頁を読み直し、まだ保存されていない本文を捨てる。読み直す前に autosave を待つ。
- フォーカスから 200ms 以内のキーは選択が戻されて失敗に見える。1 秒待ってから打つ。
- 片付けでは `agent-browser --session verify-<name> close` と、Vite の pid（`lsof -ti tcp:<Vite の port> -sTCP:LISTEN`）への `kill` を `cleanup.sh` の前に行う。`cleanup.sh` は Vite と browser を止めない。
