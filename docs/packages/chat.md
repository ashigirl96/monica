# Chat の agent と画面

`packages/chat` の contract と `ChatAgent` と ui。Chrome Extension の side panel の Chat の質問に、Backend が起こす claude が答える。決定の理由は ADR-0028・0029・0030・0031・0032・0033・0034 にある。画面は末尾の「ui」にある。

## contract（root は `chat`）

```
prepare   → void
ask       { question, page: Page, history: { question, answer, page: PageSnapshot }[] } → event iterator of ChatEvent   errors: CHAT_BUSY, NOT_AUTHENTICATED, USAGE_LIMIT, AGENT_FAILED
```

- `prepare` は spare（下の「spare」）を起こし、その initialize を待たずに返る。spare が既にあるか、claude を 4 つ持っていれば何もしない。Chrome Extension は Backend の不在の確かめにもこれを呼ぶので、速く返す。
- `ask` は 1 回の質問への応答の stream（`docs/packages.md` の contract の規約 7）。`ChatEvent` は `type` の判別 union で、最初に `{ type: 'snapshot', page: PageSnapshot（screenshot を除く）, omitted: { pages, turns } }` を 1 つ流し、続けて `{ type: 'text', text }`（答えの文字の delta）を流す。client は届いた順に `text` をつなぐ。result を受けたら stream を閉じる。形は下の「Page Snapshot」にある。
- 答えの間に `{ type: 'retry', attempt }`（API の再試行）と `{ type: 'usage', utilization, rateLimitType, resetsAt? }`（plan の使用量の警告）も流す。下の「失敗」にある。
- `question` は 1 字以上。`page` と `PageSnapshot` の `url` と `title` は省略できるただの文字列で、形を検めない。`chrome://` などの Browser Tab では side panel から見えず、`file://` のページもあるため。
- `history` は Chat の前の問答を古い順に並べたもの。turn ごとに、その質問の `snapshot` で返した `PageSnapshot` を持つ。Backend は Chat を持たず、送られた履歴をそのまま prompt にする（ADR-0031）。
- `.errors()` で宣言するのは `CHAT_BUSY`・`NOT_AUTHENTICATED`・`USAGE_LIMIT`・`AGENT_FAILED`。`CHAT_BUSY`（status 429）は、claude を 4 つ持っているときと、本文にしているページが 4 つあるときの `ask` に、iterator を返す前に投げる。本文にする Worker は 1 つ最長 30 秒 CPU と memory を使うため。ほかの 3 つは下の「失敗」にある。
- `MAX_ASK_BODY_BYTES`（50MB）は、token の口が受ける body の上限。token の口の `Bun.serve` に `maxRequestBodySize` で渡し、超えた body には 413 が返る（`docs/packages/backend.md` の「token の口の 2 つの token」）。side panel は送る前に大きさを見て、超える分を「読めなかった」にするので、413 は side panel からは届かない。
- PDF の bytes は `page.content` の `pdf`（`z.file()`）に入れる。RPCLink は input のどこにある `Blob` も multipart の別の part で送るので、base64 で膨らませない（note の画像の upload と同じ形）。
- router は CLI に出さず、token の口に `{ workbench, task, job, chat }` で載せる。Chrome Extension は Native Messaging の host から受け取った chat の token で呼び、その token は chat の procedure だけを開く（下の「Backend の探し方」、ADR-0034）。ブラウザの口には載せない。change stream は持たない（ADR-0031）。

## createChatAgent

`createChatAgent({ home, claudePath?, htmlWorker?, pdfWorker?, cMaps? })` は `stop()` だけを持つ `ChatAgent` を返す。Ledger と違い記録を持たないので、Ledger とは呼ばず、`start()` も無い。

- `$MONICA_HOME/chat` を `mkdirSync(…, { recursive: true, mode: 0o700 })` で作り、claude の cwd にする。
- `claudePath` は claude の場所で、SDK の `pathToClaudeCodeExecutable` に渡す。省けば渡さず、SDK が node_modules の platform package（`@anthropic-ai/claude-agent-sdk-darwin-arm64` など）の claude を使う。
  - release の Backend は、Shell が env の `MONICA_CLAUDE_PATH` で渡す `.app` の `Contents/MacOS/claude` を渡す。compile した binary は node_modules の claude を解決できないため。`install-app` が同じ lockfile の platform package から写したもの（`docs/packages/dev-loop.md` の「release build と install」、ADR-0032）。
  - dev の Backend は env を受けないので省く。
- `htmlWorker` と `pdfWorker` は HTML と PDF を本文にする Worker の module の URL、`cMaps` は pdf.js の cMap の folder（下の「Page Snapshot」の「本文への変換」と「PDF の本文」）。省けば、Worker は packages/chat の `src/html-worker.ts` と `src/pdf-worker.ts`、`cMaps` は packages/chat から解いた node_modules の `pdfjs-dist/cmaps` になる（`src/page/snapshot.ts` の `defaultReaders`）。`bun test` はどれも省いて動く。
  - compile した Backend はどれも解けないので、Backend は自分の隣の `html-worker.ts` と `pdf-worker.ts`（build の entrypoint）と、`--asset` で同梱した `cmaps` を渡す（`docs/packages/backend.md` の「起動と終了」）。
- `stop()` は同期で、持っている claude すべて（spare を含む）に SIGKILL を送り、spare の時限を消す。Backend の `exit()` は `process.exit(0)` まで await を挟まずに進むため。
- procedure の handler が使う `prepare` と `ask` は、型に出さずに `internals(chatAgent)` で引く（`docs/packages.md` の「server entry の形」）。router の context は `{ chatAgent }`。
- chat は他の domain を import せず、他の domain からも import されない。前者は `.oxlintrc.json` の override が、後者は package.json が守る。table は持たないが、空の journal を持つ（`docs/packages/migration.md`）。

## claude の options と env

`ask` 1 回につき SDK の `query()` を 1 回起こし（spare があれば spare の `query()`）、答え終えたら閉じる。options は次のとおりで、user の環境を読まず、tool を持たない（ADR-0033）。

| option | 値 | 理由 |
|---|---|---|
| `model` | `'haiku'` | |
| `effort` | `'low'` | |
| `thinking` | 渡さない | Haiku 5.5 は thinking を切れない。thinking の delta は流さない |
| `systemPrompt` | 文字列 | Claude Code の preset を置き換える（ADR-0033）。SDK は 1 要素の配列にして initialize で渡す |
| `title` | `'Chat'` | 渡さないと CLI が最初の user message を丸ごと入れた title 生成の request を別に出し、使用量が倍になる。`persistSession: false` なのでどこにも残らない |
| `cwd` | `$MONICA_HOME/chat` | `$MONICA_HOME` の `backend.json` と `monica.db` を作業の場所に入れない（ADR-0033） |
| `settingSources` | `[]` | user の settings・CLAUDE.md・hooks を読まない |
| `skills` | `[]` | |
| `strictMcpConfig` | `true` | claude.ai の connector を切る（env の `ENABLE_CLAUDEAI_MCP_SERVERS=false` と組） |
| `tools` | `[]` | |
| `disallowedTools` | `['mcp__*']` | |
| `permissionPrompts` | `'none'` | |
| `persistSession` | `false` | session の jsonl を書かない |
| `settings` | `{ crossSessionInbound: 'refuse' }` | 他の session の message を断る |
| `includePartialMessages` | `true` | text の delta を受ける |
| `pathToClaudeCodeExecutable` | deps の `claudePath` | 省かれたら渡さない（ADR-0032） |
| `spawnClaudeCodeProcess` | 下の「claude の持ち方」 | |
| `env` | 下の表 | |

SDK の `env` は `process.env` に重ならず丸ごと置き換わる。claude の env は次のものと、SDK が足す 3 つ（`CLAUDE_CODE_ENTRYPOINT`・`CLAUDE_AGENT_SDK_VERSION`・`CLAUDE_CODE_SDK_READS_SESSION_STATE`）だけになる。`PATH`・`TMPDIR`・`LANG`・proxy・CA と、認証と接続先を替える env は通さない。

| key | 値 | 理由 |
|---|---|---|
| `USER` | Backend の env から写す | keychain の account 名を決める。無いと login を読めない |
| `HOME` | Backend の env から写す | テストで home を分けられるようにする |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | `false` | claude.ai の connector を切る |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | memory を読まない |
| `CLAUDE_CODE_RESTRICTED` | `1` | inbox の socket を開かず、他の session の `ListAgents` に出ない |
| `DISABLE_AUTOUPDATER` | `1` | 同梱した claude が自分を更新しない |
| `CLAUDE_CODE_MAX_RETRIES` | `4` | API の一時的な失敗で待たせる時間を約 8 秒にする |

`USER` と `HOME` は claude を起こすたびに `process.env` から読み、値の無い key は入れない。

## claude の持ち方

- `spawnClaudeCodeProcess` で、`node:child_process` の `spawn` に SDK の `command`・`args`・`cwd`・`env`・`signal` を渡して起こし、その child を持つ。SDK は `query()` と `startup()` の呼び出しの中で同期に spawn する。
- 子の stderr は pipe にし、読んだそばから Backend の stderr に流しながら、末尾の 2,000 字を持つ（`src/claude.ts`）。claude が result の前に落ちたとき、その末尾を `AGENT_FAILED` の `detail` に足す。`spawnClaudeCodeProcess` で起こすと SDK は子の stderr を読まず、SDK の error の message に `stderr: …` は付かない。読まずに放った pipe は詰まって子が止まるので、必ず読み続ける。
  - SDK は子の `exit` で error を投げ、`exit` は stderr の残りより先に届くことがある。末尾を読む前に pipe が閉じるのを待つ。claude の子が pipe を握ったままでも失敗を返せるよう、待つのは 200ms までにする。
- SIGKILL を送る契機は 4 つ。SDK の `close()` や `AbortController` に任せると、turn の途中の子が 2〜3 秒 delta を出し続けて残り、使用量を使うため（ADR-0031）。
  - handler の `signal` の abort。listener を付けてすぐ送る。generator の `finally` は走っている `await` が終わるまで走らないため。side panel を閉じたときや、client が止めたとき。
  - result を受ける前に generator が閉じられたとき（`finally`）。`createRouterClient` の client で `for await` を break したときは `signal` が abort せず、generator の `return` だけが走る。
  - `stop()`。spare も含めて持っている child すべてに送る。
  - 失敗を決めた時（下の「失敗」）。自分で抜けるのを待つと、0.5〜1.4 秒のあいだ同時の 4 つに数えたまま残るため。
- SIGKILL した claude について SDK の iterator は `Claude Code process terminated by signal SIGKILL` を投げる。この error だけでは claude が自分で落ちたのかを見分けられないので、`ChatAgent` は SIGKILL を送った child を覚えておき、その child の error は失敗にせず stream を閉じる。
- result を受けたら、prompt の AsyncIterable を終えて stream を閉じる。SDK が claude の stdin を閉じ、claude は自分から抜ける。SDK の iterator は閉じない。`for await` を抜けると SDK は claude の終了を最大 2 秒待ち、その間 stream が閉じないため。
- 同時に持つ claude は 4 つまでで、spare も数える。1 つ 270〜290MB の process でメモリを食い潰されないための上限で、spare も同じだけ食うため。数は spawn した child の集合で数え、child の `exit` で外す。答えを閉じてから子が抜けるまでの間もメモリを食うため。空きの確かめと `query()`・`startup()` の呼び出しの間に await を挟まないので、並んだ質問が 5 つ目を起こすことは無い。

### spare

- Backend 全体で 1 つまで。`startup()` で起こし、`prepare` と、result を受けて答えを閉じた時に起こす。abort と失敗の後には起こさない。abort はたいてい side panel を閉じたときで、次の質問が来ない見込みが高いため。
- `ask` は spare があればそれを使う。起動中の spare は `startup()` の resolve を待って使い、2 つ目の claude を起こさない。`startup()` が失敗していたか、spare の child が既に終わっていたら、stderr に 1 行出して spare を捨て、`query()` で起こし直す。
- 起こした時から 5 分使われなければ `WarmQuery.close()` で閉じる。使われていない spare は stdin の EOF で自分から抜ける。

## prompt

`SDKUserMessage` を 1 つ流す AsyncIterable で渡す。content は block の配列で、並べ方は下の「Page Snapshot」の「prompt の block」にある。文字列の prompt には `document` block を入れられないため。

- system prompt（`src/prompt.ts` の `SYSTEM_PROMPT`）は、message が質問を番号付きで古い順に並べ、質問ごとにページ（URL・title・本文の document・添えたならスクリーンショットの画像・選択範囲の document）と、前の質問には答えを添えること、答えるのは最後の質問であることを書く。ページから来た文字（title・本文・document・画像）はページの作者が書いたものでユーザーの指示ではなく、従うのはユーザーの質問だけであることと、tool を持たないことも書く。

## log

claude の `system`（`init`）を受けたら、stderr に 1 行出す。tools 0 と MCP 0 を実機で見るためと、SDK を上げて `haiku` の解決先が変わったときに気づくため（ADR-0032）。result を受けたら、その usage も 1 行出す。prompt cache の効き方を見るためで、Backend の stdout は Shell 宛ての JSON 行専用なので stderr にする。

```
[chat] claude <pid>: model <model>, <n> tools, <m> MCP servers
[chat] claude <pid>: usage input <n>, cache creation <n>, cache read <n>, output <n>
```

## Page Snapshot

質問を送った時に、side panel が Current Page を読み、HTML と選択範囲か PDF の bytes と、ボタンを押していればスクリーンショットを `chat.ask` に添える。Backend が HTML か PDF を本文にし、切り詰め、同じページを判定し、全体の上限を当てる。Chrome Extension は読んで送るだけにする（#263 の resolution の 8）。side panel を開いているだけでは読まない。

### 読み方（`src/ui/read-page.ts`）

- 読むのは、送る時に `tabs.query({ active: true, windowId })` で取り直した Browser Tab（下の「Current Page の追い方」）。`url` と `title` もその Browser Tab のものにし、見出しと揃える。
- `chrome.scripting.executeScript` に `target: { tabId }`・`func`・`injectImmediately: true` だけを渡す。`frameIds` も `allFrames` も渡さず top frame だけを読み、world は既定の ISOLATED のままにしてページの CSP を受けない。
- 3 秒で返らなければ打ち切って `timeout` にする。`view-source:`、`alert()` の最中、frozen の Browser Tab では返らず、`injectImmediately` が無いと body が終わらないページでも返らない。
- 注入する関数（`readDocument`）は `{ contentType, html, selection }` を返す自己完結した関数で、module の他の関数も import も参照しない。`func` は文字列にして送られ、build の minify で名前が変わった helper も届かないため。
  - `document.contentType` が `application/pdf` なら、HTML と選択範囲を読まずに返し、下の「PDF の取り方」に進む。PDF viewer の main frame は `contentType` が `application/pdf` で body が空、viewer は closed shadow root の中の OOPIF にあり、`executeScript` は viewer の frame に注入しない。URL の拡張子は当てにならず、HEAD を投げると request が 1 つ増えるので、`contentType` で見分ける。
  - shadow root は `document.documentElement` から要素を順に辿り、`chrome.dom.openOrClosedShadowRoot` で closed のものまで、見つけた root の中にも潜って集める。`html` は `document.documentElement.getHTML({ shadowRoots })` で、shadow root は `<template shadowrootmode>` として書き出される。
  - 選択範囲は top frame の `getSelection().toString()`。activeElement が textarea か、`type` が `text`・`search`・`url`・`tel` の input なら、その `selectionStart`・`selectionEnd` で読む。別の場所を選んだ後も古い値が残るので、focus のある欄だけを読む。それ以外の input（`password` など）に focus があれば読まない。空なら `selection` を送らない。
- `executeScript` が reject したら `restricted` にし、`detail` に error の message を入れる。
- 送る時に見出しが出していた Current Page の URL と title（`CurrentPageWatch.shown()`）を、読んだページと並べて `ChatStore` に返す。読み終える前に止めた質問の履歴に入れる（下の「失敗」の「再試行と履歴」）。
- 送る前に、input を `JSON.stringify` した UTF-8 の bytes に、PDF の bytes と 1MiB（oRPC の包みの分）を足して `MAX_ASK_BODY_BYTES` と比べる。File は `JSON.stringify` で `{}` になるので、PDF の大きさは `size` で足す。超えたら、古い turn のページから本文・選択範囲・スクリーンショットを外し、本文は `too-large` にする（`chat-store.ts`）。長い Chat では履歴だけで上限を超えうるためで、Backend が字数の上限で落とすのと同じく Current Page より先に古いページを外す。turn は落とさない。`same` が turn の番号で前のページを指すため。前のページを全部外しても超えたら、Current Page の `html`・`pdf`・`selection` を外して `too-large` にし、前のページは収まる分だけ外す。それでも超えたら、前のページを全部外し、古い turn の質問と答えを「（大きすぎて送れなかった）」に置き換える。Current Page の raw の HTML は本文より何倍も大きいので、前の問答より先に外す。side panel が外した前のページと問答は `omitted` に数えない。

#### PDF の取り方

- `fetch(tab.url, { credentials: 'include' })` で Browser Tab の URL を取り直す。`<all_urls>` の host permission の host へは CORS を受けずに取れる。cookie を付けるのは、ログインが要る PDF も取れる見込みがあるため（下の「確かめていないこと」）。
- 30 秒で返らなければ打ち切り、fetch を abort して `fetch-failed`（detail `no response within 30 seconds`）にする。body を読み終えるまでを 30 秒に含める。fetch が abort に応えなくても、その終わりを待たない。
- 止めるボタンか「新しい Chat」で質問を止めたら、fetch を abort し、その終わりを待たずに読むのをやめる（`ChatStore` が `readPage` に渡す `signal`）。止めた後も PDF を読み続けて memory と帯域を使わないため。
- status が ok でなければ `fetch-failed`（detail `HTTP <status>`）。先頭が `%PDF-` でない応答も `fetch-failed`（detail `the response is not a PDF`）にする。ログインが要る PDF は、ログインのページの HTML が 200 で返りうる。
- body は上限まで読んでやめる。上限は、body の上限から、PDF を除いた input（`question` と、前のページの本文・選択範囲・スクリーンショットを外した `history`）を `JSON.stringify` した UTF-8 の bytes と 1MiB を引いた値で、`chat-store.ts` が `readPage` に渡す。`Content-Length` が上限を超えていれば body を読まずに cancel し、読んでいる途中で超えても cancel して、どちらも bytes を送らずに `too-large` にする。50MB を超える PDF は、履歴を含めた body が上限に収まらない PDF として読む。上限に収まった bytes は、送る前の大きさの確かめ（上）でもう一度、page の `url` と `title` を含めて比べる。
- PDF の選択範囲は送らない。viewer の frame には注入できず、top frame の `getSelection()` は viewer の中の選択を返さない。
- 取れた bytes は `{ kind: 'pdf', pdf: File }` で送る。pdf.js は Chrome Extension に同梱しない（本文にするのは Backend）。
- 扱わないもの: HTML のページに `<embed>` や `<iframe>` で埋めた PDF（top frame の HTML だけを読む）、画像だけの PDF の OCR。

### スクリーンショット（`src/ui/screenshot.ts`・`read-current-page.ts`）

入力欄のボタン（下の「画面の組み立て」）を押した質問にだけ、Current Page の Browser Tab の表示領域のスクリーンショットを添える。既定は添えず、送るか「新しい Chat」を押すとボタンは外れる。表示領域の外（ページ全体）や範囲を選んで撮ることはしない。

- **撮る時機**: 送る時に `chrome.tabs.captureVisibleTab(windowId, { format: 'png' })` で撮る。`windowId` は Current Page の追跡（下の「Current Page の追い方」）が持つ side panel の window の id。写るのは Browser Tab の表示領域だけで、side panel と toolbar は写らない。
- **gesture と quota**: 撮れるかを決めるのは `<all_urls>` の host permission だけで、user gesture は要らない。gesture が効くのは quota だけで、gesture の外では約 1 秒に 2 回を超えると `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` の error になり、gesture から 4.8 秒以内は何回でも通った（Chromium の `tabs_api.cc` の `ShouldSkipQuotaLimiting()` が `user_gesture()` を見る）。そこで送る操作（送るボタンの click と Enter の keydown）の handler の中で、最初の `await` より前に呼ぶ。`ChatStore.ask` が await を挟まずに `readPage({ screenshot })` を呼び、`readCurrentPage` が Browser Tab を取り直す前に撮り始め、`executeScript` と並べて待つ。`executeScript` の 3 秒を待ってから撮ると gesture の窓を食う。
- **打ち切り**: 撮るのにも 3 秒の timeout を付け、超えたら撮れなかったことにする。
- **大きさと形式**: PNG で撮り、side panel の `createImageBitmap` と `OffscreenCanvas` で、撮った画像の px を side panel の `devicePixelRatio` で割った大きさ（`shrunkSize`、小さくするだけで拡大しない）に縮め、1 度だけ JPEG（quality 0.8）にする。JPEG の劣化を 2 度かけない。ページの zoom が 100% でないときは CSS px とずれるが、model に渡す大きさとしては困らない。1280×800 で約 1,300 token。contract には `data:` の頭を外した base64 で載せる。
- **撮れないとき**: 撮れなくても質問は送れる。`screenshot` を外し、`screenshotFailed: { reason }` に error の message（打ち切りは `the Browser Tab did not answer within 3 seconds`）を入れ、読めた本文はそのまま送る。PDF の Browser Tab のように、本文は読めても撮れない場面で本文まで捨てないため。本文を読めずに撮れたとき（`executeScript` の timeout など）は、読めなかったこととスクリーンショットの両方を送る。ユーザーが添えると決めたものを落とさない。`chrome://` などは `captureVisibleTab` も `executeScript` も同じく失敗するので、たいていは「ページを読めませんでした」と並ぶ。
- **送り返さない**: Backend は `snapshot` の `page` にスクリーンショットを入れない。contract の `snapshot` の `page` は `PageSnapshot` から `screenshot` を除いた型で、oRPC の output の検証が落とす。数百 KB の文字列を往復させないため。side panel が、自分の撮ったものを履歴の turn の `page` に足す。
- **持ち続ける**: 履歴に残る間は、どのスクリーンショットも次の質問から毎回送り直し、どれを落とすかは Backend の全体の上限に任せる。再試行（#281）は失敗した質問の input をそのまま送り直し、撮り直さないので、side panel は送ったスクリーンショットを、答えが返るか履歴から外れるまで持つ。
- **縮小**: 質問の吹き出しの上に、送ったものを幅 160px までで出す。manifest の CSP の `img-src 'self' data:` の下で描けるよう、`data:image/jpeg;base64,…` の URL にする。押しても何もしない。
- **Retina と PDF**: 撮った画像の px は Browser Tab の `innerWidth` × DPR で、縮めると `innerWidth` に戻る（`--force-device-scale-factor=2` で真似た。本物の Retina の画面ではまだ確かめていない）。PDF の Browser Tab も撮れ、viewer の toolbar ごと写る（下の「ui」の「実機で確かめたこと」）。

### 形（`src/contract.ts`）

```
Page          { url?, title?, selection?: string, content: { kind: 'html', html } | { kind: 'pdf', pdf: File } | Unreadable, screenshot?: string, screenshotFailed?: { reason } }
PageSnapshot  { url?, title?, selection?: { text, truncated }, content?: { kind: 'text', source: 'html' | 'pdf', text, truncated } | { kind: 'same', turn } | Unreadable, screenshot?: string, screenshotFailed?: { reason } }
Unreadable    { kind: 'unreadable', reason: 'restricted' | 'timeout' | 'too-large' | 'fetch-failed' | 'unparsable', detail? }
snapshot      { type: 'snapshot', page: PageSnapshot から screenshot を除いたもの, omitted: { pages, turns } }
```

- `screenshot` は JPEG の base64（`data:` の頭を外した文字列、zod の `base64()`）。GLOSSARY の Page Snapshot はスクリーンショットを含むので、turn の直下ではなく `page` の中に置く。`image` block の `source.data` にそのまま入り、縮小の `data:` の URL もそこから作れる。
- `snapshot` の `page` に、side panel が送ったスクリーンショットを足したものが `history` の各 turn の `page` になる。`snapshot` の届かなかった答えの turn は、`content` の無い `{ url, title }` に送ったスクリーンショットを足したものになる。
- `same` の `turn` は、その request の `history` の添字。失敗した質問は履歴に入らず、Backend が落とす古い turn も side panel の配列は変えないので、一度返した添字は後の request でも同じ turn を指す。
- `omitted` は、今回渡さなかった古いページと問答の数。問答ごと落とした turn のページは `turns` にだけ数える。

### 本文への変換（`src/page/extract.ts`・`html.ts`・`worker.ts`・`snapshot.ts`・`src/html-worker.ts`）

- HTML を `<!doctype html><html>` と `</html>` で包んで linkedom で DOM にし、`defuddle/node` の `Defuddle` に `markdown: true`・`useAsync: false`・`removeImages: true` を渡して Markdown にする。`useAsync: false` は、本文の無いページで第三者の API を呼ばせないため。jsdom 30 と happy-dom 20 では defuddle が失敗し、失敗しても例外を投げずに body 全体を返すので使わない。`defuddle/full` は Bun で Markdown 変換が失敗するので使わない。
- defuddle は linkedom を見込んで `<template shadowrootmode>` を展開するので、open と closed の shadow root の中の文字が本文に残る。nav と footer は本文に入らない。
- Markdown から URL を落として文字を残す。
  - リンク `[text](href "title")`（href の `(` `)` は `\(` `\)`、空白を含む href は `<…>`）は `text` にする。`\[` で始まる文字の `[` はリンクと読まない。
  - 画像 `![alt](src)` は消す。`removeImages` は `img` を消すが、`picture` の `source` は turndown が Markdown の画像にする。
  - turndown が生の HTML のまま残したもの（colspan のある表、`sup`）の中の `<a>` は tag だけを外し、`iframe`・`video`・`audio` は要素ごと消す。ほかの HTML の tag は残す。
- 本文と選択範囲は 10 万字（`MAX_PAGE_CHARS`）で切り、先頭を残して `truncated` を立てる。字は JS の文字列の `length` で数え、surrogate pair は割らない。
- 見えない文字は落とそうとしない。stylesheet の class で隠した文字は defuddle も残すので、`document` block と system prompt で受ける。
- 変換は claude を起こす前に行う。数百 ms で、spare から答えれば claude を並べて起こす得は小さいため。変換が例外を投げたら `unparsable`（`detail` に message）にして答えを続ける。
- linkedom と defuddle は Bun の Worker（`src/html-worker.ts`）で動かし、Backend の event loop を塞がない。defuddle は同期に走り、div を 3,000 段入れ子にしたページでは 23〜79 秒かかる。main thread で走らせると、その間 Backend は他の request に応えない。Worker は HTML 1 つごとに起こし、本文を返したら `terminate()` する（PDF と同じ `src/page/worker.ts` の `textInWorker`）。
- 本文にするのが 30 秒を超えたら、Worker の返事を待たずに `terminate()` して `unparsable`（detail `turning the HTML into text took more than 30 seconds`）にする。30 秒は PDF の本文と同じ上限で、質問を送ってから答えが始まるまでに、ページを本文にするのを待たせる長さの上限にあたる。普通のページは 0.1 秒かからず（2 万字の HTML で 48ms）、div を 1,000 段入れ子にしたページでも数秒で終わるので、打ち切るのは答えを待たせ続けるページだけになる。`chat.ask` の `signal` が abort したときも `terminate()` し、`unparsable` にせずに `ask` ごと止める。
- 本文が空なら `document` block を作らず、見出しに「本文の文字は無かった」と書く。知らせは出さない。

### PDF の本文（`src/page/pdf.ts`・`src/pdf-worker.ts`）

- pdf.js（pdfjs-dist の modern build、`pdfjs-dist`）は HTML と同じく Bun の Worker で動かし、Backend の event loop を塞がない。Worker は PDF 1 つごとに起こし、本文を返したら `terminate()` する。bytes の ArrayBuffer は transfer し、大きな PDF の memory を Backend に残さない。
- Bun の中の pdf.js は、Web Worker を作らずに fake worker を呼んだ側の thread で動かし、fake worker は `./pdf.worker.mjs` を動的に import する。compile した binary ではその import が解けないので、Worker の module（`src/pdf-worker.ts`）が `pdfjs-dist/build/pdf.worker.mjs` を静的に import して `globalThis.pdfjsWorker` に置く。pdf.js はそれを見つけて動的な import をしない。pdf.js の fake worker が動くのは Bun の Worker の thread で、Backend の main thread ではない。`bun run` の Backend でも compile した binary でも Bun の Worker で動いたので、main thread の fake worker には落としていない。
- Worker の module は top-level の `await` を持たない。`await` を `message` の listener より前に置くと、最初の message を取りこぼす。listener は `src/page/worker.ts` の `replyWithText` が置き、本文か error の message を返す。
- `getDocument` には `data`、`cMapUrl`（`cMaps` の folder、末尾に `/`）、`cMapPacked: true`、`verbosity: 0` を渡す。日本語の CID font の PDF は、埋め込まない font（`UniJIS-UCS2-H` など）だと cMap が無ければ本文が空になる。埋め込まない Helvetica の文字は `standardFontDataUrl` 無しで取れるので、`standard_fonts` は同梱しない。
- `verbosity: 0` で pdf.js の警告（`console.warn`、stderr）は出ないが、modern build は読み込みのたびに legacy build を勧める 1 行（`Warning: Please use the legacy build in Node.js environments.`）を stderr に出す。Worker ごとに 1 行出る。
- 本文は、ページごとに `getTextContent()` の item の `str` をつなぎ、`hasEOL` で改行し、末尾の空白を落とす。文字の無いページは飛ばし、ページの間に空行を入れる。pdf.js はページの外の字を本文に入れない。
- つないだ本文が 10 万字（`MAX_PAGE_CHARS`）を超えたら残りのページを読まず、HTML の本文と同じく先頭を残して切り、`truncated` を立てる。ちょうど 10 万字なら、続きがあるかを次のページで確かめる。
- PDF の本文は見出しや段落の構造を持たないので、本文の `document` の `context` に `Text extracted from a PDF, without its layout.` の行を足す。同じページの判定と全体の上限は HTML の本文と同じ。
- pdf.js が例外を投げた（壊れた PDF、パスワード付きの PDF、開けないページ）か、本文にするのが 30 秒を超えたら、Worker を `terminate()` して `unparsable`（`detail` に message）にする。`chat.ask` の `signal` が abort したときも `terminate()` し、`unparsable` にせずに `ask` ごと止める。

### 同じページ

- 1 回の request の中で、送られた `history` を新しい方から探し、`content` が `text` の turn のうち、URL が `#` から後ろを除いて一致し、切った後の本文が一致する最初の turn を `same` で指す。本文が一致していれば、hash だけ違う URL は同じページとみなす。
- `same` のときも選択範囲とスクリーンショットは添える。同じ URL と本文でも、スクロールで表示領域が変わるため。同じページだったことは side panel に知らせない。

### 全体の上限

- 前の問答、前のページの本文と選択範囲とスクリーンショット、今の質問と Page Snapshot の字の和を 20 万字（`MAX_ASK_CHARS`）に収める。スクリーンショットは 1 枚を 1,500 字と数える。URL と title は、ページが `pushState` と `document.title` で好きな長さにできるので、2,000 字と 500 字で切り詰めて数える。ページを落としても見出しに残るので、turn の問答の側に数える。Backend が足す見出しの決まった文は数えない。
- 超えたら、古い turn のページ（本文と選択範囲とスクリーンショット）から 1 つずつ落とす。1 ページを `document` と `image` の組で渡す形を崩さないよう、同じ質問のページの本文とスクリーンショットはまとめて落とす。それでも超えたら、古い turn の問答を 1 つずつ落とす。落としたスクリーンショットは `omitted.pages` に数え、別の知らせは足さない。
- 今の質問と Page Snapshot は落とさない。Current Page の Page Snapshot が `same` で指す turn も、ページと問答のどちらも落とさない。Current Page の本文がそこにしか無いため。今の分だけで 20 万字を超えても、そのまま送る。

### prompt の block（`src/page/prompt.ts`）

- turn ごとに、本文の `document`、スクリーンショットの `image`、選択範囲の `document`、見出しと質問の `text`、答えの `text` の順に並べ、古い turn から並べる。今の turn は答えの手前で終える。何も落とさなければ、n 問目の並びが n+1 問目の並びの頭とそのまま一致する。
- スクリーンショットの `image` は `{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }`。本文の `document` の隣に置き、本文が無い（読めなかった・同じページ・空）ときはそのページの block の先頭に来る。
- 本文の `document` は `{ type: 'document', source: { type: 'text', media_type: 'text/plain', data }, title, context }`。`title` は page の title の先頭 500 字で、無ければ省く。`context` は `URL: <url>` で、切り詰めたときは「先頭の 100,000 字だけ」の行を足す。API は `title` を 1〜500 字、`context` を 1 字以上とする。
- 選択範囲の `document` は `title` を `Selection: <page の title>`（title が無ければ `Selection`）にする。選択範囲もページの作者が書いた文字なので、質問の `text` に混ぜない。
- 見出しには「Question n」（`history` の添字 + 1）、URL、title（無ければ `unknown`）、本文を省いたこと（同じページ・上限で落とした）・切り詰めたこと・本文が空だったこと・読めなかった理由と、スクリーンショットを添えたこと、または撮れなかったことと `screenshotFailed` の理由を書く。答えは `document` に入れない。
- 問答を落としたら、先頭に落とした数を 1 行の `text` で置く。

### 知らせ（`src/ui/notice.ts`）

`snapshot` から、質問の吹き出しの下に淡い 1 行を作る。読めなかった・撮れなかった・切り詰めた・渡していない、の順に「。」でつなぐ。答えの場所に出す失敗とは分ける。

| `reason` | 決める側 | 当てる場面 | 文言 |
|---|---|---|---|
| `restricted` | side panel | `executeScript` が reject した（`chrome://`・Web Store・ブラウザ拡張のページ・top-level の `about:blank` と `data:`・`account.brave.com`・error のページ） | ページを読めませんでした（このページは Chrome Extension から読めません） |
| `timeout` | side panel | `executeScript` が 3 秒で返らない | ページを読めませんでした（3 秒以内に応えませんでした） |
| `too-large` | side panel | 送る前の大きさの確かめで外した。PDF が上限を超えて読むのをやめた | ページを読めませんでした（大きすぎます） |
| `fetch-failed` | side panel | PDF の fetch が失敗した、30 秒で返らない、status が ok でない、先頭が `%PDF-` でない | ページを読めませんでした（PDF を取得できませんでした） |
| `unparsable` | Backend | HTML か PDF の本文への変換が例外を投げた。変換が 30 秒を超えた | ページを読めませんでした（本文を取り出せませんでした） |

- `snapshot` の `page` に `screenshotFailed` があれば「スクリーンショットを撮れませんでした」。理由は出さない。
- 本文か選択範囲を切り詰めたら「本文を切り詰めました」「選択範囲を切り詰めました」（両方なら「本文と選択範囲を切り詰めました」）。
- `omitted` の和が 1 以上なら「古いページや問答 n 件を渡していません」。

### 確かめていないこと

- context menu から選択範囲を渡す経路、iframe の中の本文と選択（`allFrames`）。
- 本物のクリックで side panel の入力欄に focus を移した後も、ページの選択範囲が `selection` に入るか（CDP の操作でだけ確かめた）。
- ログインが要る PDF を side panel の fetch で取れるか。取れなければ、`fetch-failed`（ログインのページの HTML や ok でない status が返ったとき）か `unparsable`（`%PDF-` で始まるが pdf.js が開けないとき）に落ちる。headless の Brave 1.97 で、side panel の page の fetch に、PDF の host の cookie が付いたことだけは見た。
- 大きな PDF を Worker で読む間に Backend の event loop が止まらないか（確かめたのは小さな PDF だけ）。
- 本物の Retina の画面での `captureVisibleTab` の倍率（下の「実機で確かめたこと」は `--force-device-scale-factor=2` で真似た）。
- Enter の keydown が quota を外す user gesture になるか。side panel で式を評価して送る確かめ方では、gesture は評価の userGesture から来るので、本物の Enter の gesture は確かめられない。

## 失敗

質問に答えを返せないとき、side panel はその質問の答えの場所に日本語で理由を出し、どの失敗にも「再試行」のボタンを付ける。Backend に届かないことは、入力欄の上の帯でも知らせる（#269 の resolution）。読めなかった・切り詰めた・渡していないことの知らせ（上の「知らせ」）は質問の吹き出しの下に出し、答えの場所の失敗とは混ぜない。

### 失敗を決める（`src/chat-agent.ts`）

`ChatAgent` は SDK の message から失敗を決める。決めるのは `result` を受けた時で、`is_error` が true か `subtype` が `success` でなければ失敗にする。調べたどの失敗でも `assistant` の `error` の直後に `result` が来たので遅れは無く、`max_output_tokens` のように CLI が続きを頼む途中の message で早まって決めない。SDK がその 0.5〜1.4 秒後に投げる `Error("Claude Code returned an error result: …")` は待たず、claude を SIGKILL してから typed error を投げる。

code は上から順に当てる。

| code | status | 当てる失敗 | data |
|---|---|---|---|
| `USAGE_LIMIT` | 429 | その質問で最後に来た `rate_limit_event` の `rate_limit_info.status` が `rejected` で、`resetsAt` と `rateLimitType` を持つ | `{ rateLimitType, resetsAt }`（`resetsAt` は unix 秒） |
| `NOT_AUTHENTICATED` | 401 | 最後の `assistant` の `error` が `authentication_failed`・`oauth_org_not_allowed`・`verification_required` のどれか | なし |
| `AGENT_FAILED` | 500 | それ以外のすべて。`billing_error`・`account_on_hold`・`max_output_tokens`・`invalid_request`・`server_error`（再試行が尽きた 529・500・接続の失敗）・`rate_limit`（上限の header の無い 429）など | `{ detail }`: CLI の原文 |

- 上限の header の無い 429 も `rate_limit_event` は `rejected` になるが、`resetsAt` を持たない。API の一時的な失敗なので、`resetsAt` の有無で plan の上限と分ける。
- `rateLimitType` は enum にせず文字列にする。CLI が版ごとに足す値で data が schema を通らないと、typed error が `defined: false` になり、side panel が上限と分からなくなるため。
- `detail` は先頭 2,000 字で切る。side panel が詳しい行にそのまま出すため。
  - `result` があればその文字列にする。成功の形の `result` は `result`、`SDKResultError` は `errors` を改行でつないだもの。
  - `result` の前に SDK の iterator が投げたら、その message に claude の stderr の末尾（上の「claude の持ち方」）を足す。claude の場所に何も無い、起きてすぐ落ちた（`Claude Code process exited with code 1`）、答えの途中で落ちた、`initialize_timeout` がこれに当たる。
  - result 無しに iterator が終わったら、`claude exited before it answered` に stderr の末尾を足す。
- typed error は、それまで流した `snapshot`・`text`・`retry`・`usage` の後に投げる（`docs/packages.md` の contract の規約 7）。
- `chat.ask` の handler（`src/server.ts`）は、`ChatAgent` が投げた `ChatFailure` を宣言した error にし、ほかの想定外の error も `AGENT_FAILED` に包む。iterator を返す前（Page Snapshot の変換や claude の起動）に投げた error も同じに包む。素の `Error` は `INTERNAL_SERVER_ERROR`「Internal server error」になり、理由が消えるため。
- 自分で SIGKILL した claude の error は失敗にしない（上の「claude の持ち方」）。stream の abort と Backend の終了では、stream は error を投げずに閉じる。
- contract に載せないもの: Backend に届かない場合、古い chat の token の 401（`UNAUTHORIZED`）、body の上限の 413（`PAYLOAD_TOO_LARGE`）。413 は side panel が送る前に大きさを見て「読めなかった」にするので、side panel からは届かない。

### `retry` と `usage`

- `system` の `api_retry` が来るたびに `{ type: 'retry', attempt }` を流す。text の前か後かで分けない。CLI は API の stream が切れると答えを最初からやり直すので、side panel は途中の答えを消して描き直す。
- CLI が stream しない request に替えると、答えは `stream_event` の delta を伴わない `assistant` 1 つで届く。最後の `api_retry` の後に text の delta を流していないとき、`error` の無い `assistant` の text block をつないで 1 つの `text` で流す。delta を流した答えでは、`assistant` の text を重ねて流さない。
- `rate_limit_event` の `status` が `allowed_warning` で、`utilization` と `rateLimitType` があるとき、`{ type: 'usage', utilization, rateLimitType, resetsAt? }` を流す。Chat は答えるのを断らない。上限は Tab の agent と共有している。
- `CLAUDE_CODE_MAX_RETRIES=4`（ADR-0033）で、再試行が尽きるまでを約 8 秒にする。既定は 10 回・約 3 分で、その間は `api_retry` だけが来る。

### side panel の文言（`src/ui/failure.ts`）

side panel は `ORPCError`（`@orpc/client`）の `code` で分け、`data` は contract の `askErrors` の schema で `safeParse` して読む（task の `close-bench.ts` と同じ形）。Backend の `message` は出さず、文は chat の ui が作る。Backend に届かないことは、`chat.prepare` と `chat.ask` の失敗が、`TypeError`、`BackendUnreachable`（host が無い・落ちた・Backend が居ない）、`ORPCError` の `UNAUTHORIZED`（古い chat の token）のどれかであることで見分ける（`isUnreachable`、下の「Backend の探し方」）。止めるボタンの abort（`DOMException` の AbortError）は失敗にしない。

| 場面 | side panel が見るもの | 答えの場所に出す 1 行 | 詳しい行 |
|---|---|---|---|
| Backend に届かない | `chat.ask` の応答が届く前の `TypeError`・`BackendUnreachable`・`UNAUTHORIZED` | 「monica の desktop に届きませんでした」。入力欄の上に帯も出す | なし |
| 答えの途中で届かなくなった | `chat.ask` の応答が届いた後の `TypeError`（`snapshot`・`retry`・`text` の後） | 途中までの答えを残し「答えが途中で切れました」。帯も出す | なし |
| Claude Code の login が無い | `NOT_AUTHENTICATED` | 「Claude Code に login していません。terminal で claude を起こし、/login してください」 | なし |
| plan の上限 | `USAGE_LIMIT` | 「plan の 5 時間の上限に達しました。10:00 に戻ります」 | なし |
| 同時の claude の上限 | `CHAT_BUSY` | 「ほかの Chat が答えています」 | なし |
| 答えの途中の失敗 | 途中の答えの後の `AGENT_FAILED` | 途中までの答えを残し「答えが途中で切れました」 | `detail` |
| 再試行が尽きた API の失敗 | `retry` を受けた後の `AGENT_FAILED` | 「Anthropic の API に繋がりませんでした」 | `detail` |
| claude が起きない・落ちた・ほか | 上の 2 つに当たらない `AGENT_FAILED` | 「claude が答えを返せませんでした」 | `detail` |
| 宣言していない `ORPCError` | 上のどれでもない `ORPCError` | 「claude が答えを返せませんでした」 | `<code>: <message>` |
| `ORPCError` でも `TypeError` でもない error | 上のどれでもない error | 「claude が答えを返せませんでした」 | error の message |
| API の再試行を待つ間 | `retry` | 途中の答えを消し「Anthropic の API に繋がりません。再試行しています（n 回目）」。次の `text` から答えを描き直す | なし |
| 止めた | 止めるボタン | 途中までの答えの後に淡く「止めました」 | なし |
| 使用量の警告 | `usage` | 答えの下に淡く「plan の 5 時間の枠を 91% 使いました（10:00 に戻ります）」 | なし |

- `AGENT_FAILED` の 1 行目は、画面の途中の答え → その質問で受けた `retry` → それ以外、の順に選ぶ。code だけでは「途中で切れた」「API に繋がらない」「起きない」を分けられないが、side panel はその質問で受けた event を知っているため。`TypeError` は、`chat.ask` の応答が届いた後なら、途中の答えが無くても「答えが途中で切れました」にする。Backend には届いていたため。
- 時刻は side panel が動く Mac の時刻帯で、今日なら `10:00`、別の日なら `10月12日 16:27` と書く。使用率は四捨五入した % にする。`usage` に `resetsAt` が無ければ「（…に戻ります）」を省く。
- `rateLimitType` の呼び名は `five_hour` を「5 時間の」、`seven_day` を「週の」、`seven_day_opus` を「Opus の週の」、`seven_day_sonnet` を「Sonnet の週の」にし、ほかは呼び名を付けない（「plan の上限に達しました」）。知らない値でも文が壊れないようにするため。
- toast は使わない。toast は server の英語の message をそのまま出す形（`packages/ui/src/toast.ts`）で、失敗はその質問の答えの場所に出すため。

### 再試行と履歴（`src/ui/chat-store.ts`）

- 再試行のボタンは、最後の質問の失敗にだけ出す。押すと、その質問で送った `chat.ask` の input をそのまま送り直し、ページは読み直さず、PDF も fetch し直さず、スクリーンショットも撮り直さない。失敗した質問は最後の質問なので、その `history` は送った時から変わらず、Page Snapshot の中身（HTML・PDF の File・スクリーンショット）も同じ物を送れる。
- side panel は送った input を、答えが返るか、次の質問で履歴から外れるまで持つ。
- oRPC の `ClientRetryPlugin` は使わない。event iterator の途中の error で handler を最初から呼び直すので、途中まで流した値が client で重なる（research の §3）。side panel が自分で送り直す自動の再試行もしない。
- 失敗した質問は、再試行して答えが返るまで、後の質問の `history` に入れない。再試行せずに次の質問を送ったら、失敗した質問を履歴から外し、画面には残す。Backend が `snapshot` を返した後に失敗した場合も、その Page Snapshot を `history` に入れない。
- 止めた質問は、途中までの答えの後に空行を挟んで「（ユーザーが途中で止めた）」を付けて履歴に入れる。答えが空なら印だけにする。「続けて」と訊いたときの材料になる。Backend は答えの文字をそのまま prompt にするので、印も文字のまま claude に渡る。
- `snapshot` が届く前に止めた質問は、送ったページの URL と title（と添えたスクリーンショット）だけで履歴に入れる。Backend が本文にしたものが side panel に無いため。ページを読み終える前に止めたら、送った時に見出しが出していた Current Page の URL と title で入れる。
- 止めた質問には再試行を付けない。履歴に入り、「続けて」で続きを訊けるため。

### 止めるボタン

- 答えの間（送ってから stream が閉じるまで。最初の text の前と、再試行を待つ間も含む）、InputMessage の送るボタンを止めるボタン（label は「止める」）にする。入力欄に文字があっても止めるボタンにし、Enter では送らない。queue を消したので、答えの間に送れる先が無いため。
- 押すと side panel は `chat.ask` の stream を abort し、Backend は handler の `signal` の abort で子の claude を SIGKILL する（上の「claude の持ち方」）。side panel は押した後に届いた event を描かず、答えに「止めました」を淡く添える。`AbortController` だけでは、子が 2〜3 秒 delta を出し続けて残る。
- 答えの途中で「新しい Chat」を押したときも、同じく stream を abort する。
- ページを読んでいる間（PDF の fetch の最中）に押したときも、その fetch を abort する（上の「PDF の取り方」）。

### Backend の不在の帯（`src/ui/reach.ts`）

- side panel を開いた時の `chat.prepare` が届かなかったら（上の「side panel の文言」の `isUnreachable`）、入力欄の上に帯「monica の desktop が起動していません」を出す。`chat.ask` が同じく届かずに失敗したときも出す。
- 帯が出ている間は、5 秒おきと、side panel の window が `focus` を受けた時に `chat.prepare` で確かめ直す。届いたら（error の応答も届いたと数える）帯を消し、確かめ直しを止める。`chat.ask` に応答が届いた時も消す。5 秒おきと `focus` の `chat.prepare` は重なりうるので、後から始めた `chat.prepare` か `chat.ask` の結果が先に届いたら、前の `chat.prepare` の結果は捨てる。
- 帯は待たずに出す。帯を出している間しか定期的に呼ばないので、notes の画面のように bun --watch の再起動（約 100ms）で帯がちらつくことは無い。
- 帯が出ている間も送るボタンは押せる。Backend が居ない間も Chat は終わらない（ADR-0031、GLOSSARY の Chat）。

### Backend の探し方（`src/ui/native-host.ts`）

side panel は Backend の token の口を、Native Messaging の host から受け取った chat の token で呼ぶ（ADR-0034）。

- `viaNativeHost(host 名)` は RPCLink の `url` と `headers` を返す。どちらも RPC を呼ぶたびに `chrome.runtime.sendNativeMessage(host 名, {})` で host に問い合わせ、`{ port, token }` から `http://127.0.0.1:<port>/rpc` と `Authorization: Bearer <token>` を作る。引いた値は覚えない。Backend が起き直すと port も token も変わるため。
- oRPC は 1 回の呼び出しの `url` と `headers` に同じ options の object を渡すので、それを key にした WeakMap で、1 回の呼び出しの問い合わせを 1 回にする。oRPC が別の object を渡すようになっても、問い合わせが 2 回になるだけで、送り先は変わらない。
- service worker を経由せず、side panel の page から直に呼ぶ（ADR-0028 の「RPC は side panel の page から呼ぶ」と同じ）。
- host が見つからない（`Specified native messaging host not found.`）、host が落ちた（`Native host has exited.` など）、host が `{ error: 'not-running' }` を返した（Backend が居ない）は、`BackendUnreachable` を投げる。Backend が起き直す前の chat の token で呼んだ 401 は、client では `ORPCError` の `UNAUTHORIZED` になる。どれも `TypeError` と同じく「desktop に届かない」に数え、帯を出して 5 秒おきと focus の `chat.prepare` で確かめ直す（上の「Backend の不在の帯」）。確かめ直しも host に問い合わせ直すので、Backend が起き直していれば新しい port と token で届く。
- 同じ 401 でも、Claude Code の login が無い `NOT_AUTHENTICATED` は宣言した error で、Backend に届いている。code で分ける。

### 確かめたこと

- `CLAUDE_CODE_MAX_RETRIES=4` は効く。scratchpad の `Bun.serve` の proxy が、すべての `POST /v1/messages` に 529（`overloaded_error`）を返し、届いた時刻だけを記録した。`createChatAgent` の claude の場所には、`ANTHROPIC_BASE_URL` をその proxy に向けて本物の claude（SDK 0.3.293 の platform package）を `exec` する wrapper を渡した。
  - wrapper が受けた env に `CLAUDE_CODE_MAX_RETRIES=4` があった。
  - `retry` が attempt 1〜4 で届き、proxy に 5 回届いた（2〜5 回目は最初の request の 0.6・1.8・3.8・8.5 秒後）。
  - 最初の request から 8.5 秒で `AGENT_FAILED` になり、`detail` は「API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:<port>).」だった。
  - claude を起こしてから最初の request まで 3.0 秒かかった。
- 本物の side panel（Brave 1.97、headless、dev の Chrome Extension）で、Backend の居ない home で side panel を開くと帯が出た。同じ home の Backend をブラウザの口の port を付けて起こすと、5 秒以内に帯が消えた。
- side panel の page を Browser Tab で開いて（ui の「実機で確かめたこと」と同じ）、本物の claude で次を確かめた。
  - Backend の居ない間に「1 から 300 まで数字を 1 行ずつ書いて」を送ると、「monica の desktop に届きませんでした」と再試行のボタンと帯が出た。`TypeError` 以外なら「claude が答えを返せませんでした」と message が出るので、Chrome Extension の page の fetch の失敗も `TypeError` になる。
  - Backend を起こした後に再試行を押すと、同じ質問の答えが返った。plan の使用率が 96% のときで、答えの下に「plan の 5 時間の枠を 96% 使いました（9:40 に戻ります）」が出た（本物の `allowed_warning`）。
  - 答えが流れ始めてから止めるを押すと「止めました」が出て、3 秒後も答えは増えず、Backend を親に持つ claude は無かった。
  - 答えが流れ始めてから Backend の stdin を閉じると、途中までの答えと「答えが途中で切れました」、再試行のボタン、帯が出た。stream の途中で Backend が居なくなっても `TypeError` になる。
- Native Messaging（Brave 1.97、headless、dev の Chrome Extension、`bun run extension` が本物の場所に書いた dev の manifest）: Backend の居ない home で side panel を開くと帯が出た。同じ home に Backend を起こすと 5 秒以内に帯が消え、Backend を親に持つ spare の claude が起きた（host が返した port と chat の token で `chat.prepare` が届いた）。side panel の page を Browser Tab で開いて質問を送ると、答えが返った。
- compile した CLI（`scripts/build.ts` と同じ flag）を host として起こし、枠付きの `{}` を渡すと、約 10ms で枠付きの `{ port, token }` が返り、token は `backend.json` の chat の token だった。新しく compile した binary の最初の 1 回は約 790ms かかった。Backend の居ない home では `{ error: 'not-running' }` が返った。
- 本物の Backend の token の口で、chat の token は `chat.ask` に届き（不正な input の 400）、`workbench.layout.get`・`task.list`・`job.list` は 401 だった。全権の token はどれも通り、token 無しはどれも 401 だった。`/rpc/chat/../workbench/layout/get` と `/rpc/chat/%2e%2e/workbench/layout/get` を TCP に直に書いても、chat の token では 401 だった。ブラウザの口の `chat.ask` は 404 で、`note.daily.dates` は今どおり 200 だった。
- side panel の target で、Backend の居ない口への `fetch` は `TypeError: Failed to fetch` で reject した（headless の Brave の side panel そのもので `extension-panel.ts eval` で評価した）。
- side panel の page を Browser Tab で開いて、本文を送り終えない PDF（navigation には PDF を返し、fetch には `%PDF-` の頭だけを送って止まる URL）で送り、読み終える前に止めるを押すと、配る側でその fetch の request が abort された。「新しい Chat」でも同じだった。止めた後に別のページで送ると、body の `history[0]` は `{ question, page: { url, title }, answer: '（ユーザーが途中で止めた）' }` で、`url` と `title` は送った時の見出しの PDF のものだった。
- 再試行は、スクリーンショットも PDF も取り直さない。headless の Brave の side panel で、Backend を止めて PDF の Browser Tab でスクリーンショットを添えて送り、Backend を起こして再試行すると、送り直した body は multipart の boundary を除いて最初の body と同じで、PDF の URL への fetch も起きなかった。

### 確かめていないこと

- release の Shell が書いた manifest で、Dock から起こした普段の Brave の side panel が `.app` の CLI を host に起こして答えを受けるか（PR の確認でユーザーが確かめる）。
- dev の host（`bun` で動く CLI）の 1 回の問い合わせにかかる時間。
- 帯が出ている間に、ページを click してから side panel を click すると、side panel の window が `focus` を受けて 5 秒を待たずに帯が消えるか。
- 期限切れの OAuth token の 401 で、CLI が token を更新して答えるか（CLI のコードには更新して再試行する分岐がある）。
- 本物の plan の上限の 429。research は header を真似た 429 で確かめた。
- spare から答えたときの本物の失敗と `initialize_timeout`。偽の claude では、spare の login 無しも `NOT_AUTHENTICATED` になった。
- CLI が合成の user message で続きを頼む場合（research の「毎回 RST で切る」）に、`retry` で消した前半が戻るか。CLI は途中までの答えを残して続きだけを頼むので、前半が戻らないことがある。

## テスト

- `src/chat.test.ts` が `createRouterClient(router, { context: { chatAgent } })` を通して確かめる。DB は使わない。本文への変換の失敗は、error を返す Worker（`src/page/fixtures/failing-worker.ts`）を `htmlWorker` に渡して作る。defuddle は自分の失敗を握って body 全体を返し、例外を投げる本物の HTML が無いため。
- div を 3,000 段入れ子にしたページを本文にしている間に `prepare` がすぐ返ることを、`src/chat.test.ts` が本物の Worker で確かめる。本文になる前に abort して Worker を止める。
- HTML と PDF の 30 秒の打ち切りは、返事をしない Worker（`src/page/fixtures/silent-worker.ts`）を `defaultReaders` で渡し、`setTimeout` を `spyOn` して callback を手で呼ぶ（`CODING_STANDARDS.md` の「テスト」）。いずれ返事をする本物の Worker では、打ち切りが Worker の返事を待つ実装でも通る。
- 途中の失敗が RPCLink の client に `ORPCError` の `code` と `data` で届くことは、`apps/backend/src/main.test.ts` が process の Backend の token の口に chat の token で繋いで確かめる。
- 本文への変換は `src/page/snapshot.test.ts` が `src/page/fixtures/` の HTML（`getHTML` が書き出す、document element の中身の形）で、同じページと全体の上限と block の並び（スクリーンショットの `image` の置き場所と 1,500 字の数え方を含む）は `src/page/prompt.test.ts` が `PageSnapshot` を直に組んで確かめる。どちらも claude を起こさない。
- PDF の本文は `src/page/pdf.test.ts` が、Worker を通して確かめる。PDF は `src/page/test-pdf.ts` の `testPdf(pages)` が bytes を組み、binary の file を repo に置かない。`latin` のページは埋め込まない Helvetica、`japanese` のページは埋め込まない `HeiseiKakuGo-W5` と `UniJIS-UCS2-H` で書き、cMap が無いと日本語が落ちる。`'missing'` のページは無い object を指し、読めば pdf.js が例外を投げるので、残りのページを読まないことをそれで確かめる。ページの大きさは行の長さと数に合わせて広げる。pdf.js はページの外の字を本文に入れないため。
- claude は `src/fake-claude.ts` の偽の claude に差し替える。テストは拡張子の無い `/bin/sh` の wrapper を一時 directory に書いて `claudePath` に渡す。wrapper は `@monica/chat/testing` の `writeFakeClaude(dir, recordPath, scenario?)` が書き、Backend のテスト（`apps/backend/src/main.test.ts` と `browser-listener.test.ts`）も使う。wrapper は `exec "<process.execPath>" "<fake-claude.ts の path>" "<記録の file>" <場面> "$@"` の 1 行。SDK は path が `.js`・`.mjs`・`.ts`・`.tsx`・`.jsx` で終わると `bun` か `node` を名前で起こすが、claude の env には `PATH` が無い。拡張子の無い path は直に起こす。wrapper の `/bin/sh` は env に `PWD`・`SHLVL`・`_` を足す。
- 偽の claude は次のように話す。
  - stdin の `control_request` に `control_response`（`subtype: success`、`response: {}`）を返す。
  - `user` の message を受けたら、`system`（`init`）、`stream_event`（`content_block_delta` の `text_delta` を 3 つと `thinking_delta` を 1 つ）、`assistant`、`result`（`subtype: success`）を 1 行ずつ書く。
  - stdin の EOF で抜ける。
  - argv、env、cwd、pid、`initialize` の request、`user` の content、EOF を、記録の file に JSON 行で書く。
  - 質問に `HOLD` を含むと、最初の text の delta の後に止まり、stdin の EOF と SIGTERM では抜けない。居なくなれば SIGKILL で終わっている。30 秒で自分から抜ける。
- 失敗の場面は wrapper ごとに `scenario`（`FakeScenario`）で選ぶ。`ChatAgent` に場面を渡す口は足さない。偽の claude は、research（`docs/research/chat-failures.md` の §2）で本物の claude が流した message の並びを真似る。
  - `not-logged-in`: `assistant`（`error: authentication_failed`）、`result`（`is_error`）の後、5 秒 exit しない。`ChatAgent` が SDK の error を待たずに決め、claude を止めることを見る。
  - `usage-limit`: `rejected` で `resetsAt`（`FAKE_RESETS_AT`）と `five_hour` を持つ `rate_limit_event`、`assistant`（`rate_limit`）、`result`（429）。
  - `throttled`: `api_retry` の後に `resetsAt` の無い `rejected`（`rateLimitType` はある）、`assistant`（`rate_limit`）、`result`（429）。
  - `overloaded`: `api_retry` を 4 回、`assistant`（`server_error`）、`result`（529）。`billing`: `assistant`（`billing_error`）と `result`。
  - `max-output-tokens`: text の delta を 2 つ流した後に `assistant`（`max_output_tokens`）と `result`。
  - `exit-at-start`: stdin を読む前に stderr に 1 行書いて exit 1。`exit-mid-answer`: text の delta の後に stderr に 1 行書いて exit 1。
  - `restart`: text の delta、`api_retry`、最初からの delta、`result`。`unstreamed`: text の delta、`api_retry`、delta の無い `assistant`、`result`。
  - `usage-warning`: 普段の答えの `result` の前に `allowed_warning`（`utilization` 0.91）の `rate_limit_event`。普段の答え（`answer`）は `allowed` の `rate_limit_event` を流す。
- claude の場所に何も無い場面は、`createChatAgent` に一時 directory の無い path を渡して作る。
- 起こした claude は、テストの process の子のうち生きているもの（`ps` の ppid と stat）で数える。SDK は呼び出しの中で同期に spawn するので、`ask` と `prepare` が返った直後に数えれば、起こしていないことも確かめられる。
- 5 分の時限は、`setTimeout` を `spyOn` で捕まえ、300000ms の callback を手で呼ぶ。
- テストは偽の claude が居なくなるのを待ってから home を消す（`docs/packages/dev-loop.md` の「検査と CI」）。`ChatAgent` を自分で作るテストは自分の子を数え、Backend の process を起こすテストは `@monica/chat/testing` の `untilFakeClaudesExit(dir)` で、wrapper を書いた dir を command line に持つ process が居なくなるのを待つ。`stop()` も Backend の終了も SIGKILL を送るだけで、居なくなるのを待たないため。

## 実機で確かめたこと

SDK 0.3.293 と同梱の claude 2.1.293 で、dev の Backend を `env -i`（`HOME` と `USER` は本物）で起こして確かめた。SDK を上げるときはやり直す。

- `prepare` で、Backend を親に持つ claude（node_modules の platform package のもの）が 1 つ起きる。その pid の `~/.claude/sessions/<pid>.json` に `messagingSocketPath` が無く、`/tmp/cc-socks/<pid>.sock` も無い。
- `ask` で `text` の event が流れて stream が閉じる。`[chat]` の行の pid は spare の pid で、model は `claude-haiku-5-5`、tools 0、MCP servers 0。最初の text まで約 0.5 秒。答えた後に新しい spare が起きる。
- 最初の `text` で client が abort すると、答えていた claude は約 10ms で居なくなり、新しい spare は起きない。
- `~/.claude/projects` に `<MONICA_HOME>/chat` の path から作った directory ができず、`~/.claude.json` の `projects` に `<MONICA_HOME>` の path が入らない。
- spare を起こした Backend に SIGTERM を送ると、spare が居なくなる。
- SIGKILL した claude は `~/.claude/sessions/<pid>.json` を残し、次に claude が起きたときに消える。
- prompt cache（Page Snapshot を足した後、約 2 万字の fixture のページで 1 問目から 5 分以内に 3 問続けた）: usage は 1 問目が cache creation 5,424・cache read 0、2 問目（同じページで `same`）が 5,824・0、3 問目（`chrome://version`）が 6,204・0。質問ごとに claude を起こし直す形では、前の問答の部分は cache read にならなかった。理由は確かめていない。
- 2 万字の HTML（本文 13,928 字）の変換から `snapshot` が届くまで、`bun run` の Backend で 48ms、compile した Backend で 36ms。Worker に移した後は、`src/page/fixtures/article.html` の `snapshot` が呼んでから 106ms と 37ms で届き、本文は両方の Backend で同じだった。compile した Backend で、div を 3,000 段入れ子にしたページを本文にしている間（23 秒）、`chat.prepare` は 2ms で返った。
- PDF（pdfjs-dist 6.4.299）: `testPdf` で組んだ 2 ページの日本語と英語の PDF を RPCLink で `chat.ask` に添えると、`bun run` の Backend でも、`scripts/build.ts` と同じ command で compile した Backend でも、最初の `snapshot` の本文が同じになった（呼んでから届くまで 67ms と 31ms）。compile した Backend は Worker を `/$bunfs/root/pdf-worker.ts` から、cMap を `/$bunfs/root/cmaps` から読み、migrate を終えて起き、SPA も今までどおり `dist` から配った。

## ui

`packages/chat/src/ui` は Chrome Extension の side panel の Chat の画面。`@monica/chat/ui` から出すのは root の `ChatApp` と、RPCLink の `url` と `headers` を作る `viaNativeHost` だけで、apps/extension の side panel の main.tsx が host 名を渡した RPCLink を作って `client.chat` を渡す（`docs/packages/extension.md`）。ui は `@monica/ui` に依存しない。

### fluid-functionalism の写し

部品は fluid-functionalism（MIT、`fluid/LICENSE`）の commit `bf9ece4` の registry から、`packages/chat/src/ui/fluid/` に写した。upstream を追う仕組みは持たない。

- 写したのは 14 ファイル: `chat-message.tsx`、`input-message.tsx`、`thinking-indicator.tsx`、`button.tsx`（Base UI 版）、`hooks/use-touch-primary.tsx`、`lib/` の `utils.ts`・`springs.ts`・`font-weight.ts`・`shape-context.tsx`・`size-context.tsx`・`type-scale.ts`・`icon-context.tsx`・`surface-classes.ts`・`surface-context.tsx`。CSS は `fluid/typeset.css`（`.typeset`）と `fluid/shimmer.css`（`.shimmer-text` と keyframes）を、fluid-functionalism の `app/globals.css` から写した。
- 写さないもの: Tooltip、use-fluid-hover、fluid-hover-highlight、popup、file-thumbnail。Button の loading の spinner の keyframes も、使わないので写さない。
- 写すときの直し:
  - `"use client"` を消し、import を拡張子付きの相対 path にし、oxfmt を当てた。
  - InputMessage は history を残し、添付・queue・suggestions・placeholder の suggestion を消した。`leftSlot` と `rightSlot` は ReactNode だけを受ける。queue を消したので、`status` が `streaming` で `onStop` を渡した間は、送るボタンをいつも止めるボタンにし、Enter でも送らない（上の「失敗」の「止めるボタン」）。
  - history の添字の 2 か所は、範囲外を分岐で扱う。新しい Chat で history が縮んでも、古い添字で `undefined` を入れない。
  - ChatMessage から、file-thumbnail を使う添付の表示を消した。
  - ThinkingIndicator はその場で日本語にした（「考えています」「ページを読んでいます」「まとめています」）。英語版は残さない。
  - 画面に出る英語の文言は日本語にした（送るボタンの「送る」、止めるボタンの「止める」、textarea の aria-label の「質問」）。
  - Button の asChild の `cloneElement` に ref を渡す所は、oxlint の `react/refs` を理由付きで止めた。
- 写した元と比べるときは、import の書き換えと oxfmt だけを当てた控えを repo の外に作り、`git diff --no-index` で比べる（`docs/packages/note-ui.md` の「旧 Monica のコードを移すとき」と同じ）。

### 字と色と CSS

- 字と色は fluid の token と、同梱の Inter Variable（`@fontsource-variable/inter/opsz.css`）。dark は OS に従い、切り替えの UI は持たない。
- apps/extension の globals.css が、`@import "tailwindcss"`、Inter、`packages/chat/src/ui` を指す `@source`、fluid の token・`@theme inline`・type scale・base・focus・scrollbar を持つ。dark は `light-dark()` と `color-scheme: light dark` と `prefers-color-scheme` の media query で切り替え、fluid の `.light`・`.dark` の class と `@custom-variant dark` は持ち込まない。
- `packages/chat/src/ui` の CSS は Tailwind の指示を含まず、token を定義せずに読むだけにする。使う component が import する（`answer.tsx` が `fluid/typeset.css` と `answer.css`、`thinking-indicator.tsx` が `fluid/shimmer.css`）。`.typeset` は `@layer components` に入るので、side panel の main.tsx は globals.css を `ChatApp` より先に import し、Tailwind の layer の順を先に決める。
- `answer.css` の直し: `.typeset :is(pre, .typeset-scroll)` に `contain: inline-size`、`.typeset` に `overflow-wrap: anywhere` を当て、表・コードブロック・長い URL が吹き出しを広げないようにする。`.typeset :is(strong, b, h1〜h6, th)` に `font-weight: 600` を当てる。typeset は太さを `font-variation-settings` だけで付けるので、可変軸の無い日本語のフォントでは見出しが太くならないため。

### 画面の組み立て

- 並べ方は prototype の B。質問は ChatMessage の右の吹き出し、答えは ChatMessage に `w-full max-w-full items-stretch` で幅いっぱいに入れる。`max-w-full` だけでは、表とコードブロックだけの答えで吹き出しが潰れた（`contain: inline-size` で両方を幅の計算から外しているため）。質問の吹き出しに、その質問の Current Page は出さない。
- 上端の見出し（`page-header.tsx`）は Current Page の title と host を出し、右端に「新しい Chat」を置く。host の行の `title` 属性に URL を持つ。host の無い URL（`file:` など）は URL をそのまま出し、URL も title も見えない Browser Tab は「読めないページ」と出す。favicon は出さない。外の画像は CSP の `img-src` で止まり、`_favicon` には `favicon` の権限が要るため。
- 答えは use-stick-to-bottom（`chat-scroll.tsx`）で下端に張り付き、上へスクロールすると外れて「↓ 最新へ」を出す。
- 最初の `text` が届くまで ThinkingIndicator を出す。答えている間は送らず、送るボタンは止めるボタンになる。入力欄には打てる。
- InputMessage の `leftSlot` に、スクリーンショットを添えるボタン（lucide の `Camera`、名前は「スクリーンショットを添える」）を置く。押している間は `aria-pressed` と Button の `active` の色で示す。mousedown の既定の動作を止めて focus を入力欄に残し、押した後の Enter がこのボタンを押し直さずに質問を送るようにする。
- 送ったスクリーンショットの縮小は、質問の吹き出しの上に右寄せで出す（上の「スクリーンショット」）。
- 失敗は答えの場所に、途中までの答えの後に赤い 1 行と、CLI の原文の詳しい行（等幅の淡い字）と「再試行」のボタンで出す。止めた答えには「止めました」、再試行を待つ間の 1 行と使用量の警告は淡い字で出す。文言は上の「失敗」にある。
- 帯「monica の desktop が起動していません」は、入力欄の上に `destructive` の色で出す。
- 読めなかった・切り詰めた・渡していないことの知らせ（上の「Page Snapshot」の「知らせ」）は、質問の吹き出しの下に右寄せの淡い 1 行で出し、答えの場所の失敗とは分ける。

### Chat の状態（`chat-store.ts`）

React に依らない `createChatStore(client)` が Chat を持ち、`ChatApp` は `useSyncExternalStore` で描くだけにする。DOM の無い bun test で送受信を確かめるため。

- Chat は side panel の document の memory にだけあり、window ごとに 1 つ。「新しい Chat」を押すか side panel を閉じると終わり、どこにも残さない。Backend が居なくなっても終わらない（ADR-0030・0031）。
- `open(readPage, focus)` は side panel を開いた時に `ChatApp` の effect が 1 回呼び、`chat.prepare` を呼んで spare を起こさせる。届かなければ帯を出す（上の「失敗」の「Backend の不在の帯」）。`focus` は `ChatApp` が渡す `window` で、帯の間はその `focus` の event でも確かめ直す。返す関数で確かめ直しを止める。dev の StrictMode で 2 回呼ばれても、Backend が spare を 1 つに保つので害は無い。
- `ask` は、送る時に `readPage({ screenshot, maxPdfBytes, signal })` で Current Page を読み直して `page` に入れ、答え終えた問答を古い順に `history` に入れて `chat.ask` を呼ぶ。`readPage` は await を挟まずに呼び、送る操作の user gesture の中で撮り始める。`ChatApp` が渡す `readPage` は `read-current-page.ts` の `readCurrentPage` で、撮り始めてから Browser Tab を取り直して `read-page.ts` で読む（上の「Page Snapshot」）。`maxPdfBytes` は PDF を読む上限（上の「PDF の取り方」）で、Current Page のスクリーンショットは読むのと並べて撮るので数えず、送る前の大きさの確かめが数える。答えている間は送らずに false を返し、スクリーンショットのボタンも外さない。答えの途中で Current Page が替わっても、delta はその質問の答えに足す。
- 送った input は、答えが返るか次の質問を送るまで持ち、`retry` が `readPage` を呼ばずにそのまま送り直す。`stop` は stream を abort し、止めた印を付けて履歴に入れる（上の「失敗」の「再試行と履歴」）。
- `snapshot()` の `withScreenshot` がボタンの状態で、`toggleScreenshot` が切り替える。`ask` が送ったら外す。
- 送ったスクリーンショットは、読み終えた時に質問の entry の `screenshot` に入れて縮小を出す。
- 届いた `snapshot` の `page` に送ったスクリーンショットを足して、その問答の turn の `page` として履歴に入れ、`snapshot` から作った知らせを質問の entry の `notice` に入れる。
- `startNewChat` は流れている stream を `signal` で abort し、問答と履歴を空にし、スクリーンショットのボタンを外す。abort の後に届いた delta は描かない。Backend は abort でその claude を止める。
- client の型 `ChatClient` は contract から導いた `ContractRouterClient<typeof contract>`（note の ui の `client.ts` と同じ形、ADR-0002）。token の口への oRPC の client の `chat` がそのまま入り、テストは偽の client を渡す。

### Current Page の追い方（`current-page.ts`）

- `watchCurrentPage(onChange)` は、最初の `tabs.query({ active: true, currentWindow: true })` で side panel を載せた window の id と Browser Tab を取る。side panel の page からは、別の window に focus があってもこの window が返る。
- `tabs.onActivated` はその window の event だけを見る。`tabs.onUpdated` は Current Page の Browser Tab の event だけを見て、tab の url と title が前に出したものと違えば出し直す。pushState と hash の変更も url の変化として届く。chrome:// へ移ったときは url も title も無い event だけが届くので、変化の中身ではなく tab の値で比べる。
- 権限は `tabs` も `webNavigation` も足さない。`<all_urls>` の host permission で http・https・file のページの url と title が見える。
- `read()` は送る時に `tabs.query({ active: true, windowId })` で Browser Tab を取り直して返す。見出しの追跡が event を取りこぼしても、読んで送るページを違えない。
- `shown()` は見出しに出している Current Page の URL と title を返す。送る時に `readCurrentPage` が読むのと並べて `ChatStore` に渡す。
- `windowId()` は side panel を載せた window の id を返し、`captureVisibleTab` に渡す。最初の `tabs.query` が返る前は undefined で、そのときは `windowId` を省いて呼ぶ（side panel からは同じ画像になる）。
- 止めると listener を外し、読み途中の結果も捨てる。

### markdown

- 答えは react-markdown と remark-gfm で描き、`.typeset` をかぶせる。表は `.typeset-scroll` で包む。コードブロックに色は付けない。
- 画像は読み込まず、`[画像: alt] URL` を文字で出す。URL に Chat の中身を載せた画像を読み込ませないため。manifest の CSP の `img-src 'self' data:` も外の画像を止める。
- リンクにするのは `http:` と `https:` の URL だけで、`<a target="_blank" rel="noreferrer">` で新しい Browser Tab に開き、文字の後ろに `new URL(href).host` を淡く出す。target の無い `<a>` は side panel から開かない。ほかの scheme（`javascript:`、`mailto:`、相対 URL など）は文字で出す。

### テスト

- DOM の環境は入れない（`docs/packages/note-ui.md` の「テスト」と同じ）。
- `current-page.test.ts` は `fake-chrome.ts` の偽の `chrome.tabs` で確かめる。偽物は `globalThis.chrome` に置いてテストの後に外し、`query` の `active`・`windowId`・`currentWindow` を本物と同じく絞る。chrome:// へ移ったときの url も title も無い `onUpdated` も出せる。
- `read-page.test.ts` は同じ偽物の `chrome.scripting.executeScript` で確かめる。偽物は注入された関数を走らせず、`readings` に置いた結果を返すか、reject するか、返らない。省いた `contentType` は `text/html` になる。渡された injection は `injections` に残る。注入する関数そのもの（shadow root と選択範囲）は DOM が要るので、実機で確かめる。3 秒と 30 秒の打ち切りは `setTimeout` を `spyOn` して callback を手で呼ぶ。PDF の fetch は `fetch` を `spyOn` した偽物で、読まれた chunk の数を数える body を返す。打ち切りと止める操作は、`signal` にも応えずに返らない偽物で確かめる（`CODING_STANDARDS.md` の「テスト」）。`signal` で reject する偽物では、fetch の終わりを待つ実装でも通る。
- `read-current-page.test.ts` は同じ偽物の `chrome.tabs.captureVisibleTab` と、偽の `createImageBitmap`・`OffscreenCanvas`・`devicePixelRatio` で、撮る時機・大きさと形式・撮れないとき・読めずに撮れたときを確かめる。偽の `captureVisibleTab` は `screenshots` に置いた大きさの偽の PNG を返すか、reject するか、返らない。呼ばれた引数は `captures` に残る。偽の canvas は画像を描かず、書き出した形式と quality と大きさを JSON にした Blob を返す。本物の縮小は bun test に canvas が無いので実機で確かめ、大きさの計算（`shrunkSize`）は `screenshot.test.ts` が純関数として確かめる。撮るのの 3 秒の打ち切りは、`executeScript` の 3 秒の timer と混ざらないよう、`screenshot.test.ts` が `takeScreenshot` を直に呼んで確かめる。
- `chat-store.test.ts` は偽の client で確かめる。偽の答えの stream は `signal` に応えず、test が流した delta をそのまま渡すので、abort の後に届いた delta を描かないことを確かめられる。RPCLink の client と同じく、`@orpc/client` の `AsyncIteratorClass` で返す。偽の `readPage` は渡された `{ screenshot }` と PDF の上限と `signal` を記録し、`ask` が返る前に呼ばれたかと、再試行が読み直さないことと、止めたら読むのをやめさせたかを見られる。読み終えない `page` も返せる。
  - 偽の client は、Backend の宣言した error を `@orpc/client` の `ORPCError`（`defined: true`、contract の `askErrors` の status と message）で、届かないことを `TypeError` で投げ分ける。ui の entry は server を import できないので、router を in-process で呼べないため。
  - 失敗の文言は store の entry の `failure` で確かめる。時刻の期待値は local の `Date` から作り、時刻帯に依らせない。
  - 帯の 5 秒おきの確かめ直しは `setInterval` を `spyOn` で捕まえて callback を手で呼び、focus は `open` に渡した `EventTarget` に `focus` の event を出す。
- `native-host.test.ts` は、`fake-chrome.ts` の偽の `chrome.runtime.sendNativeMessage` と、本物の RPCLink と `viaNativeHost` で確かめる。Backend は、oRPC の `implement(contract)` の chat を載せ、違う token には hono の `bearerAuth` と同じく 401 を返す `Bun.serve` で偽る。偽の `sendNativeMessage` は `nativeHost` に置いた返事を返し、置いていなければ host の manifest が無いときと同じ message で reject する。呼ばれた host 名と message は `nativeMessages` に残る。呼ぶたびに問い合わせ直して、その時の port と token で呼ぶこと、host が無い・落ちた・Backend が居ない・古い chat の token のどれでも帯が出ること、帯の確かめ直しが新しい token で届いて帯を消すことを見る。
- `answer.test.tsx` は `react-dom/server` の `renderToStaticMarkup` で markdown の描画を確かめる。react-dom は devDependency。

### 実機で確かめたこと

Brave 1.97 で確かめた。

- 新しい profile の headed の Brave で action から side panel を開くと、side panel は窓の右に出て、Brave の sidebar（icon の列）は一緒に出なかった。
- dev の side panel で `current-page.ts` を編集すると HMR で届くが、開いている side panel の listener は前の module のままだった。Current Page の追い方を確かめ直すときは、side panel を閉じて開き直す。
- Page Snapshot（headless の Brave、dev の side panel の page を Browser Tab で開き、別の agent-browser の session で読む Browser Tab を active にして送った）:
  - script で `attachShadow({ mode: 'closed' })` した要素の中の文字は、body の `html` に `<template shadowrootmode="closed">` で入り、本文に残った。page の script で選んだ 1 文は、side panel の入力欄に打った後も `selection` に入った。
  - `chrome://version` は `restricted`（`detail` は `Cannot access a chrome:// URL`）になり、知らせが出て答えも返った。
  - `view-source:` は、Enter から約 3.3 秒後に `timeout` の body を送った。`view-source:` は CDP の `Page.navigate` では開けず、新しい Browser Tab としてなら開けた。
- PDF（同じく side panel の page を Browser Tab で開いて送った。PDF は scratchpad の http server が配った）:
  - `testPdf` の日本語の PDF の Browser Tab で「この PDF の合言葉は？」と送ると、PDF の URL に `Sec-Fetch-Dest: empty` の GET が 1 つ出て、`chat.ask` は multipart で送られた。`data` の part の `page.content` は `{ kind: 'pdf', pdf: {} }` で `selection` は無く、File の part に PDF の bytes が入った。haiku は「この PDF の合言葉は「桜餅」です。」と答え、次の質問の `history[0].page` は `source: 'pdf'` の本文を持ち、同じ PDF は `same` になった。
  - 60MB の `%PDF-` の file は、`Content-Length` で読まずに止め、body は JSON だけで `page.content` が `too-large` だった。
  - navigation（`Sec-Fetch-Dest: document`）には PDF、fetch には HTML を 200 で返す URL は、`fetch-failed`（`the response is not a PDF`）になり、吹き出しの下に「ページを読めませんでした（PDF を取得できませんでした）」が出た。
  - side panel の page の fetch に、PDF の host に置いた cookie が付いた。
- スクリーンショット（同じ確かめ方。side panel の page の Browser Tab は裏に回り、Current Page の Browser Tab が表にある）:
  - 本文に無い `QX-4821` を canvas にだけ描いたページで、ボタンを押して「画面に見えるコードは？」と送ると、haiku の答えが `QX-4821` を含んだ。JPEG の `image` block を CLI がそのまま API へ送り、model が中身を読めた。body の `page.screenshot` は JPEG で、headless（DPR 1）で 756×475（ページの `innerWidth`×`innerHeight`）、26,112 byte。吹き出しの上に縮小が出て、送った後の `aria-pressed` は false。
  - 続けてボタンを押さずに訊くと、body の `page` に `screenshot` が無く、`history[0].page.screenshot` が 1 問目に送ったものと同じ文字列だった。
  - `--force-device-scale-factor=2` で起こした Brave では、撮った PNG が 2400×1850（`innerWidth` 1200 の 2 倍）、縮めた JPEG が 1200×925 だった。
  - Backend を止めて `chrome://version` で送ると、body の `page.content` が `restricted`（`Cannot access a chrome:// URL`）、`page.screenshotFailed.reason` が `The 'activeTab' permission is not in effect because this extension has not been in invoked.` だった。
  - PDF の Browser Tab（Brave の PDF viewer）は撮れた。viewer の toolbar と縮小の列ごと写る。
- スクリーンショットの quota（headless の Brave の side panel そのもので、`extension-panel.ts eval` で送った）: Backend を止めた状態で、ボタンを押して送る式を 0.3 秒おきに 3 回評価すると、680ms の間に 3 回とも撮れ、どの body にも JPEG があり `screenshotFailed` は無かった。Backend が答えている間は、2 回目の click が送るボタンではなく止めるボタンを押す（上の「失敗」の「止めるボタン」）ので、続けて送る確かめは Backend を止めて、送った質問がすぐ失敗する状態で行う。
