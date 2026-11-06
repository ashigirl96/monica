# Pad

ユーザーは Daily の画面のサイドバーの最上段か ⌥K で Pad を開いて書き、別の時に開き直しても書いた本文が残っている。

## Sub-features

- `pad-entry`: 今日の Daily のサイドバーの最上段に Pad の行がある。
- `pad-cycle`: 今日の Daily から ⌥K で `/pad` に移り、⌥J で今日の Daily に戻る。
- `pad-write`: Pad に書いた本文が、読み込み直しても残る。

## How to get to it (user POV)

- notes の画面の Daily（⌃1）。サイドバーの最上段の `Pad` を押すか、今日の Daily で ⌥K。
- URL は `/pad`。

## Driving it with headless の Backend・Vite・agent-browser

Preconditions は [Daily](./note-daily.md) と同じ。

- **入り口.** `open http://localhost:<Vite の port>/` の後の `snapshot -i` に `button "Pad"` が `TODAY · …` の上にある。
- **巡る.** `press Alt+k` の後、`eval 'location.pathname'` が `/pad`、見出しの `h1` が `Pad`。`press Alt+j` で `/daily/<今日>` に戻る。
- **書く.** Pad で `click '[data-block-content]'`、1 秒待って `keyboard type 'verify-pad-ok'`。
- **読み込み直す.** autosave を待ってから `open http://localhost:<Vite の port>/pad`。`.ProseMirror` の本文が `verify-pad-ok`。
- **別の経路で読む.** `POST /rpc/note/pad/open`（`Sec-Fetch-Site: same-origin`、本文 `{}`）の応答に `verify-pad-ok` がある。
- **証拠.** 開いた時と書いた後の `screenshot` を `$E/note-pad-*.png` に、RPC の応答を `$E/note-pad.transcript` に残す。

## Gotchas

- Vite の口は SPA を配るだけで、`/pad` の OGP は足さない。OGP はブラウザの口の頁で付く（`apps/backend/src/browser-listener.test.ts`）。
- ほかは [Daily](./note-daily.md) の Gotchas と同じ。
