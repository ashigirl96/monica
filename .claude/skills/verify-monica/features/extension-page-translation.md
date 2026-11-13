# Page Translation

ユーザーは Brave で ⌥A を押すと、Current Page の本文だけが日本語に置き換わり、もう一度押すと原文に戻る。訳している間は拡張のアイコンのバッジに `…` が出て、失敗すると `!` と、tooltip に理由が出る。

## Sub-features

- `translate-press`: ⌥A で本文が日本語になり、ナビゲーションと `code` は元のまま残る。
- `translate-restore`: もう一度 ⌥A を押すと原文に戻り、バッジが空になる。
- `translate-unreachable`: Backend に届かないと、バッジに `!`、tooltip に `Page Translation failed: the monica desktop is not running` が出る。

## How to get to it (user POV)

- Browser Tab で ⌥A を押す（manifest の `commands` の `page-translation`）。
- 割り当ては `brave://extensions/shortcuts` で見る。他の拡張とぶつかると、Brave は割り当てない。

## Driving it with headless の Brave と CDP

Preconditions:

- `surfaces/extension.md` の「起こす」で `bun run extension --headless` を起こし、同じ home に `launch.sh <worktree の名前>` の Backend を起こして、`doctor.sh` が `OK`。
- headless の Brave には本物のキーを押せないので、⌥A の代わりに、service worker から同じ script を注入する。CDP の script は scratchpad に書き、`MONICA_HOME=$H bun <script>` で流す。repo の `scripts/cdp.ts` の `connectCdp`・`browserEndpoint`・`attach`・`evaluate` を使う。

- **⌥A の割り当てを見る.** service worker の target（`type === 'service_worker'` で URL が `chrome-extension://`）で `chrome.commands.getAll()` を評価する。`name: "page-translation"` が `shortcut: "⌥A"` を持つ。
- **ページを開く.** `Target.createTarget` で、URL の末尾に回ごとの `#verify-<時刻>` を付けて開く。注入する Browser Tab は、service worker で `chrome.tabs.query({})` から `tab.url` が同じものを選ぶ。
- **押す.** service worker で `chrome.scripting.executeScript({ target: { tabId }, files: ['src/page-translation.ts.iife.js'] })` を評価する。build の出力では、注入する file の path は `chrome.runtime.getManifest().web_accessible_resources` の `page-translation` を含む resource。
- **訳し終わりを待つ.** `chrome.action.getBadgeText({ tabId })` を 0.5 秒おきに読み、`…` から `''` に変わるのを待つ。GitHub の markdown のファイル表示（30 段落ほど）で 10〜25 秒。
- **見る.** page の target で本文（`article.markdown-body` などの `innerText`）が日本語になり、`header li, nav li` に日本語を含むものが 0 件、行内の `code` の文字が元の英語のまま。page で `typeof globalThis[Symbol.for('monica.pageTranslator')]` が `undefined`（ページの script から見えない）。
- **戻す.** 同じ注入をもう一度流す。1 秒後に本文が英語に戻り、バッジが `''`。
- **届かない.** Backend だけを `kill -TERM $(jq .pid $H/backend.json)` で止め、`backend.json` が消えてから、別の Browser Tab で押す。数秒で `chrome.action.getBadgeText` が `!`、`chrome.action.getTitle` が `Page Translation failed: the monica desktop is not running`。
- **証拠.** 各評価の値を `$E/page-translation.transcript` に追記し、`Page.captureScreenshot` で前と後を `$E/page-translation-{before,after}.png` に撮る。Backend の `err.log` の `[chat] translating claude …` の行が、訳しに送った証拠になる。

## Gotchas

- `?script&iife` で注入する script は HMR されない。`packages/chat/src/ui/page-translation/` を直したら、`cleanup.sh` と `bun run dev:kill` で止めて `bun run extension --headless` から起こし直す。dev の出力の `$H/dev-extension/src/page-translation.ts.iife.js` に直した関数の名前が入ったかを `grep` で見てから押す。
- 同じ URL の Browser Tab が残っていると、`chrome.tabs.query({ url })` は前の回の Browser Tab を返し、注入は見ていない Browser Tab に入る。URL に回ごとの印を付ける。
- 本文の判定は窓の幅で変わる。headless の Brave は幅 756px ほどで、GitHub は header のメニューを展開して描き、Defuddle がそれを本文に残す。side panel を開いた窓も同じ幅になる。header とメニューが訳されないことは、狭い幅で確かめる。
- linkedom の Defuddle は窓の幅も見た目の計算も持たないので、テストが通っても、実機とは本文の判定が違う。本文の判定を変えたら、実機で GitHub の markdown のファイル表示を確かめる。
- isolated world の中を見るときは、page の target で `Runtime.enable` を送り、`executionContextCreated` のうち `auxData.type === 'isolated'` で name が拡張の名前の context で評価する。そこでは `chrome.runtime.sendMessage` が使える。
