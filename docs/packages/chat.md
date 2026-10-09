# Chat の agent と画面

`packages/chat` の contract と `ChatAgent` と ui。Chrome Extension の side panel の Chat の質問に、Backend が起こす claude が答える。決定の理由は ADR-0028・0029・0030・0031・0032・0033 にある。画面は末尾の「ui」にある。

## contract（root は `chat`）

```
prepare   → void
ask       { question, page: Page, history: { question, answer, page: PageSnapshot }[] } → event iterator of ChatEvent   errors: CHAT_BUSY
```

- `prepare` は spare（下の「spare」）を起こし、その initialize を待たずに返る。spare が既にあるか、claude を 4 つ持っていれば何もしない。Chrome Extension は Backend の不在の確かめにもこれを呼ぶので、速く返す。
- `ask` は 1 回の質問への応答の stream（`docs/packages.md` の contract の規約 7）。`ChatEvent` は `type` の判別 union で、最初に `{ type: 'snapshot', page: PageSnapshot（screenshot を除く）, omitted: { pages, turns } }` を 1 つ流し、続けて `{ type: 'text', text }`（答えの文字の delta）を流す。client は届いた順に `text` をつなぐ。result を受けたら stream を閉じる。形は下の「Page Snapshot」にある。
- `question` は 1 字以上。`page` と `PageSnapshot` の `url` と `title` は省略できるただの文字列で、形を検めない。`chrome://` などの Browser Tab では side panel から見えず、`file://` のページもあるため。
- `history` は Chat の前の問答を古い順に並べたもの。turn ごとに、その質問の `snapshot` で返した `PageSnapshot` を持つ。Backend は Chat を持たず、送られた履歴をそのまま prompt にする（ADR-0031）。
- `.errors()` で宣言するのは `CHAT_BUSY`（status 429）だけ。claude を 4 つ持っているときの `ask` に、iterator を返す前に投げる。claude が落ちたときの error は型にせず、SDK の iterator が投げた error がそのまま oRPC の `INTERNAL_SERVER_ERROR` として流れる。
- `MAX_ASK_BODY_BYTES`（50MB）は、ブラウザの口が受ける body の上限。ブラウザの口の 2 つの `Bun.serve` に `maxRequestBodySize` で渡し、超えた body には 413 が返る。
- router は CLI に出さず、ブラウザの口にだけ `{ note, chat }` で載せる。token の口には載せない。change stream は持たない（ADR-0028・0031）。

## createChatAgent

`createChatAgent({ home, claudePath? })` は `stop()` だけを持つ `ChatAgent` を返す。Ledger と違い記録を持たないので、Ledger とは呼ばず、`start()` も無い。

- `$MONICA_HOME/chat` を `mkdirSync(…, { recursive: true, mode: 0o700 })` で作り、claude の cwd にする。
- `claudePath` は claude の場所で、SDK の `pathToClaudeCodeExecutable` に渡す。省けば渡さず、SDK が node_modules の platform package（`@anthropic-ai/claude-agent-sdk-darwin-arm64` など）の claude を使う。
  - release の Backend は、Shell が env の `MONICA_CLAUDE_PATH` で渡す `.app` の `Contents/MacOS/claude` を渡す。compile した binary は node_modules の claude を解決できないため。`install-app` が同じ lockfile の platform package から写したもの（`docs/packages/dev-loop.md` の「release build と install」、ADR-0032）。
  - dev の Backend は env を受けないので省く。
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
- 子の stderr は Backend の stderr に流す（`stdio` の 3 つ目を `'inherit'`）。`spawnClaudeCodeProcess` で起こすと SDK は子の stderr を読まないので、pipe にすると詰まって子が止まる。
- SIGKILL を送る契機は 3 つ。SDK の `close()` や `AbortController` に任せると、turn の途中の子が 2〜3 秒 delta を出し続けて残り、使用量を使うため（ADR-0031）。
  - handler の `signal` の abort。listener を付けてすぐ送る。generator の `finally` は走っている `await` が終わるまで走らないため。side panel を閉じたときや、client が止めたとき。
  - result を受ける前に generator が閉じられたとき（`finally`）。`createRouterClient` の client で `for await` を break したときは `signal` が abort せず、generator の `return` だけが走る。
  - `stop()`。spare も含めて持っている child すべてに送る。
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

質問を送った時に、side panel が Current Page を読み、HTML と選択範囲と、ボタンを押していればスクリーンショットを `chat.ask` に添える。Backend が HTML を本文にし、切り詰め、同じページを判定し、全体の上限を当てる。Chrome Extension は読んで送るだけにする（#263 の resolution の 8）。side panel を開いているだけでは読まない。

### 読み方（`src/ui/read-page.ts`）

- 読むのは、送る時に `tabs.query({ active: true, windowId })` で取り直した Browser Tab（下の「Current Page の追い方」）。`url` と `title` もその Browser Tab のものにし、見出しと揃える。
- `chrome.scripting.executeScript` に `target: { tabId }`・`func`・`injectImmediately: true` だけを渡す。`frameIds` も `allFrames` も渡さず top frame だけを読み、world は既定の ISOLATED のままにしてページの CSP を受けない。
- 3 秒で返らなければ打ち切って `timeout` にする。`view-source:`、`alert()` の最中、frozen のタブでは返らず、`injectImmediately` が無いと body が終わらないページでも返らない。
- 注入する関数（`readDocument`）は `{ html, selection }` を返す自己完結した関数で、module の他の関数も import も参照しない。`func` は文字列にして送られ、build の minify で名前が変わった helper も届かないため。
  - shadow root は `document.documentElement` から要素を順に辿り、`chrome.dom.openOrClosedShadowRoot` で closed のものまで、見つけた root の中にも潜って集める。`html` は `document.documentElement.getHTML({ shadowRoots })` で、shadow root は `<template shadowrootmode>` として書き出される。
  - 選択範囲は top frame の `getSelection().toString()`。activeElement が textarea か、`type` が `text`・`search`・`url`・`tel` の input なら、その `selectionStart`・`selectionEnd` で読む。別の場所を選んだ後も古い値が残るので、focus のある欄だけを読む。それ以外の input（`password` など）に focus があれば読まない。空なら `selection` を送らない。
- `executeScript` が reject したら `restricted` にし、`detail` に error の message を入れる。
- 送る前に、input を `JSON.stringify` した UTF-8 の bytes に 1MiB（oRPC の包みの分）を足して `MAX_ASK_BODY_BYTES` と比べる。超えたら今のページの `html` と `selection` を外して `too-large` にする（`chat-store.ts`）。履歴は削らない。
- PDF の Browser Tab は分けない。viewer の DOM は空なので本文は空になる（#279 が分ける）。

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
Page          { url?, title?, selection?: string, content: { kind: 'html', html } | Unreadable, screenshot?: string, screenshotFailed?: { reason } }
PageSnapshot  { url?, title?, selection?: { text, truncated }, content?: { kind: 'text', text, truncated } | { kind: 'same', turn } | Unreadable, screenshot?: string, screenshotFailed?: { reason } }
Unreadable    { kind: 'unreadable', reason: 'restricted' | 'timeout' | 'too-large' | 'unparsable', detail? }
snapshot      { type: 'snapshot', page: PageSnapshot から screenshot を除いたもの, omitted: { pages, turns } }
```

- `screenshot` は JPEG の base64（`data:` の頭を外した文字列、zod の `base64()`）。GLOSSARY の Page Snapshot はスクリーンショットを含むので、turn の直下ではなく `page` の中に置く。`image` block の `source.data` にそのまま入り、縮小の `data:` の URL もそこから作れる。
- `snapshot` の `page` に、side panel が送ったスクリーンショットを足したものが `history` の各 turn の `page` になる。`snapshot` の届かなかった答えの turn は、`content` の無い `{ url, title }` に送ったスクリーンショットを足したものになる。
- `same` の `turn` は、その request の `history` の添字。失敗した質問は履歴に入らず、Backend が落とす古い turn も side panel の配列は変えないので、一度返した添字は後の request でも同じ turn を指す。
- `omitted` は、今回渡さなかった古いページと問答の数。問答ごと落とした turn のページは `turns` にだけ数える。

### 本文への変換（`src/page/extract.ts`・`snapshot.ts`）

- HTML を `<!doctype html><html>` と `</html>` で包んで linkedom で DOM にし、`defuddle/node` の `Defuddle` に `markdown: true`・`useAsync: false`・`removeImages: true` を渡して Markdown にする。`useAsync: false` は、本文の無いページで第三者の API を呼ばせないため。jsdom 30 と happy-dom 20 では defuddle が失敗し、失敗しても例外を投げずに body 全体を返すので使わない。`defuddle/full` は Bun で Markdown 変換が失敗するので使わない。
- defuddle は linkedom を見込んで `<template shadowrootmode>` を展開するので、open と closed の shadow root の中の文字が本文に残る。nav と footer は本文に入らない。
- Markdown から URL を落として文字を残す。
  - リンク `[text](href "title")`（href の `(` `)` は `\(` `\)`、空白を含む href は `<…>`）は `text` にする。`\[` で始まる文字の `[` はリンクと読まない。
  - 画像 `![alt](src)` は消す。`removeImages` は `img` を消すが、`picture` の `source` は turndown が Markdown の画像にする。
  - turndown が生の HTML のまま残したもの（colspan のある表、`sup`）の中の `<a>` は tag だけを外し、`iframe`・`video`・`audio` は要素ごと消す。ほかの HTML の tag は残す。
- 本文と選択範囲は 10 万字（`MAX_PAGE_CHARS`）で切り、先頭を残して `truncated` を立てる。字は JS の文字列の `length` で数え、surrogate pair は割らない。
- 見えない文字は落とそうとしない。stylesheet の class で隠した文字は defuddle も残すので、`document` block と system prompt で受ける。
- 変換は Backend の main thread で、claude を起こす前に行う。数百 ms で、spare から答えれば claude を並べて起こす得は小さいため。変換が例外を投げたら `unparsable`（`detail` に message）にして答えを続ける。
- 本文が空なら `document` block を作らず、見出しに「本文の文字は無かった」と書く。知らせは出さない。

### 同じページ

- 1 回の request の中で、送られた `history` を新しい方から探し、`content` が `text` の turn のうち、URL が `#` から後ろを除いて一致し、切った後の本文が一致する最初の turn を `same` で指す。本文が一致していれば、hash だけ違う URL は同じページとみなす。
- `same` のときも選択範囲とスクリーンショットは添える。同じ URL と本文でも、スクロールで表示領域が変わるため。同じページだったことは side panel に知らせない。

### 全体の上限

- 前の問答、前のページの本文と選択範囲とスクリーンショット、今の質問と Page Snapshot の字の和を 20 万字（`MAX_ASK_CHARS`）に収める。スクリーンショットは 1 枚を 1,500 字と数える。URL、title、Backend が足す見出しの文は数えない。
- 超えたら、古い turn のページ（本文と選択範囲とスクリーンショット）から 1 つずつ落とす。1 ページを `document` と `image` の組で渡す形を崩さないよう、同じ質問のページの本文とスクリーンショットはまとめて落とす。それでも超えたら、古い turn の問答を 1 つずつ落とす。落としたスクリーンショットは `omitted.pages` に数え、別の知らせは足さない。
- 今の質問と Page Snapshot は落とさない。今のページが `same` で指す turn も、ページと問答のどちらも落とさない。今のページの本文がそこにしか無いため。今の分だけで 20 万字を超えても、そのまま送る。

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
| `too-large` | side panel | 送る前の大きさの確かめで外した | ページを読めませんでした（大きすぎます） |
| `unparsable` | Backend | 本文への変換が例外を投げた | ページを読めませんでした（本文を取り出せませんでした） |

- `snapshot` の `page` に `screenshotFailed` があれば「スクリーンショットを撮れませんでした」。理由は出さない。
- 本文か選択範囲を切り詰めたら「本文を切り詰めました」「選択範囲を切り詰めました」（両方なら「本文と選択範囲を切り詰めました」）。
- `omitted` の和が 1 以上なら「古いページや問答 n 件を渡していません」。

### 確かめていないこと

- context menu から選択範囲を渡す経路、iframe の中の本文と選択（`allFrames`）。
- 本物のクリックで side panel の入力欄に focus を移した後も、ページの選択範囲が `selection` に入るか（CDP の操作でだけ確かめた）。
- 入れ子の深い DOM での変換の時間。div を 256・512・1000 段入れ子にしたページで、defuddle は 0.33 秒・1.1 秒・4.4 秒かかった（3000 段で 79 秒）。main thread で走るので、その間 Backend は他の request に応えない。
- 本物の Retina の画面での `captureVisibleTab` の倍率（下の「実機で確かめたこと」は `--force-device-scale-factor=2` で真似た）。
- side panel そのものから送ったときの quota。送るボタンで 2 回と Enter で 1 回を 1 秒の間に続けて撮れるか、Enter の keydown が quota を外す user gesture になるか。side panel の page を Browser Tab で開く確かめ方では、その Browser Tab が裏に回り、操作の間が 5〜10 秒空いた。

## テスト

- `src/chat.test.ts` が `createRouterClient(router, { context: { chatAgent } })` を通して確かめる。DB は使わない。本文への変換の失敗は、`defuddle/node` の `Defuddle` を `spyOn` で reject させて作る。
- 本文への変換は `src/page/snapshot.test.ts` が `src/page/fixtures/` の HTML（`getHTML` が書き出す、document element の中身の形）で、同じページと全体の上限と block の並び（スクリーンショットの `image` の置き場所と 1,500 字の数え方を含む）は `src/page/prompt.test.ts` が `PageSnapshot` を直に組んで確かめる。どちらも claude を起こさない。
- claude は `src/fake-claude.ts` の偽の claude に差し替える。テストは拡張子の無い `/bin/sh` の wrapper を一時 directory に書いて `claudePath` に渡す。wrapper は `@monica/chat/testing` の `writeFakeClaude(dir, recordPath)` が書き、Backend のテスト（`apps/backend/src/main.test.ts`）も `MONICA_CLAUDE_PATH` に渡して使う。wrapper は `exec "<process.execPath>" "<fake-claude.ts の path>" "<記録の file>" "$@"` の 1 行。SDK は path が `.js`・`.mjs`・`.ts`・`.tsx`・`.jsx` で終わると `bun` か `node` を名前で起こすが、claude の env には `PATH` が無い。拡張子の無い path は直に起こす。wrapper の `/bin/sh` は env に `PWD`・`SHLVL`・`_` を足す。
- 偽の claude は次のように話す。
  - stdin の `control_request` に `control_response`（`subtype: success`、`response: {}`）を返す。
  - `user` の message を受けたら、`system`（`init`）、`stream_event`（`content_block_delta` の `text_delta` を 3 つと `thinking_delta` を 1 つ）、`assistant`、`result`（`subtype: success`）を 1 行ずつ書く。
  - stdin の EOF で抜ける。
  - argv、env、cwd、pid、`initialize` の request、`user` の content、EOF を、記録の file に JSON 行で書く。
  - 質問に `HOLD` を含むと、最初の text の delta の後に止まり、stdin の EOF と SIGTERM では抜けない。居なくなれば SIGKILL で終わっている。30 秒で自分から抜ける。
- 起こした claude は、テストの process の子のうち生きているもの（`ps` の ppid と stat）で数える。SDK は呼び出しの中で同期に spawn するので、`ask` と `prepare` が返った直後に数えれば、起こしていないことも確かめられる。
- 5 分の時限は、`setTimeout` を `spyOn` で捕まえ、300000ms の callback を手で呼ぶ。
- テストは偽の claude が居なくなるのを待ってから home を消す（`docs/packages/dev-loop.md` の「検査と CI」）。

## 実機で確かめたこと

SDK 0.3.293 と同梱の claude 2.1.293 で、dev の Backend を `env -i`（`HOME` と `USER` は本物）で起こして確かめた。SDK を上げるときはやり直す。

- `prepare` で、Backend を親に持つ claude（node_modules の platform package のもの）が 1 つ起きる。その pid の `~/.claude/sessions/<pid>.json` に `messagingSocketPath` が無く、`/tmp/cc-socks/<pid>.sock` も無い。
- `ask` で `text` の event が流れて stream が閉じる。`[chat]` の行の pid は spare の pid で、model は `claude-haiku-5-5`、tools 0、MCP servers 0。最初の text まで約 0.5 秒。答えた後に新しい spare が起きる。
- 最初の `text` で client が abort すると、答えていた claude は約 10ms で居なくなり、新しい spare は起きない。
- `~/.claude/projects` に `<MONICA_HOME>/chat` の path から作った directory ができず、`~/.claude.json` の `projects` に `<MONICA_HOME>` の path が入らない。
- spare を起こした Backend に SIGTERM を送ると、spare が居なくなる。
- SIGKILL した claude は `~/.claude/sessions/<pid>.json` を残し、次に claude が起きたときに消える。
- prompt cache（Page Snapshot を足した後、約 2 万字の fixture のページで 1 問目から 5 分以内に 3 問続けた）: usage は 1 問目が cache creation 5,424・cache read 0、2 問目（同じページで `same`）が 5,824・0、3 問目（`chrome://version`）が 6,204・0。質問ごとに claude を起こし直す形では、前の問答の部分は cache read にならなかった。理由は確かめていない。
- 2 万字の HTML（本文 13,928 字）の変換から `snapshot` が届くまで、`bun run` の Backend で 48ms、compile した Backend で 36ms。

## ui

`packages/chat/src/ui` は Chrome Extension の side panel の Chat の画面。`@monica/chat/ui` から出すのは root の `ChatApp` だけで、apps/extension の side panel の main.tsx がブラウザの口への RPCLink を作って `client.chat` を渡す（`docs/packages/extension.md`）。ui は `@monica/ui` に依存しない。

### fluid-functionalism の写し

部品は fluid-functionalism（MIT、`fluid/LICENSE`）の commit `bf9ece4` の registry から、`packages/chat/src/ui/fluid/` に写した。upstream を追う仕組みは持たない。

- 写したのは 14 ファイル: `chat-message.tsx`、`input-message.tsx`、`thinking-indicator.tsx`、`button.tsx`（Base UI 版）、`hooks/use-touch-primary.tsx`、`lib/` の `utils.ts`・`springs.ts`・`font-weight.ts`・`shape-context.tsx`・`size-context.tsx`・`type-scale.ts`・`icon-context.tsx`・`surface-classes.ts`・`surface-context.tsx`。CSS は `fluid/typeset.css`（`.typeset`）と `fluid/shimmer.css`（`.shimmer-text` と keyframes）を、本家の `app/globals.css` から写した。
- 写さないもの: Tooltip、use-fluid-hover、fluid-hover-highlight、popup、file-thumbnail。Button の loading の spinner の keyframes も、使わないので写さない。
- 写すときの直し:
  - `"use client"` を消し、import を拡張子付きの相対 path にし、oxfmt を当てた。
  - InputMessage は history を残し、添付・queue・suggestions・placeholder の suggestion を消した。`leftSlot` と `rightSlot` は ReactNode だけを受ける。`onStop` と止めるボタンは写したまま残し、今は渡さない。
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
- 最初の `text` が届くまで ThinkingIndicator を出す。答えている間は送らないが、入力欄には打てる。
- InputMessage の `leftSlot` に、スクリーンショットを添えるボタン（lucide の `Camera`、名前は「スクリーンショットを添える」）を置く。押している間は `aria-pressed` と Button の `active` の色で示す。mousedown の既定の動作を止めて focus を入力欄に残し、押した後の Enter がこのボタンを押し直さずに質問を送るようにする。
- 送ったスクリーンショットの縮小は、質問の吹き出しの上に右寄せで出す（上の「スクリーンショット」）。
- 失敗は種類を分けず、答えの場所に「答えを受け取れませんでした」と出し、その問答を履歴に入れない。
- 読めなかった・切り詰めた・渡していないことの知らせ（上の「Page Snapshot」の「知らせ」）は、質問の吹き出しの下に右寄せの淡い 1 行で出し、答えの場所の失敗とは分ける。

### Chat の状態（`chat-store.ts`）

React に依らない `createChatStore(client)` が Chat を持ち、`ChatApp` は `useSyncExternalStore` で描くだけにする。DOM の無い bun test で送受信を確かめるため。

- Chat は side panel の document の memory にだけあり、window ごとに 1 つ。「新しい Chat」を押すか side panel を閉じると終わり、どこにも残さない。Backend が居なくなっても終わらない（ADR-0030・0031）。
- `open(readPage)` は side panel を開いた時に `ChatApp` の effect が 1 回呼び、`chat.prepare` を呼んで spare を起こさせる。失敗は無視する。Backend の不在を知らせる帯はまだ無い。dev の StrictMode で 2 回呼ばれても、Backend が spare を 1 つに保つので害は無い。
- `ask` は、送る時に `readPage({ screenshot })` で Current Page を読み直して `page` に入れ、答え終えた問答を古い順に `history` に入れて `chat.ask` を呼ぶ。`readPage` は await を挟まずに呼び、送る操作の user gesture の中で撮り始める。`ChatApp` が渡す `readPage` は `read-current-page.ts` の `readCurrentPage` で、撮り始めてから Browser Tab を取り直して `read-page.ts` で読む（上の「Page Snapshot」）。答えている間は送らずに false を返し、スクリーンショットのボタンも外さない。答えの途中で Current Page が替わっても、delta はその質問の答えに足す。
- `snapshot()` の `withScreenshot` がボタンの状態で、`toggleScreenshot` が切り替える。`ask` が送ったら外す。
- 送ったスクリーンショットは、読み終えた時に質問の entry の `screenshot` に入れて縮小を出す。
- 届いた `snapshot` の `page` に送ったスクリーンショットを足して、その問答の turn の `page` として履歴に入れ、`snapshot` から作った知らせを質問の entry の `notice` に入れる。
- `startNewChat` は流れている stream を `signal` で abort し、問答と履歴を空にし、スクリーンショットのボタンを外す。abort の後に届いた delta は描かない。Backend は abort でその claude を止める。
- client の型 `ChatClient` は、side panel が呼ぶ `prepare` と `ask` だけの形。ブラウザの口への oRPC の client の `chat` がそのまま入り、テストは偽の client を渡す。

### Current Page の追い方（`current-page.ts`）

- `watchCurrentPage(onChange)` は、最初の `tabs.query({ active: true, currentWindow: true })` で side panel を載せた window の id と Browser Tab を取る。side panel の page からは、別の window に focus があってもこの window が返る。
- `tabs.onActivated` はその window の event だけを見る。`tabs.onUpdated` は Current Page の Browser Tab の event だけを見て、tab の url と title が前に出したものと違えば出し直す。pushState と hash の変更も url の変化として届く。chrome:// へ移ったときは url も title も無い event だけが届くので、変化の中身ではなく tab の値で比べる。
- 権限は `tabs` も `webNavigation` も足さない。`<all_urls>` の host permission で http・https・file のページの url と title が見える。
- `read()` は送る時に `tabs.query({ active: true, windowId })` で Browser Tab を取り直して返す。見出しの追跡が event を取りこぼしても、読んで送るページを違えない。
- `windowId()` は side panel を載せた window の id を返し、`captureVisibleTab` に渡す。最初の `tabs.query` が返る前は undefined で、そのときは `windowId` を省いて呼ぶ（side panel からは同じ画像になる）。
- 止めると listener を外し、読み途中の結果も捨てる。

### markdown

- 答えは react-markdown と remark-gfm で描き、`.typeset` をかぶせる。表は `.typeset-scroll` で包む。コードブロックに色は付けない。
- 画像は読み込まず、`[画像: alt] URL` を文字で出す。URL に Chat の中身を載せた画像を読み込ませないため。manifest の CSP の `img-src 'self' data:` も外の画像を止める。
- リンクにするのは `http:` と `https:` の URL だけで、`<a target="_blank" rel="noreferrer">` で新しい Browser Tab に開き、文字の後ろに `new URL(href).host` を淡く出す。target の無い `<a>` は side panel から開かない。ほかの scheme（`javascript:`、`mailto:`、相対 URL など）は文字で出す。

### テスト

- DOM の環境は入れない（`docs/packages/note-ui.md` の「テスト」と同じ）。
- `current-page.test.ts` は `fake-chrome.ts` の偽の `chrome.tabs` で確かめる。偽物は `globalThis.chrome` に置いてテストの後に外し、`query` の `active`・`windowId`・`currentWindow` を本物と同じく絞る。chrome:// へ移ったときの url も title も無い `onUpdated` も出せる。
- `read-page.test.ts` は同じ偽物の `chrome.scripting.executeScript` で確かめる。偽物は注入された関数を走らせず、`readings` に置いた結果を返すか、reject するか、返らない。渡された injection は `injections` に残る。注入する関数そのもの（shadow root と選択範囲）は DOM が要るので、実機で確かめる。3 秒の打ち切りは `setTimeout` を `spyOn` して callback を手で呼ぶ。
- `read-current-page.test.ts` は同じ偽物の `chrome.tabs.captureVisibleTab` と、偽の `createImageBitmap`・`OffscreenCanvas`・`devicePixelRatio` で、撮る時機・大きさと形式・撮れないとき・読めずに撮れたときを確かめる。偽の `captureVisibleTab` は `screenshots` に置いた大きさの偽の PNG を返すか、reject するか、返らない。呼ばれた引数は `captures` に残る。偽の canvas は画像を描かず、書き出した形式と quality と大きさを JSON にした Blob を返す。本物の縮小は bun test に canvas が無いので実機で確かめ、大きさの計算（`shrunkSize`）は `screenshot.test.ts` が純関数として確かめる。
- `chat-store.test.ts` は偽の client で確かめる。偽の答えの stream は `signal` に応えず、test が流した delta をそのまま渡すので、abort の後に届いた delta を描かないことを確かめられる。偽の `readPage` は渡された `{ screenshot }` を記録し、`ask` が返る前に呼ばれたかを見られる。
- `answer.test.tsx` は `react-dom/server` の `renderToStaticMarkup` で markdown の描画を確かめる。react-dom は devDependency。

### 実機で確かめたこと

Brave 1.97 で確かめた。

- 新しい profile の headed の Brave で action から side panel を開くと、side panel は窓の右に出て、Brave の sidebar（icon の列）は一緒に出なかった。
- dev の side panel で `current-page.ts` を編集すると HMR で届くが、開いている side panel の listener は前の module のままだった。Current Page の追い方を確かめ直すときは、side panel を閉じて開き直す。
- Page Snapshot（headless の Brave、dev の side panel の page を Browser Tab で開き、別の agent-browser の session で読む Browser Tab を active にして送った）:
  - script で `attachShadow({ mode: 'closed' })` した要素の中の文字は、body の `html` に `<template shadowrootmode="closed">` で入り、本文に残った。page の script で選んだ 1 文は、side panel の入力欄に打った後も `selection` に入った。
  - `chrome://version` は `restricted`（`detail` は `Cannot access a chrome:// URL`）になり、知らせが出て答えも返った。
  - `view-source:` は、Enter から約 3.3 秒後に `timeout` の body を送った。`view-source:` は CDP の `Page.navigate` では開けず、新しい Browser Tab としてなら開けた。
- スクリーンショット（同じ確かめ方。side panel の page の Browser Tab は裏に回り、Current Page の Browser Tab が表にある）:
  - 本文に無い `QX-4821` を canvas にだけ描いたページで、ボタンを押して「画面に見えるコードは？」と送ると、haiku の答えが `QX-4821` を含んだ。JPEG の `image` block を CLI がそのまま API へ送り、model が中身を読めた。body の `page.screenshot` は JPEG で、headless（DPR 1）で 756×475（ページの `innerWidth`×`innerHeight`）、26,112 byte。吹き出しの上に縮小が出て、送った後の `aria-pressed` は false。
  - 続けてボタンを押さずに訊くと、body の `page` に `screenshot` が無く、`history[0].page.screenshot` が 1 問目に送ったものと同じ文字列だった。
  - `--force-device-scale-factor=2` で起こした Brave では、撮った PNG が 2400×1850（`innerWidth` 1200 の 2 倍）、縮めた JPEG が 1200×925 だった。
  - Backend を止めて `chrome://version` で送ると、body の `page.content` が `restricted`（`Cannot access a chrome:// URL`）、`page.screenshotFailed.reason` が `The 'activeTab' permission is not in effect because this extension has not been in invoked.` だった。
  - PDF の Browser Tab（Brave の PDF viewer）は撮れた。viewer の toolbar と縮小の列ごと写る。本文は viewer の DOM の HTML になる（#279 が分ける）。
