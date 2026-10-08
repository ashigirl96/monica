# model に渡すページの情報（Page Snapshot）の事実

wayfinder の map #254「ブラウザ拡張の side panel で、開いているページについて質問できるチャットを作る」のチケット #263「model に渡すページの情報」を grilling で決めるために集めた事実。決めた形はチケットの resolution comment にある。ここには事実と数字だけを置く。

確かめた環境: macOS（Darwin 25.6.0、arm64）、Bun 1.4.2、`@anthropic-ai/claude-agent-sdk` 0.3.293（同梱の claude 2.1.293）、Claude Team の plan の login、Brave 1.97.56（Chromium 155.0.8059.40）、Chrome for Testing（CfT）154.0.8037.57、puppeteer-core 24.39.0、@mozilla/readability 0.6.0、defuddle 0.19.4、pdfjs-dist 6.4.299、linkedom 0.18.13。【実機】と書いたものは scratchpad で動かして確かめた。ブラウザは新しい空の user-data-dir で起こし、拡張は `<all_urls>`・`scripting`・`sidePanel`・`storage` だけを持つ（activeTab と tabs は無し）。agent は #257 の isolated の options（`settingSources: []`、`tools: []`、`skills: []`、`strictMcpConfig: true`、`persistSession: false`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、空の cwd）に `title` を足して、`env -i` で絞った env から起こした。haiku の入力は計約 2.1M token。

## 要点

| 問い | 答え |
|---|---|
| model と context | 【実機】`haiku` は `claude-haiku-5-5`。`modelUsage.contextWindow` は 1,000,000、`maxOutputTokens` は 128,000。`[1m]` は要らない |
| 1 token あたりの字数 | 【実機】日本語 1.13〜1.35（地の文だけで 1.13）、英語 2.6〜3.0 |
| 長い本文 | 【実機】40 万字（340,861 token）を 1 つの user message で送っても、CLI は切り詰めも拒否もしなかった。最初の text delta まで 2〜5 秒 |
| 本文の送り直し | 【実機】同じ process の turn 3 で同じ本文を送ると、context は本文 2 つ分になる。別の process から 5 分以内に同じ本文を送ると cache read になった |
| content block | 【実機】`image`（1280×800 で 1,337 token）も `document`（text、`title`、`context`）も CLI がそのまま API へ送り、model は中身を読めた |
| in-process の MCP tool | 【実機】`allowedTools` で許せば動き、遅れは中央値 +0.5 秒。tool の結果が約 5 万字を超えると、CLI が `persistSession: false` でも本文を `~/.claude/projects/` に書く |
| CLI が足すもの | 【実機】system に SDK の 1 文、最初の user message に user の email、`# Environment`（cwd・git・platform・日付）。`title` を渡さないと、最初の user message を丸ごと入れた title 生成の request がもう 1 本出る |
| Backend で抽出できるか | 【実機】描画後の outerHTML を Bun の linkedom で defuddle にかけると、ブラウザの中で抽出した文字数と一致した。jsdom 30 と happy-dom 20 では defuddle が失敗する |
| 本文の大きさ | 【実機】defuddle の Markdown は Wikipedia で 10.4 万字、うち 52% がリンクの URL。URL・画像・tag を落とすと 2.4 万字 |
| PDF | 【実機】pdf.js は Bun でも side panel でも読めた（arXiv の 15 ページで 4.1 万字）。Bun の `--compile` では worker を静的に import する必要がある |
| Backend の body の上限 | 2 つの口とも `maxRequestBodySize` を渡しておらず、Bun の既定 128MB だけ。oRPC と Hono にも上限は無い |
| 外の画像を CSP で止める | 【実機】`img-src 'self' data:` を manifest に足すと、side panel の外の画像の request はすべて止まった。リンクのクリックは止まらない |
| スクリーンショット | 【実機】`<all_urls>` だけで side panel から `captureVisibleTab` を呼べ、写るのはタブの表示領域だけ |
| Shadow DOM | 【実機】innerText・outerHTML・Readability は shadow root の中を落とす。`chrome.dom.openOrClosedShadowRoot` で集めた root ごと `getHTML` で書き出し、DOMParser で defuddle にかけると closed の root まで残った |
| 見えない文字 | 【実機】stylesheet の class で隠した文字は、Readability も defuddle も残す |
| 選択範囲 | 【実機】CDP の操作では、side panel の textarea に打った後もページの選択が残った。本物のクリックでは未確認 |
| 返らない `executeScript` | 【実機】`view-source:`、`alert()` の最中、frozen のタブ、body が終わらないページ（既定の注入時機）で返らない |

## 1. model と大きな本文

### 1 token あたりの字数と時間

【実機】Wikipedia の HTML を curl で取り、`mw-content-text` の tag を落とした text を、`<page>\n本文\n</page>\n\n質問` の形で 1 つの user message に入れた。本文の先頭・中央・末尾に検証コードを入れ、全部答えさせて切り詰めを見た。baseline（本文を空にした同じ形）は ja 699、en 678 token。入力 token は `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`。時間は cold（先頭に毎回違う 1 行を足して prompt cache を外した）で 2 回。

| 本文 | 字数 | ASCII の割合 | 入力 token | 字/token | 最初の delta / 全体（ms） | 検証コード |
|---|---|---|---|---|---|---|
| 日本語の地の文 | 19,840 | 0.12 | 18,251 | 1.13 | 3,120 / 3,424 | - |
| ja 20k | 19,996 | 0.57 | 15,613 | 1.34 | 1,936 / 2,087、2,276 / 2,670 | 3/3 |
| ja 100k | 99,893 | 0.55 | 74,533 | 1.35 | 2,905 / 3,401、3,279 / 3,680 | 3/3 |
| ja 400k | 399,481 | 0.36 | 340,861 | 1.17 | 4,588 / 4,963、5,064 / 5,538 | 3/3 |
| en 20k | 19,761 | 1.00 | 7,349 | 2.96 | 1,883 / 2,171、1,579 / 1,928 | 3/3 |
| en 100k | 99,907 | 1.00 | 37,261 | 2.73 | 2,107 / 2,390、1,893 / 2,249 | 3/3 |
| en 400k | 399,996 | 1.00 | 155,675 | 2.58 | 2,449 / 2,818、2,343 / 2,791 | 3/3 |

- CLI が request を出すまでの時間（`time_to_request_ms`）は 188〜433ms で、本文の大きさで変わらなかった。
- adaptive thinking が 106〜736 token 出ており、最初の delta の時間はその分を含む。proxy で見た request は `thinking: {type:'adaptive'}`、`output_config.effort: 'medium'`、`max_tokens: 128000`。

### 送り直しと prompt cache

【実機】streaming input の 1 process で、ja 50k（49,862 字）の本文 P を送り直した。

| turn | 送ったもの | input | cache_creation | cache_read | 最初の delta / 全体（ms） |
|---|---|---|---|---|---|
| 1 | P と質問 | 2 | 39,808 | 0 | 1,676 / 2,224 |
| 2 | 「さっきの答えを英語にして」 | 2 | 224 | 39,808 | 513 / 793 |
| 3 | P をもう一度と質問 | 2 | 39,318 | 40,032 | 689 / 907 |

- turn 3 は送り直した P を新しく cache に書き、context は P 2 つ分になった。
- 【実機】ja 20k を 5 分以内に別の process から送ると、2 回目は `cache_read` 15,611 だった。
- `modelUsage` と `total_cost_usd` は session の累計。

## 2. content block

【実機】SDKUserMessage の `message.content` に block を入れた。

| 送ったもの | 入力 token | block の分 | 結果 |
|---|---|---|---|
| `image` PNG 1280×800 | 1,979 | 1,337 | URL バー・見出し・本文・コード・表まで全文を書き起こした |
| `image` PNG 2560×1600 | 3,930 | 3,288 | 全文を読めた。CLI が 2000×1250 に縮めて送っていた（proxy で IHDR を確かめた） |
| `document`（`source: {type:'text'}`、`title`、`context`）に ja 20k | 15,702 | 15,034 | error なし。title と context を答え、検証コード 3/3。同じ text を user text に入れた場合より 120 token 多い |

- CLI は `document` block を `type`・`source`・`title`・`context` のまま API へ送った（proxy）。
- `citations: {enabled: true}` も通るが、引用は stream の `citations_delta` にしか来ず、`assistant` message の text block は `citations: []`、`result` の文字列は最後の text block だけだった。

## 3. in-process の MCP tool

【実機】`createSdkMcpServer` と `tool('read_page', …)` で本文を返す tool を作り、built-in の tool は切ったまま `mcpServers` に載せた。

| 渡し方 | 結果 |
|---|---|
| `mcpServers` だけ | model は呼んだが 2 回とも `permission_denials`。handler は 0 回 |
| ＋`allowedTools: ['mcp__page__read_page']` | 通った |
| ＋`canUseTool` だけ | 通った（`mcpServer: {name:'page', source:'sdk'}`） |

- init の `tools` は `['mcp__page__read_page']` だけ。handler は親（Backend 役の bun）の pid で走った。
- 時間（ja 20k、cold、5 回ずつの中央値）: 本文を直に入れると最初の delta 2,069ms・全体 2,507ms、tool で取ると 2,644ms・3,033ms（+575ms・+526ms）。tool の run は request が 2 回になる。
- 「さっきの答えを英語にして」では 5 回とも tool を呼ばなかった。

### tool の結果の大きさの上限

| tool の結果 | 結果 |
|---|---|
| en 49,500 字、ja 49,862 字（106KB） | そのまま通った |
| en 50,500 字 | `<persisted-output> Output too large (50.1KB)…` という約 2.4k 字の preview に差し替えられた |
| ja・en 約 10 万字 | `Error: result (99,893 characters across 5,560 lines) exceeds maximum allowed tokens. Output has been saved to …` に差し替えられた |

- 差し替えたとき、CLI は本文全体を `~/.claude/projects/<cwd>/<session>/tool-results/` に書いた。`persistSession: false` でも書かれた。
- tool の定義に `_meta: { 'anthropic/maxResultSizeChars': 500000 }` を足すと、10 万字も通った。SDK の `SdkMcpToolDefinition` は `_meta` を持ち、`createSdkMcpServer` はそのまま渡す。

## 4. system prompt と CLI が足すもの

【実機】`systemPrompt`（質問は「Reply with just OK.」）。

| `systemPrompt` | 入力 token |
|---|---|
| 渡さない、`''` | 621 |
| 約 25 token の文字列 | 649（文字列の指示に従った） |
| `{type:'preset', preset:'claude_code'}` | 2,640 |

- 文字列は Claude Code の既定の prompt を置き換える。SDK は渡さないと `""` を送る。
- それでも約 620 token は CLI が足す（proxy で `ANTHROPIC_BASE_URL` を 127.0.0.1 に向けて見た）。
  - `system`: billing header、「You are a Claude agent, built on Anthropic's Claude Agent SDK.」、渡した文字列。
  - `messages[0]`（user）の先頭: `<system-reminder>` に包んだ user の email。
  - `messages[1]`: `role: "system"` の `# Environment`（cwd、git、platform、shell、OS、model 名、knowledge cutoff、日付）。
- 【実機】`title` を渡さないと、CLI は `source=generate_session_title` の request を別に出し、最初の user message 全体を入れる。ja 20k では本体 15,613 token に対し、この request が 16,164 token だった。`title` を渡すと出ない。

## 5. Bun で本文を抽出する

HTML は 2026-10-09 に curl（Chrome の UA）で取り、比較に headless Chrome 155 で描画後の outerHTML も取った。

### DOM の実装

| DOM | Readability | defuddle（`defuddle/node`、`markdown: true, useAsync: false`） |
|---|---|---|
| linkedom 0.18.13 | 動くが、curl の MDN で `<template shadowrootmode>` の中の CSS を本文に入れた | 6/6 で動いた |
| jsdom 30.1.2 | 動いた | 5/6 で `RangeError: Selector exceeds maximum allowed length of 2048.`（@asamuzakjp/dom-selector 9.2.4） |
| jsdom 26.1.0 | 動いた | 動くが遅い（Wikipedia で 1.3〜1.4 秒） |
| happy-dom 20.14.5 | 動いた | Wikipedia と MDN で `TypeError …toUpperCase`（`standardizeFootnotes` の `el.matches`） |

- defuddle は失敗しても例外を投げず、`console.error` を出して body 全体を返す（`dist/defuddle.js:996-1005` の `_serializeFallbackBody()`）。文字数が約 2 倍になる。
- `defuddle/full` を Bun で使うと Markdown 変換が `ReferenceError: document is not defined` で失敗し、元の HTML を返す。
- `defuddle/node` は常に `parseAsync()` を呼ぶ（`dist/node.js:71`）ので、第三者の API を呼ばせないには `useAsync: false` が要る。

### 描画後の outerHTML を Bun（linkedom）で抽出した文字数

| ページ | outerHTML | UTF-8 bytes | Readability | defuddle MD | ブラウザの中（#258）の Readability / defuddle |
|---|---|---|---|---|---|
| ja.wikipedia「Google Chrome」 | 660,075 | 719,417 | 18,536 | 104,203（269ms） | 18,546 / 104,203 |
| MDN「Window.getSelection」 | 92,685 | 92,741 | 2,220 | 4,183 | 2,112 / 3,908 |
| developer.chrome.com の scripting | 255,867 | 270,613 | 13,615 | 12,854 | 12,384 / 12,854 |
| GitHub brave-browser#51271 | 333,827 | 333,862 | 2,885 | 9,536 | 2,885 / 9,536 |
| Impress Watch 2146835 | 371,436 | 386,372 | 1,223 | 2,222 | - |
| martinfowler.com「Microservices」 | 84,950 | 85,083 | 38,178 | 46,798 | - |

- curl の HTML は描画後と違う。GitHub の comment は curl では `<script type="application/json">` の中にしか無く、defuddle の GitHub extractor（`dist/extractors/github.js:93-97`）は DOM から読むので落ちる（6,921 字）。
- outerHTML では shadow root の中身が渡らない（MDN の `<template shadowrootmode>` 24 個が、描画後は shadow root になって outerHTML から消える）。
- 【実機】Backend と同じ flag（`--compile --minify-whitespace --minify-syntax --bytecode --format=esm`）で linkedom + Readability + defuddle/node を build すると動き、binary は 5.76MB 増えた。

### defuddle の options と Markdown の内訳

- `removeImages`（既定 false）で抽出の前に `<img>` を消せる。本文の判定が変わることがある。
- リンクの URL を落とす option は無い。`link` rule は href があれば必ず `[text](href "title")` を出す（`dist/markdown.js:387-399`）。
- turndown は `iframe, video, audio, sup, sub, svg, math` と、colspan・rowspan のある表を HTML のまま残す（`markdown.js:196`、`:139-142`）。

Wikipedia の Markdown 104,195 字の内訳: リンクの `(URL)` 54,615（52%、日本語の記事名は percent-encode で 1 字が 9 字になる）、リンクの title 12,208（12%）、HTML の tag 10,483（10%）、画像 1,043、残りの text 24,186（23%）。

後処理で減らした文字数（描画後の HTML から）:

| ページ | defuddle MD | 画像を落とす | さらにリンクを text に | さらに HTML の tag を消す |
|---|---|---|---|---|
| Wikipedia | 104,203 | - | 34,677 | 24,194 |
| GitHub | 9,536 | 7,003 | 3,994 | - |
| chrome-scripting | 12,854 | - | 11,248 | 11,142 |
| MDN | 4,183 | - | 2,375 | 2,342 |

## 6. PDF

- 【実機】pdfjs-dist 6.4.299 を Bun で動かし、arXiv 1706.03762（2,215,244 bytes、15 ページ）から 41,462 字を取れた（142〜150ms、2 回目から 75〜86ms）。side panel では 41,463 字・321ms（#258）。
- Bun では worker を使わず、main thread の fake worker が `./pdf.worker.mjs` を動的に import する（`pdf.mjs:16209-16213, 16372-16384`）。解析は呼んだ側の event loop で走る。
- 【実機】`--compile` した binary では `Setting up fake worker failed: "Cannot find module './pdf.worker.mjs'"` で失敗した。worker を静的に import して `globalThis.pdfjsWorker` に置くと動いた。binary は 8.0MB 増えた。
- 拡張に同梱する大きさ: `build/pdf.min.mjs` 458,904 bytes、`build/pdf.worker.min.mjs` 1,264,342 bytes（gzip で 131,591 と 374,051）。
- 日本語の PDF（CID font）と cmaps の要否は確かめていない。

## 7. Backend が受け取れる大きさ

- token の口（`apps/backend/src/main.ts:106`）もブラウザの口（`apps/backend/src/notes-listener.ts:51`）も `Bun.serve` に `maxRequestBodySize` を渡していない。既定は 128MB（`bun-types` の `serve.d.ts:760-764`）。
- `RPCHandler` は plugin 無しで作っている（`main.ts:89`、`notes-listener.ts:27`）。oRPC 1.15.4 の body の上限は opt-in の `BodyLimitPlugin` で、超えると `PAYLOAD_TOO_LARGE`。Hono の bodyLimit も使っていない。
- 今ある上限は domain の handler の中だけ（画像 20MB の `packages/note/src/image.ts:12`、OGP の HTML 1MB の `packages/note/src/link-metadata.ts:42-56`）。
- 【実機】`notes-listener.ts` と同じ形（Hono + plugin 無しの RPCHandler、client は RPCLink）の複製に、1MB と 10MB の HTML 文字列、20MiB の base64、20MiB の File、128MiB の文字列は通り、129MiB で 413 になった。描画後の Wikipedia の outerHTML を `{url, html}` にした body は 749,025 bytes。
- 抽出の library（linkedom・jsdom・happy-dom・Readability・defuddle・pdfjs-dist）と react-markdown は repo のどこにも無い。テストは DOM の環境を入れない（`docs/packages/note-ui.md:76`）。

## 8. 外の画像を CSP で止める

【実機】side panel の page に外の画像を置き、別の port（127.0.0.1:47632）の server の log で request が届くかを見た。

| 置いたもの | 既定の CSP | `"script-src 'self'; object-src 'self'; img-src 'self' data:"` |
|---|---|---|
| manifest の受け入れ | - | 受け入れた |
| 静的な `<img src=…?leak=…>` | 届いた | 届かない |
| `<style>` と style 属性の `background-image: url()` | 届いた | 届かない |
| JS で足した `<img>`（createElement、innerHTML）と `new Image().src` | 届いた | 届かない |
| 外の https の画像 | 表示された | 表示されない |
| `data:` の画像 | 表示された | 表示された |
| `<a target="_blank">` のクリック | 新しいタブで開き、届いた | 同じ |

- 止まった request はすべて `securitypolicyviolation`（`effectiveDirective: "img-src"`）を起こした。
- 安全でない値（`script-src 'self' https://cdn.example`）は読み込みの時点で `Insecure CSP value` と拒まれた。
- side panel の画像の request は `Sec-Fetch-Site: none`、`Sec-Fetch-Dest: image` で、`Referer` は付かなかった。
- target の無い `<a>` を押すと request は届いたが、side panel は sidepanel.html のままで、新しいタブも開かなかった（理由は見ていない）。

## 9. スクリーンショット

- 【実機】`chrome.tabs.captureVisibleTab` は activeTab なしでも `<all_urls>` だけで side panel から呼べた。`windowId` を省いても同じ画像になった。
- 写るのはタブの表示領域だけで、side panel と toolbar は写らない。画像の幅はタブの `innerWidth` × DPR（Brave で 862×763、DPR 2 は `--force-device-scale-factor=2` で真似て 1724×1526）。
- bytes（Brave、ja.wikipedia）: png 177,661 / 409,940（DPR 1 / 2）、jpeg 135,338 / 353,848、jpeg q50 67,751 / 179,851。1 回 png 26〜88ms、jpeg 6〜27ms。
- quota: gesture 無しでは 3 回目から `This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.`（約 1 秒に 2 回）。user gesture から 4.8 秒以内は何回でも通った（`tabs_api.cc` の `ShouldSkipQuotaLimiting()` は `user_gesture()` を見る）。
- 読めないページはすぐ reject した（`chrome://newtab` は `The 'activeTab' permission is not in effect…`、`view-source:` と `about:blank` は `Cannot access contents of the page…`）。

## 10. Shadow DOM

【実機】fixture の shadow root の中の文字が残るか（○ 残る、× 消える）。

| 方法 | open | closed | 宣言的 open | 宣言的 closed | slot に入る light DOM の子 |
|---|---|---|---|---|---|
| `body.innerText`、`outerHTML` | × | × | × | × | ○ |
| `getHTML({shadowRoots: open の root})` | ○ | × | ○ | × | ○ |
| `getHTML({shadowRoots: openOrClosedShadowRoot で集めた root})` | ○ | ○ | ○ | ○ | ○ |
| ページの中の Readability | × | × | × | × | ○ |
| ページの中の defuddle | ○ | × | ○ | × | × |
| DOMParser(outerHTML) → Readability / defuddle | × | × | × | × | ○ |
| DOMParser(getHTML 全 root) → defuddle | ○ | ○ | ○ | ○ | ○ |
| `Document.parseHTMLUnsafe`(getHTML 全 root) → defuddle | ○ | × | ○ | × | × |

- `Element.prototype.getHTML` はあり、ISOLATED world の `executeScript` から `chrome.dom.openOrClosedShadowRoot` で closed の root も取れた。
- `getHTML` は shadow root を `<template shadowrootmode>` で書き出す。DOMParser は template を不活性のまま残し、defuddle はそれを展開する。Readability の textContent には入らない。
- defuddle は custom element の host を shadow の HTML に置き換えるので、slot に入る light DOM の子が消える。
- 本文がすべて shadow root の中にあるページでは、innerText と Readability は nav と footer しか返さなかった。

## 11. 見えない文字

【実機】「指示」の文を隠して置いた fixture で、その段落が残るか。ページの中（ISOLATED と MAIN）でも side panel の DOMParser でも同じだった。

| 隠し方 | innerText | Readability | defuddle |
|---|---|---|---|
| `display:none`（style 属性） | × | × | × |
| `display:none`（stylesheet の class） | × | ○ | ○ |
| `visibility:hidden`（style 属性） | × | × | × |
| `visibility:hidden`（class） | × | ○ | ○ |
| `hidden` 属性 | × | × | × |
| `font-size:0`、背景と同じ色、`left:-9999px`、sr-only | ○ | ○ | ○ |
| `aria-hidden="true"` | ○ | × | × |
| `opacity:0` | ○ | ○ | × |
| `<noscript>`、HTML コメント、`<template>` | × | × | × |
| nav・footer（見える） | ○ | × | × |

- Readability は style 属性・`hidden` 属性・`aria-hidden` だけを見る。defuddle の `dist/removals/hidden.js` は style 属性を正規表現で見て、`getComputedStyle` は `doc.defaultView === window` のときだけ使う。ページの中で動かしても class による非表示は落ちなかった。

## 12. 選択範囲

- 【実機（CDP）】ページの段落をドラッグで選び、side panel の textarea をクリックして打った後も、`executeScript` の `getSelection().toString()` は選んだ文字を返した（Brave と CfT で計 8 回）。ページの textarea の中の選択も返り、activeElement はその textarea のままだった。
- 【実機】別の window を前に出してページから focus を外しても、選択は残った。ページの余白をクリックすると `""` になった。
- textarea の `selectionStart/End` は、別の場所を選んだ後も古い値のまま残った。
- CDP の click は OS の focus を動かさず、page と side panel が同時に `hasFocus() === true` を返すことがあった。本物のクリックでの残り方は確かめていない。

## 13. 返らない `executeScript`

【実機】`executeScript` に 5〜15 秒の timeout を付けて試した。

| 場面 | 結果 |
|---|---|
| 通常のページ | 2〜4ms で返った |
| `view-source:` | 返らない（ISOLATED、MAIN、`injectImmediately: true` のどれでも）。タブを閉じると `Frame with ID 0 was removed.` で reject |
| `chrome://newtab`、network error のページ、Basic 認証のダイアログ | すぐ reject |
| 移動中（前の document がある） | 前の document をすぐ返した |
| 新しいタブの最初の navigation が応答待ち | commit まで待った（`injectImmediately: true` でも） |
| body が終わらない | 既定では返らない。`injectImmediately: true` ならすぐ返る |
| `alert()` が出ている | 返らない。閉じると返る |
| 6 秒の busy loop | 5.7 秒後に返った |
| frozen のタブ | 返らない。unfreeze で返る |
| renderer の crash | すぐ reject |
| discard したタブ | CfT は innerText 0 字ですぐ返し、Brave は読み込み直して本文を返した（CDP の attach が効いているかは未確認） |

## 確かめられなかったこと

- 本物のクリックでページから side panel へ focus が移ったときの選択範囲（手順は下）。
- 本物の Retina の画面での `captureVisibleTab` の倍率。
- ログインが要る PDF を side panel の fetch で取れるか。日本語の PDF の抽出。
- 履歴を複数の block に並べたとき、前の部分で prompt cache が効くか（同じ本文を 1 block で送り直した場合だけ確かめた）。
- tool で 40 万字を返す場合と、1M token を超える入力の error の形。
- `view-source:` で返らない理由。

## 手で確かめる手順（選択範囲）

1. `brave://extensions` で開発者モードを on にし、`sidePanel`・`scripting` と `<all_urls>` を持つ拡張を unpacked で読み込む。side panel には、active タブで `getSelection().toString()` と `document.hasFocus()` を読むボタンを置く。
2. 適当な記事を開き、toolbar の拡張を押して side panel を開く。
3. 本文の段落をドラッグで選び、side panel の textarea をクリックして数文字打ってからボタンを押す。選んだ文字が返り、page の `hasFocus()` が false であることを確かめる。
4. ページの textarea の中の語をダブルクリックで選び、3 と同じ操作をする。
