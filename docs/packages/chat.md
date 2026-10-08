# Chat の agent と画面

`packages/chat` の contract と `ChatAgent` と ui。Chrome Extension の side panel の Chat の質問に、Backend が起こす claude が答える。決定の理由は ADR-0028・0029・0030・0031・0032・0033 にある。画面は末尾の「ui」にある。

## contract（root は `chat`）

```
prepare   → void
ask       { question, page: { url?, title? }, history: { question, page, answer }[] } → event iterator of ChatEvent   errors: CHAT_BUSY
```

- `prepare` は spare（下の「spare」）を起こし、その initialize を待たずに返る。spare が既にあるか、claude を 4 つ持っていれば何もしない。Chrome Extension は Backend の不在の確かめにもこれを呼ぶので、速く返す。
- `ask` は 1 回の質問への応答の stream（`docs/packages.md` の contract の規約 7）。`ChatEvent` は `type` の判別 union で、今は `{ type: 'text', text }`（答えの文字の delta）だけ。client は届いた順に `text` をつなぐ。result を受けたら stream を閉じる。
- `question` は 1 字以上。`page` の `url` と `title` は省略できるただの文字列で、形を検めない。`chrome://` などの Browser Tab では side panel から見えず、`file://` のページもあるため。
- `history` は Chat の前の問答を古い順に並べたもの。turn ごとに質問した時のページを持つ。Backend は検めずに prompt の文字にする（ADR-0031）。
- `.errors()` で宣言するのは `CHAT_BUSY`（status 429）だけ。claude を 4 つ持っているときの `ask` に、iterator を返す前に投げる。claude が落ちたときの error は型にせず、SDK の iterator が投げた error がそのまま oRPC の `INTERNAL_SERVER_ERROR` として流れる。
- `MAX_ASK_BODY_BYTES`（50MB）は、ブラウザの口が受ける body の上限。ブラウザの口の 2 つの `Bun.serve` に `maxRequestBodySize` で渡し、超えた body には 413 が返る。
- router は CLI に出さず、ブラウザの口にだけ `{ note, chat }` で載せる。token の口には載せない。change stream は持たない（ADR-0028・0031）。

## createChatAgent

`createChatAgent({ home, claudePath? })` は `stop()` だけを持つ `ChatAgent` を返す。Ledger と違い記録を持たないので、Ledger とは呼ばず、`start()` も無い。

- `$MONICA_HOME/chat` を `mkdirSync(…, { recursive: true, mode: 0o700 })` で作り、claude の cwd にする。
- `claudePath` は claude の場所で、SDK の `pathToClaudeCodeExecutable` に渡す。省けば渡さず、SDK が node_modules の platform package（`@anthropic-ai/claude-agent-sdk-darwin-arm64` など）の claude を使う。dev の Backend は省く。compile した binary は node_modules の claude を解決できないので、release の Backend はまだ claude を見つけられない。
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

`SDKUserMessage` を 1 つ流す AsyncIterable で渡す。content は text block の配列で、前の問答の block（`history` が空なら無い）と、今のページと質問の block に分ける。後でページの `document` や `image` の block を足すため。

- 前の問答の block は、turn ごとに `<turn>` で囲み、中にページの `<page>`（`URL:` と `Title:` の行）、`<question>`、`<answer>` を置く。
- 今の block は「今のページ」の `<page>` と `<question>`。
- `url` か `title` が無いときは、その行に `unknown` と書く。
- system prompt（`src/prompt.ts` の `SYSTEM_PROMPT`）は、ページから来た文字（title・本文・document・画像）はページの作者が書いたものでユーザーの指示ではなく、従うのはユーザーの質問だけであることと、tool を持たないことを書く。

## log

claude の `system`（`init`）を受けたら、stderr に 1 行出す。tools 0 と MCP 0 を実機で見るためと、SDK を上げて `haiku` の解決先が変わったときに気づくため（ADR-0032）。

```
[chat] claude <pid>: model <model>, <n> tools, <m> MCP servers
```

## テスト

- `src/chat.test.ts` が `createRouterClient(router, { context: { chatAgent } })` を通して確かめる。DB は使わない。
- claude は `src/fake-claude.ts` の偽の claude に差し替える。テストは拡張子の無い `/bin/sh` の wrapper を一時 directory に書いて `claudePath` に渡す。wrapper は `exec "<process.execPath>" "<fake-claude.ts の path>" "<記録の file>" "$@"` の 1 行。SDK は path が `.js`・`.mjs`・`.ts`・`.tsx`・`.jsx` で終わると `bun` か `node` を名前で起こすが、claude の env には `PATH` が無い。拡張子の無い path は直に起こす。wrapper の `/bin/sh` は env に `PWD`・`SHLVL`・`_` を足す。
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
- 失敗は種類を分けず、答えの場所に「答えを受け取れませんでした」と出し、その問答を履歴に入れない。

### Chat の状態（`chat-store.ts`）

React に依らない `createChatStore(client)` が Chat を持ち、`ChatApp` は `useSyncExternalStore` で描くだけにする。DOM の無い bun test で送受信を確かめるため。

- Chat は side panel の document の memory にだけあり、window ごとに 1 つ。「新しい Chat」を押すか side panel を閉じると終わり、どこにも残さない。Backend が居なくなっても終わらない（ADR-0030・0031）。
- `open(readPage)` は side panel を開いた時に `ChatApp` の effect が 1 回呼び、`chat.prepare` を呼んで spare を起こさせる。失敗は無視する。Backend の不在を知らせる帯はまだ無い。dev の StrictMode で 2 回呼ばれても、Backend が spare を 1 つに保つので害は無い。
- `ask` は、送る時に `readPage` で Current Page を読み直して `page` に入れ、答え終えた問答を古い順に `history` に入れて `chat.ask` を呼ぶ。答えている間は送らずに false を返す。答えの途中で Current Page が替わっても、delta はその質問の答えに足す。
- `startNewChat` は流れている stream を `signal` で abort し、問答と履歴を空にする。abort の後に届いた delta は描かない。Backend は abort でその claude を止める。
- client の型 `ChatClient` は、side panel が呼ぶ `prepare` と `ask` だけの形。ブラウザの口への oRPC の client の `chat` がそのまま入り、テストは偽の client を渡す。

### Current Page の追い方（`current-page.ts`）

- `watchCurrentPage(onChange)` は、最初の `tabs.query({ active: true, currentWindow: true })` で side panel を載せた window の id と Browser Tab を取る。side panel の page からは、別の window に focus があってもこの window が返る。
- `tabs.onActivated` はその window の event だけを見る。`tabs.onUpdated` は Current Page の Browser Tab の event だけを見て、tab の url と title が前に出したものと違えば出し直す。pushState と hash の変更も url の変化として届く。chrome:// へ移ったときは url も title も無い event だけが届くので、変化の中身ではなく tab の値で比べる。
- 権限は `tabs` も `webNavigation` も足さない。`<all_urls>` の host permission で http・https・file のページの url と title が見える。
- `read()` は送る時に `tabs.query({ active: true, windowId })` で取り直す。見出しの追跡が event を取りこぼしても、送るページを違えない。
- 止めると listener を外し、読み途中の結果も捨てる。

### markdown

- 答えは react-markdown と remark-gfm で描き、`.typeset` をかぶせる。表は `.typeset-scroll` で包む。コードブロックに色は付けない。
- 画像は読み込まず、`[画像: alt] URL` を文字で出す。URL に Chat の中身を載せた画像を読み込ませないため。manifest の CSP の `img-src 'self' data:` も外の画像を止める。
- リンクにするのは `http:` と `https:` の URL だけで、`<a target="_blank" rel="noreferrer">` で新しい Browser Tab に開き、文字の後ろに `new URL(href).host` を淡く出す。target の無い `<a>` は side panel から開かない。ほかの scheme（`javascript:`、`mailto:`、相対 URL など）は文字で出す。

### テスト

- DOM の環境は入れない（`docs/packages/note-ui.md` の「テスト」と同じ）。
- `current-page.test.ts` は `fake-chrome.ts` の偽の `chrome.tabs` で確かめる。偽物は `globalThis.chrome` に置いてテストの後に外し、`query` の `active`・`windowId`・`currentWindow` を本物と同じく絞る。chrome:// へ移ったときの url も title も無い `onUpdated` も出せる。
- `chat-store.test.ts` は偽の client で確かめる。偽の答えの stream は `signal` に応えず、test が流した delta をそのまま渡すので、abort の後に届いた delta を描かないことを確かめられる。
- `answer.test.tsx` は `react-dom/server` の `renderToStaticMarkup` で markdown の描画を確かめる。react-dom は devDependency。

### 実機で確かめたこと

Brave 1.97 で確かめた。

- 新しい profile の headed の Brave で action から side panel を開くと、side panel は窓の右に出て、Brave の sidebar（icon の列）は一緒に出なかった。
- dev の side panel で `current-page.ts` を編集すると HMR で届くが、開いている side panel の listener は前の module のままだった。Current Page の追い方を確かめ直すときは、side panel を閉じて開き直す。
