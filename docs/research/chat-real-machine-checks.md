# Chat を実機で確かめたこと

Chat（Chrome Extension の side panel の質問に、Backend の `packages/chat` が起こす claude が答える）について、実機で確かめた事実と、まだ確かめていないことを残す。

確かめた環境は、Agent SDK 0.3.293 と同梱の claude 2.1.293、Brave 1.97、pdfjs-dist 6.4.299。どれも `docs/packages/chat.md`（`48c82ec`）の「実機で確かめたこと」「確かめたこと」「確かめていないこと」の節と、説明の節に混ざっていた実機の事実から移した。

## 1. Agent SDK と同梱の claude

SDK を上げるときは、この節の確かめを新しい版と同梱の claude でやり直す。

SDK 0.3.293 と同梱の claude 2.1.293 で、dev の Backend を `env -i`（`HOME` と `USER` は本物）で起こして確かめた。

- `prepare` で、Backend を親に持つ claude（node_modules の platform package のもの）が 1 つ起きる。その pid の `~/.claude/sessions/<pid>.json` に `messagingSocketPath` が無く、`/tmp/cc-socks/<pid>.sock` も無い。
- `ask` で `text` の event が流れて stream が閉じる。`[chat]` の行の pid は spare の pid で、model は `claude-haiku-5-5`、tools 0、MCP servers 0。最初の text まで約 0.5 秒。答えた後に新しい spare が起きる。
- 最初の `text` で client が abort すると、答えていた claude は約 10ms で居なくなり、新しい spare は起きない。
- `~/.claude/projects` に `<MONICA_HOME>/chat` の path から作った directory ができず、`~/.claude.json` の `projects` に `<MONICA_HOME>` の path が入らない。
- spare を起こした Backend に SIGTERM を送ると、spare が居なくなる。
- SIGKILL した claude は `~/.claude/sessions/<pid>.json` を残し、次に claude が起きたときに消える。
- prompt cache（Page Snapshot を足した後、約 2 万字の fixture のページで 1 問目から 5 分以内に 3 問続けた）: usage は 1 問目が cache creation 5,424・cache read 0、2 問目（同じページで `same`）が 5,824・0、3 問目（`chrome://version`）が 6,204・0。質問ごとに claude を起こし直す形では、前の問答の部分は cache read にならなかった。理由は確かめていない。
- 2 万字の HTML（本文 13,928 字）の変換から `snapshot` が届くまで、`bun run` の Backend で 48ms、compile した Backend で 36ms。Worker に移した後は、`src/page/fixtures/article.html` の `snapshot` が呼んでから 106ms と 37ms で届き、本文は両方の Backend で同じだった。compile した Backend で、div を 3,000 段入れ子にしたページを本文にしている間（23 秒）、`chat.prepare` は 2ms で返った。
- PDF（pdfjs-dist 6.4.299）: `testPdf` で組んだ 2 ページの日本語と英語の PDF を RPCLink で `chat.ask` に添えると、`bun run` の Backend でも、`scripts/build.ts` と同じ command で compile した Backend でも、最初の `snapshot` の本文が同じになった（呼んでから届くまで 67ms と 31ms）。compile した Backend は Worker を `/$bunfs/root/pdf-worker.ts` から、cMap を `/$bunfs/root/cmaps` から読み、migrate を終えて起き、SPA も今までどおり `dist` から配った。
- `CLAUDE_CODE_MAX_RETRIES=4` は効く。scratchpad の `Bun.serve` の proxy が、すべての `POST /v1/messages` に 529（`overloaded_error`）を返し、届いた時刻だけを記録した。`createChatAgent` の claude の場所には、`ANTHROPIC_BASE_URL` をその proxy に向けて本物の claude（SDK 0.3.293 の platform package）を `exec` する wrapper を渡した。
  - wrapper が受けた env に `CLAUDE_CODE_MAX_RETRIES=4` があった。
  - `retry` が attempt 1〜4 で届き、proxy に 5 回届いた（2〜5 回目は最初の request の 0.6・1.8・3.8・8.5 秒後）。
  - 最初の request から 8.5 秒で `AGENT_FAILED` になり、`detail` は「API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:<port>).」だった。
  - claude を起こしてから最初の request まで 3.0 秒かかった。
- 失敗を決めた claude が自分で抜けるまでには 0.5〜1.4 秒かかる。SDK が `Error("Claude Code returned an error result: …")` を投げるのも、`result` の 0.5〜1.4 秒後になる。
- result を受けた後に `for await` を抜けると、SDK は claude の終了を最大 2 秒待ち、その間 stream が閉じない。
- 調べたどの失敗でも、`assistant` の `error` の直後に `result` が来た。

## 2. Backend と Native Messaging と side panel

- 本物の side panel（Brave 1.97、headless、dev の Chrome Extension）で、Backend の居ない home で side panel を開くと帯が出た。同じ home の Backend をブラウザの口の port を付けて起こすと、5 秒以内に帯が消えた。
- side panel の page を Browser Tab で開いて（3 節と同じ確かめ方）、本物の claude で次を確かめた。
  - Backend の居ない間に「1 から 300 まで数字を 1 行ずつ書いて」を送ると、「monica の desktop に届きませんでした」と再試行のボタンと帯が出た。`TypeError` 以外なら「claude が答えを返せませんでした」と message が出るので、Chrome Extension の page の fetch の失敗も `TypeError` になる。
  - Backend を起こした後に再試行を押すと、同じ質問の答えが返った。plan の使用率が 96% のときで、答えの下に「plan の 5 時間の枠を 96% 使いました（9:40 に戻ります）」が出た（本物の `allowed_warning`）。
  - 答えが流れ始めてから止めるを押すと「止めました」が出て、3 秒後も答えは増えず、Backend を親に持つ claude は無かった。
  - 答えが流れ始めてから Backend の stdin を閉じると、途中までの答えと「答えが途中で切れました」、再試行のボタン、帯が出た。stream の途中で Backend が居なくなっても `TypeError` になる。
- Native Messaging（Brave 1.97、headless、dev の Chrome Extension、`bun run extension` が本物の場所に書いた dev の manifest）: Backend の居ない home で side panel を開くと帯が出た。同じ home に Backend を起こすと 5 秒以内に帯が消え、Backend を親に持つ spare の claude が起きた（host が返した port と Chrome Extension の token で `chat.prepare` が届いた）。side panel の page を Browser Tab で開いて質問を送ると、答えが返った。
- compile した CLI（`scripts/build.ts` と同じ flag）を host として起こし、枠付きの `{}` を渡すと、約 10ms で枠付きの `{ port, token }` が返り、token は `backend.json` の Chrome Extension の token だった。新しく compile した binary の最初の 1 回は約 790ms かかった。Backend の居ない home では `{ error: 'not-running' }` が返った。
- 本物の Backend の token の口で、Chrome Extension の token は `chat.ask` に届き（不正な input の 400）、`workbench.layout.get`・`task.list`・`job.list` は 401 だった。全権の token はどれも通り、token 無しはどれも 401 だった。`/rpc/chat/../workbench/layout/get` と `/rpc/chat/%2e%2e/workbench/layout/get` を TCP に直に書いても、Chrome Extension の token では 401 だった。ブラウザの口の `chat.ask` は 404 で、`note.daily.dates` は今どおり 200 だった。
- side panel の target で、Backend の居ない口への `fetch` は `TypeError: Failed to fetch` で reject した（headless の Brave の side panel そのもので `extension-panel.ts eval` で評価した）。
- side panel の page を Browser Tab で開いて、本文を送り終えない PDF（navigation には PDF を返し、fetch には `%PDF-` の頭だけを送って止まる URL）で送り、読み終える前に止めるを押すと、配る側でその fetch の request が abort された。「新しい Chat」でも同じだった。止めた後に別のページで送ると、body の `history[0]` は `{ question, page: { url, title }, answer: '（ユーザーが途中で止めた）' }` で、`url` と `title` は送った時の見出しの PDF のものだった。
- 再試行は、スクリーンショットも PDF も取り直さない。headless の Brave の side panel で、Backend を止めて PDF の Browser Tab でスクリーンショットを添えて送り、Backend を起こして再試行すると、送り直した body は multipart の boundary を除いて最初の body と同じで、PDF の URL への fetch も起きなかった。
- 新しい profile の headed の Brave で action から side panel を開くと、side panel は窓の右に出て、Brave の sidebar（icon の列）は一緒に出なかった。
- dev の side panel で `current-page.ts` を編集すると HMR で届くが、開いている side panel の listener は前の module のままだった。Current Page の追い方を確かめ直すときは、side panel を閉じて開き直す。

## 3. Page Snapshot・PDF・スクリーンショット

Brave 1.97 で確かめた。

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
- スクリーンショットの quota（headless の Brave の side panel そのもので、`extension-panel.ts eval` で送った）: Backend を止めた状態で、ボタンを押して送る式を 0.3 秒おきに 3 回評価すると、680ms の間に 3 回とも撮れ、どの body にも JPEG があり `screenshotFailed` は無かった。答えの間は送るボタンが止めるボタンになり、Backend が答えている間の 2 回目の click は止めるボタンを押すので、続けて送る確かめは Backend を止めて、送った質問がすぐ失敗する状態で行う。

## 4. Brave・Chromium・依存の振る舞い

- `chrome.scripting.executeScript` は、`view-source:`、`alert()` の最中、frozen の Browser Tab では返らない。`injectImmediately` が無いと、body が終わらないページでも返らない。
- PDF viewer の main frame は `document.contentType` が `application/pdf` で body が空。viewer は closed shadow root の中の OOPIF にあり、`executeScript` は viewer の frame に注入しない。
- PDF の選択範囲は読めない。viewer の frame には注入できず、top frame の `getSelection()` は viewer の中の選択を返さない。
- `chrome.tabs.captureVisibleTab` で撮れるかを決めるのは `<all_urls>` の host permission だけで、user gesture は要らない。gesture が効くのは quota だけで、gesture の外では約 1 秒に 2 回を超えると `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` の error になり、gesture から 4.8 秒以内は何回でも通った（Chromium の `tabs_api.cc` の `ShouldSkipQuotaLimiting()` が `user_gesture()` を見る）。
- defuddle は jsdom 30 と happy-dom 20 では失敗し、失敗しても例外を投げずに body 全体を返す。`defuddle/full` は Bun で Markdown 変換が失敗する。
- defuddle は同期に走り、div を 3,000 段入れ子にしたページでは 23〜79 秒かかる。普通のページは 0.1 秒かからず（2 万字の HTML で 48ms）、div を 1,000 段入れ子にしたページでも数秒で終わる。
- Bun の中の pdf.js は、Web Worker を作らずに fake worker を呼んだ側の thread で動かし、fake worker は `./pdf.worker.mjs` を動的に import する。compile した binary ではその import が解けない。`pdfjs-dist/build/pdf.worker.mjs` を静的に import して `globalThis.pdfjsWorker` に置くと、pdf.js はそれを見つけて動的な import をしない。`bun run` の Backend でも compile した binary でも、pdf.js の fake worker は Bun の Worker の thread で動いた。
- `verbosity: 0` で pdf.js の警告（`console.warn`、stderr）は出ないが、modern build は読み込みのたびに legacy build を勧める 1 行（`Warning: Please use the legacy build in Node.js environments.`）を stderr に出す。
- side panel の page からの `tabs.query({ active: true, currentWindow: true })` は、別の window に focus があっても side panel を載せた window を返す。
- `tabs.onUpdated` には、pushState と hash の変更も url の変化として届く。chrome:// へ移ったときは url も title も無い event だけが届く。
- `tabs` も `webNavigation` の権限も無く、`<all_urls>` の host permission だけで、http・https・file のページの url と title が見える。

## 5. 確かめていないこと

- context menu から選択範囲を渡す経路、iframe の中の本文と選択（`allFrames`）。
- 本物のクリックで side panel の入力欄に focus を移した後も、ページの選択範囲が `selection` に入るか（CDP の操作でだけ確かめた）。
- ログインが要る PDF を side panel の fetch で取れるか。取れなければ、`fetch-failed`（ログインのページの HTML や ok でない status が返ったとき）か `unparsable`（`%PDF-` で始まるが pdf.js が開けないとき）に落ちる。headless の Brave 1.97 で、side panel の page の fetch に、PDF の host の cookie が付いたことだけは見た（3 節）。
- 大きな PDF を Worker で読む間に Backend の event loop が止まらないか（確かめたのは小さな PDF だけ）。
- 本物の Retina の画面での `captureVisibleTab` の倍率（3 節は `--force-device-scale-factor=2` で真似た）。
- Enter の keydown が quota を外す user gesture になるか。side panel で式を評価して送る確かめ方では、gesture は評価の userGesture から来るので、本物の Enter の gesture は確かめられない。
- release の Shell が書いた manifest で、Dock から起こした普段の Brave の side panel が `.app` の CLI を host に起こして答えを受けるか（PR の確認でユーザーが確かめる）。
- dev の host（`bun` で動く CLI）の 1 回の問い合わせにかかる時間。
- 帯が出ている間に、ページを click してから side panel を click すると、side panel の window が `focus` を受けて 5 秒を待たずに帯が消えるか。
- 期限切れの OAuth token の 401 で、CLI が token を更新して答えるか（CLI のコードには更新して再試行する分岐がある）。
- 本物の plan の上限の 429。[Chat の失敗の見せ方](https://github.com/ashigirl96/monica/issues/269) の research は header を真似た 429 で確かめた。
- spare から答えたときの本物の失敗と `initialize_timeout`。偽の claude では、spare の login 無しも `NOT_AUTHENTICATED` になった。
- CLI が合成の user message で続きを頼む場合（[Chat の失敗の見せ方](https://github.com/ashigirl96/monica/issues/269) の research の「毎回 RST で切る」）に、`retry` で消した前半が戻るか。CLI は途中までの答えを残して続きだけを頼むので、前半が戻らないことがある。
