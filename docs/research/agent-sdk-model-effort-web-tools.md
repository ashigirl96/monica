# Agent SDK で model と effort を選ばせ、WebSearch と WebFetch を持たせる

2026 年 10 月時点で、Chat（Chrome Extension の side panel から Backend の `packages/chat` が起こす claude）について次を一次資料で確かめた。

- model の一覧を実行時に取れるか。effort の対応も一覧に含まれるか
- query ごとに model と effort を渡す方法
- built-in の WebSearch と WebFetch を持たせる方法
- 入っている SDK の版と、上げる必要があるか

資料は、入っている `@anthropic-ai/claude-agent-sdk@0.3.293` の `sdk.d.ts` と `sdk-tools.d.ts`（以下 `sdk.d.ts:<行>`）、code.claude.com と platform.claude.com の docs、SDK の CHANGELOG。手元の実機で 2 つの script を走らせた結果も添える（「実機」と書いたもの）。

`sdk.d.ts` の場所は `node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.293+5aa1ba6117143b63/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（本体の checkout の node_modules。worktree には node_modules が無い）。

## 結論

1. `Query.supportedModels()` で model の一覧を取れる。各行の `ModelInfo` は `supportsEffort` と `supportedEffortLevels` を持つので、effort の選択肢も一覧から決められる。prompt を送らずに呼べて、実機では spawn から一覧まで約 0.6 秒、result も usage も出なかった。
2. model は `options.model`、effort は `options.effort`（`'low' | 'medium' | 'high' | 'xhigh' | 'max'`）で query ごとに渡す。途中で替えるなら `Query.setModel()` と `Query.applyFlagSettings({ effortLevel })` を使う。`setEffort` という method は無い。Haiku 5.5 は 5 段階すべてに対応する。Haiku 4.5 は effort に対応しない。
3. WebSearch と WebFetch は `tools: ['WebSearch', 'WebFetch']` で載り、さらに `allowedTools` に同じ 2 つを入れると走る。今の Chat は `permissionPrompts: 'none'` なので、`allowedTools` に入れないと 2 つとも自動で拒否される（実機）。env の `CLAUDE_CODE_RESTRICTED=1` は WebFetch を外すが、`tools` に名前で書けば残る。
4. 入っている版は 0.3.293（同梱の Claude Code は 2.1.293）。上の 1〜3 はすべてこの版で動いたので、上げる必要は無い。CHANGELOG の最新は 0.3.296。

## 今のコード

| 何を | 場所 |
|---|---|
| SDK の版（catalog） | `package.json:10` の `"@anthropic-ai/claude-agent-sdk": "0.3.293"` |
| SDK を使う package | `packages/chat/package.json:15`。`apps/extension` は SDK を import せず、Backend の `chat.ask` を呼ぶ |
| model と effort の固定 | `packages/chat/src/claude.ts:68`（`model: 'haiku'`）、`:69`（`effort: 'low'`） |
| tool の設定 | `packages/chat/src/claude.ts:76-79`（`strictMcpConfig: true`、`tools: []`、`disallowedTools: ['mcp__*']`、`permissionPrompts: 'none'`） |
| env の `CLAUDE_CODE_RESTRICTED=1` | `packages/chat/src/claude.ts:46` |
| options を作る関数 | `packages/chat/src/claude.ts:62` の `claudeOptions(deps)`。引数に model と effort は無い |
| options を使う所 | `packages/chat/src/chat-agent.ts:140` の `spawnWith`。spare は `:160` の `startup({ options })`、spare が無いときは `:312` の `query({ prompt, options })` |
| spare に prompt を渡す所 | `packages/chat/src/chat-agent.ts:184` の `warm.query(prompt)` |
| prompt の AsyncIterable | `packages/chat/src/prompt.ts:23` の `singleTurn`。message を 1 つすぐに流し、`end()` まで閉じない |
| ask の入力 | `packages/chat/src/contract.ts:85` の `AskInputSchema`。model と effort の field は無い |
| init の log | `packages/chat/src/chat-agent.ts:228-231`。model と tools の数を stderr に出す |
| 決定と文書 | ADR-0033（`docs/adr/0033-the-chat-agent-reads-nothing-from-the-user-environment-and-has-no-tools.md`）、`docs/packages/chat.md` の「claude の options と env」 |
| 固定値に依るテスト | `packages/chat/src/chat.test.ts:264`（`--model haiku` と low effort を確かめる）、`packages/chat/src/fake-claude.ts:44,77`（`claude-haiku-5-5` を返す） |

ADR-0033 の Consequences は「tool を足すときは、足す理由と、token の無いブラウザの口から起こしてよい理由を ADR に書く」と決めている。WebSearch と WebFetch を足すなら ADR が要る。

## 1. model の一覧を実行時に取る

### API

- `Query.supportedModels(): Promise<ModelInfo[]>`（`sdk.d.ts:3014`）。docs も「Returns available models with display info」と書く（https://code.claude.com/docs/en/agent-sdk/typescript#query-object）。
- `Query.initializationResult()`（`sdk.d.ts:2976`）が返す `SDKControlInitializeResponse` も `models: ModelInfo[]` を持つ（`sdk.d.ts:4569-4575`）。一覧は initialize の応答に入っていて、`supportedModels()` はその値を返す。
- `ModelInfo`（`sdk.d.ts:1392-1429`）の field:
  - `value`: API に渡す model の識別子（`'haiku'` のような alias も入る）
  - `resolvedModel?`: alias が解ける先の model id（例 `'sonnet'` → `'claude-sonnet-5'`）
  - `displayName`、`description`
  - `supportsEffort?`、`supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]`
  - `supportsAdaptiveThinking?`、`supportsFastMode?`、`supportsAutoMode?`
- `supportsEffort`・`supportedEffortLevels`・`supportsAdaptiveThinking` は SDK 0.2.49 で、`supportsFastMode` は 0.2.69 で入った（CHANGELOG: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md）。
- 一覧は account と managed settings で変わる。managed settings の `availableModels` は選べる model を絞る（`sdk.d.ts:6897-6905`）、`deniedModels` は外す（`sdk.d.ts:6907`）、`modelPicker` は並びと label を差し替える（`sdk.d.ts:6917`）。ADR-0033 が書くとおり managed policy は `settingSources: []` でも読まれるので、ハードコードせずに一覧を取る理由になる。

### prompt を送らずに呼ぶ

- `startup()` が返す `WarmQuery` は `query(prompt)` と `close()` しか持たず（`sdk.d.ts:9976-9988`）、一覧を読む method が無い。
- `query()` に何も流さない AsyncIterable を prompt として渡すと、claude は spawn と initialize を済ませて prompt を待つ。この `Query` で `supportedModels()` を呼び、`close()` すればよい。

実機（`query({ prompt: 何も yield しない async generator, options: { model: 'haiku', settingSources: [], tools: [...], env: Chat と同じ形 } })` で `supportedModels()` を呼んだ）:

- `query()` から一覧が返るまで 611ms（spawn と initialize を含む）。
- result の message も usage も出ない。一覧は initialize の応答から来るので model の推論は走らない。claude が裏で API に何か問い合わせたかは確かめていない。
- 返った行（Claude Team の claude.ai login、`apiProvider: 'firstParty'`）:

| `value` | `resolvedModel` | `displayName` | `supportedEffortLevels` |
|---|---|---|---|
| `default` | `claude-opus-5-5` | Default (recommended) | low〜max の 5 段階 |
| `opus` | `claude-opus-5-5` | Opus 5.5 | 5 段階 |
| `fable` | `claude-fable-5-1` | Fable 5.1 | 5 段階 |
| `sonnet` | `claude-sonnet-5-5` | Sonnet 5.5 | 5 段階 |
| `haiku` | `claude-haiku-5-5` | Haiku 5.5 | 5 段階 |
| `claude-haiku-4-5-20251001` | 同じ | Haiku 4.5 | 無し（`supportsEffort` も無い） |
| `claude-sonnet-5`、`claude-opus-5`、`claude-fable-5`、`claude-opus-4-8`、`claude-opus-4-7` | 同じ | 各名前 | 5 段階 |
| `claude-opus-4-6`、`claude-sonnet-4-6` | 同じ | 各名前 | low・medium・high・max（xhigh が無い） |

- `default` は model ではなく「account の既定に戻す」値（https://code.claude.com/docs/en/model-config#model-aliases）。一覧に出すかは UI 側で決める。
- alias の行と明示の id の行は同じ model を指すことがある（`opus` と `default` はどちらも `claude-opus-5-5`）。保存した id を一覧と突き合わせるには `resolvedModel` を使う（`sdk.d.ts:1397-1399` の説明どおり）。

### Chat の spare との関係

- spare（`startup()`）は Chat の options で既に initialize を済ませている。ただし `WarmQuery` から一覧は読めない。
- 一覧のための claude を別に起こすと、Chat の「同時に 4 つまで」（`chat-agent.ts:26`）に数えるか決める必要がある。一覧は login と managed settings が変わらない限り同じなので、Backend が 1 度取って持つ形にできる。
- `prewarm()` の `SpareProcess.claim()` が返す `Query` も `supportedModels()` を持つ（`sdk.d.ts:9443-9447`）。claim の時点では prompt を送っているので、prompt 無しの一覧取得には使えない。

## 2. query ごとに model と effort を渡す

### 起動時の options

- `options.model?: string`（`sdk.d.ts:1963`）。alias（`haiku`）でも id（`claude-haiku-5-5`）でもよい。CLI の `--model` と同じで、`ANTHROPIC_MODEL` と settings の `model` より強い（https://code.claude.com/docs/en/cli-reference#cli-flags）。
- `options.effort?: EffortLevel`（`sdk.d.ts:1914`）。`EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'`（`sdk.d.ts:691`）。
- `options.thinking?: ThinkingConfig`（`sdk.d.ts:1907`、型は `sdk.d.ts:9766`）。`{ type: 'adaptive' }`・`{ type: 'enabled', budgetTokens }`・`{ type: 'disabled' }`。対応する model では adaptive が既定（docs の Options 表）。
- `options.maxThinkingTokens` は deprecated で、`thinking` に置き換える（`sdk.d.ts:1916-1923`）。
- `options.fallbackModel?: string`（`sdk.d.ts:1685`）。主の model が過負荷のときに替える先。

### 途中で替える

- `Query.setModel(model?: string)`（`sdk.d.ts:2897`）。streaming input mode（prompt が AsyncIterable）でだけ使える。`undefined` か `'default'` で既定に戻る（docs の Query の Methods）。0.3.268 から、知らない model id は API に問い合わせて確かめる（CHANGELOG）。
- effort を替える method は無い。`Query.applyFlagSettings({ effortLevel })`（`sdk.d.ts:2952-2954`）で替える。`null` は model の既定の effort に戻す。`'max'` を受け、max に対応しない model では `'high'` で走る（`sdk.d.ts:2930-2950` の説明）。
- `Query.setMaxThinkingTokens()`（`sdk.d.ts:2924`）は deprecated。
- `prewarm()` の `claim()` は `ClaimOptions.model` と `ClaimOptions.settings`（`{ effortLevel: 'high' }` のような flag の settings）を受ける（`sdk.d.ts:315-359`）。tools・env・settingSources のような「host 全体の options」は prewarm の時点で決まり、model と effort は claim で決められる。どちらも `@alpha`。

### effort の値と model の対応

docs（https://code.claude.com/docs/en/model-config#adjust-effort-level）:

| model | 選べる段階 |
|---|---|
| Fable 5.1、Fable 5 | low・medium・high・xhigh・max |
| Opus 5.5、Sonnet 5.5、Haiku 5.5、Opus 5、Sonnet 5、Opus 4.8、Opus 4.7 | low・medium・high・xhigh・max |
| Opus 4.6、Sonnet 4.6 | low・medium・high・max |

- 表に無い model（Haiku 4.5 など）は effort に対応しない。実機の一覧でも Haiku 4.5 の行は `supportsEffort` を持たない。
- 対応しない段階を渡すと、対応する段階のうち渡した値以下で最も高いものに落ちる（例: Opus 4.6 の xhigh は high で走る）。
- 既定: Opus 5.5・Sonnet 5.5・Haiku 5.5 は medium、Opus 4.7 は xhigh、ほかの対応 model は high。
- 決まる順: env の `CLAUDE_CODE_EFFORT_LEVEL` か `--effort` → settings → model の既定。Chat は env を `USER` と `HOME` しか通さないので（ADR-0033）、`options.effort` がそのまま効く。
- org や settings の `maxEffortLevel` が上限をかける（`sdk.d.ts:9017-9019`）。
- 実際に送る effort は `system`（`init`）の `effort` に出る（`sdk.d.ts:6003-6006`）。ただし説明は「Remote Control bridge の init にある。publish しない host では無い」と書くので、SDK の stdio で必ず届くとは限らない。0.3.234 で入った（CHANGELOG）。

### Chat の spare との関係

`startup()` の spare は options を spawn 時に決めるので、ask ごとに model と effort を変えるには次のどれかになる。どれを選ぶかは決めていない。

- spare を (model, effort) ごとに持つか、選んだ値と spare の値が違えば spare を捨てて `query()` で起こす。
- spare の `warm.query(prompt)` の後で `setModel()` と `applyFlagSettings({ effortLevel })` を呼ぶ。ただし `singleTurn`（`prompt.ts:23`）は message をすぐに流すので、最初の request が替わる前の値で出る恐れがある。message を流すのを method の resolve まで待たせる必要がある。
- `prewarm()` と `claim({ options: { cwd, model, settings: { effortLevel } } })` に移る。claim は settings の overlay を受けてから prompt を読むと docs が書く（`sdk.d.ts:339-359`）。alpha の API で、`startup()` からの書き換えになる。

## 3. WebSearch と WebFetch

### 載せ方と許し方

- `tools`（`sdk.d.ts:1641`）は載せる built-in の tool の集合を決める。`[]` は全部外す。
- `allowedTools`（`sdk.d.ts:1585`）は「聞かずに走らせる」tool の一覧で、載せる tool を絞らない。
- `disallowedTools`（`sdk.d.ts:1605`）は名前だけなら tool を context から外す。今の `['mcp__*']` は MCP の tool を外すだけで、WebSearch と WebFetch には当たらない。
- `permissionPrompts: 'none'`（`sdk.d.ts:2014-2021`）は「prompt になるはずのものを即座に拒否し、`canUseTool` は呼ばない」。
- docs の tools reference は、WebFetch と WebSearch をどちらも「Permission required: Yes」とする（https://code.claude.com/docs/en/tools-reference）。WebSearch の permission rule は名前だけで、domain などの指定を取らない。WebFetch は `WebFetch(domain:example.com)` の形で domain ごとに許せる。
- `permissionMode` を渡さないと、claude は settings の `defaultMode` か `auto` から始める（`sdk.d.ts:1981-1995`）。Chat は settings を読まないので、実機の init の `permissionMode` は `default` だった。

### restricted mode

docs（https://code.claude.com/docs/en/cli-reference の `--restricted`、env は https://code.claude.com/docs/en/env-vars の `CLAUDE_CODE_RESTRICTED`）:

> Claude Code removes the built-in tools that run commands or code, and WebFetch, unless you name them individually in `--tools`, not through the `default` preset.

Chat は `CLAUDE_CODE_RESTRICTED=1` を渡す（`claude.ts:46`）。`tools: ['WebSearch', 'WebFetch']` と名前で書けば WebFetch も残る。WebSearch は restricted で外す対象に入っていない。

### 実機

Chat と同じ options（`settingSources: []`、`strictMcpConfig: true`、`disallowedTools: ['mcp__*']`、`permissionPrompts: 'none'`、`CLAUDE_CODE_RESTRICTED=1` を含む env、`model: 'haiku'`、`effort: 'low'`）のうち、`tools` だけを `['WebSearch', 'WebFetch']` に替えて、WebSearch と WebFetch を 1 回ずつ使わせた。

- `allowedTools` 無し: init の tools は `["WebFetch", "WebSearch"]`。2 つとも呼ばれたが「this session has no approval surface」で自動で拒否され、result の `permission_denials` に 2 件入った。total_cost_usd は 0.00085。
- `allowedTools: ['WebSearch', 'WebFetch']` を足した: 2 つとも走り、検索結果と `example.com` の h1 を返した。`permission_denials` は空。total_cost_usd は 0.0122。差の約 0.01 USD はおおよそ検索 1 回の料金（下の「料金」）にあたる。
- どちらも restricted のまま WebFetch が載った。

### 必要なものと料金

- WebSearch は Claude API・Claude Platform on AWS・Microsoft Foundry で使える。Google Cloud は Claude 4 以降の model で使える。Amazon Bedrock では使えない（https://code.claude.com/docs/en/tools-reference#websearch-tool-behavior）。Chat は認証と接続先の env を通さず plan の login で動くので（ADR-0033）、first party になる。
- WebSearch は 1 回の呼び出しで backend の検索を最大 8 回出す。docs は結果を title と URL だけと書き、ページを読むには WebFetch を続けて使うとする（同上）。実機の tool_result にはページの中身をまとめた文章も入る（下の「WebFetch を検索結果の URL に絞る gate」）。
- API の料金は 1,000 検索あたり 10 USD と token の料金（https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool#usage-and-pricing）。plan の login で、検索が plan の使用量にどう数えられるかは docs で見つけられなかった。
- WebFetch は取ったページを Markdown にし、ページの中身に prompt を当てる別の model の呼び出しをして、その結果を Claude に渡す。1 回 100,000 字まで、15 分 cache する。`localhost` と dot の無い host は断る。別の host への redirect は追わずに伝える（https://code.claude.com/docs/en/tools-reference#webfetch-tool-behavior）。
- WebFetch は取る前に domain の安全確認を通す（同上の「WebFetch domain safety check」）。Team と Enterprise の claude.ai account では、org の policy が WebFetch を許すと読めるまで WebFetch を出さない（同上の「WebFetch availability」）。
- 1 session の WebSearch の上限は既定 200 回で、`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` で上げられる（env-vars）。Chat は ask ごとに新しい claude なので、この上限に届く見込みは小さい。
- tool の入力の型: `WebSearchInput { query; allowed_domains?; blocked_domains? }`、`WebFetchInput { url; prompt; offset? }`（`sdk-tools.d.ts:1099-1126`）。`offset` は 0.3.290 で入った（CHANGELOG）。実機の WebSearch の tool_use には型に無い `mode: "standard"` も入っていた。

### 今の Chat の作りとぶつかる所

- ADR-0033 は「ページの本文は誰でも書ける入力で、agent への指示を紛れ込ませられる」から tool を持たないと決めた。WebFetch を持たせると、ページの本文に埋めた指示で、会話の中身を埋めた URL を取りに行かせられる（取得そのものが外への送信になる）。ADR-0033 の Consequences の「回答の markdown の外の画像」と同じ種類の経路が、model 自身の tool 呼び出しで開く。WebSearch の query にも会話の中身を載せられる。
- WebFetch は `WebFetch(domain:…)` の rule で domain を絞れる。ただし Chat は `settingSources: []` なので、rule は `allowedTools` か `options.settings`（flag の settings、restricted でも読まれる）で渡すことになる。
- `answer()`（`chat-agent.ts:196`）は text の delta と `assistant` の text を流す。tool を使うと assistant の message が複数になり、tool の前置きの text も答えに入る。tool_use と tool_result は今は流さない。
- `ADDED_ENV` に `CLAUDE_CODE_RESTRICTED=1` を残せば、WebFetch は `tools` に書いたときだけ載るので、ほかの「command やコードを走らせる tool」は外れたままになる。

## WebFetch を検索結果の URL に絞る gate

WebFetch で取れる URL を、同じ session の WebSearch が返した URL だけに絞れるかを実機で確かめた。条件は上の「実機」と同じ（`settingSources: []`、`strictMcpConfig: true`、`disallowedTools: ['mcp__*']`、`permissionPrompts: 'none'`、`CLAUDE_CODE_RESTRICTED=1` を含む env、`model: 'haiku'`、`effort: 'low'`、`tools: ['WebSearch', 'WebFetch']`）。`allowedTools` には WebSearch を必ず入れ、WebFetch は入れる場合と入れない場合を両方試した。model には「WebSearch で "Claude Shannon Wikipedia" を検索し、`https://example.com/?q=secret` を WebFetch し、検索結果の 1 件目を WebFetch する」と頼んだ。1 回の run は 0.017 USD 前後。

### 結論

- `hooks.PreToolUse`（matcher `WebFetch`）で URL ごとに許可と拒否を決められる。`settingSources: []` でも hook は効く（SDK の option の callback で、settings から読むものではない）。
- hook が `allow` を返すと、`allowedTools` に WebFetch が無くても、`permissionPrompts: 'none'` のままで WebFetch が走る。
- `canUseTool` は `permissionPrompts: 'none'` では呼ばれない。gate には使えない。
- 許す URL の一覧は `hooks.PostToolUse`（matcher `WebSearch`）の `tool_response.results[].content[].url` から作れる。stream の `SDKUserMessage.tool_use_result` にも同じ形で入る。
- 検索結果に無い URL（`https://example.com/?q=secret`）は拒否され、検索結果の URL（`https://en.wikipedia.org/wiki/Claude_Shannon`）は取れた。別 host への redirect は WebFetch が追わず、model が redirect 先を取り直す呼び出しは gate で拒否された。

### 1. WebSearch の tool_result の中身

model に返る tool_result は 1 つの文字列で、次の 3 つが並ぶ（実機の抜粋）。

````text
Web search results for query: "Claude Shannon Wikipedia"

Links: [{"title":"Claude Shannon","url":"https://en.wikipedia.org/wiki/Claude_Shannon"},{"title":"Claude Shannon","url":"https://www.Wikipedia.org/wiki/THROBAC"}, ...（9 件）..., {"title":"g.co","url":"https://g.co/kg/m/01qkx"}]

The top result is the English Wikipedia article on Claude Shannon. Its opening describes him as a polymath: ...

- **Dates and origin:** He was born April 30, 1916, and died February 24, 2001, ...
- **Master's thesis:** In 1937, his MIT thesis showed that electrical applications of Boolean algebra could construct any logical numerical relationship.
...
Some search results were mirror or copy sites (such as wikipedia.com and a bme.hu archive), so the en.wikipedia.org link is the authoritative version.

REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.
````

- `Links:` の JSON は title と URL だけ。
- その後に、検索結果のページの中身をまとめた数段落の文章が続く。本文そのものではないが、ページに書かれた事実（生年月日・論文名・経歴）が入る。docs の「result titles and URLs」（https://code.claude.com/docs/en/tools-reference#websearch-tool-behavior）より多い。`WebSearchOutput.results` の型も `{ tool_use_id, content: { title, url }[] } | string` で、説明は「Search results and/or text commentary from the model」（`sdk-tools.d.ts:3747-3776`）。WebSearch は内部で別の model に server 側の検索をさせ、その model の文章も返す。
- ページの中身が要約を通って model に届くので、ページに埋めた指示が WebFetch を使わなくても検索の時点で届きうる。
- 末尾に「出典を markdown の link で書け」という REMINDER が付く。Chat の答えにも出典の link が入る。

### 2. 検索結果の URL を機械的に取り出す

2 つの口があり、どちらも `WebSearchOutput` の形を持つ。

- `hooks.PostToolUse` の `tool_response`（`PostToolUseHookInput`、`sdk.d.ts:2658-2663`）。実機の keys は `["query","results","durationSeconds","searchCount"]`。
- stream の `type: 'user'` の message の `tool_use_result`（`SDKUserMessage.tool_use_result`、`sdk.d.ts:6290-6293`）。tool_result の block と同じ message に入り、`tool_use_id` で WebSearch の `tool_use` と結べる。

```json
{"query":"Claude Shannon Wikipedia","results":[{"tool_use_id":"srvtoolu_01GN...","content":[{"title":"Claude Shannon","url":"https://en.wikipedia.org/wiki/Claude_Shannon"}, ...]},"The top result is the English Wikipedia article ..."]}
```

- `results` の要素は object（検索 1 回分の hit）と string（上の要約）が混ざる。URL は object の `content[].url` だけから取る。
- tool_result の文字列の `Links:` の JSON を parse しても取れるが、文字列の形は型で決まっていない。
- gate の一覧は PostToolUse で作る。PostToolUse は WebSearch の結果を model に返す前に CLI の中で走るので、その結果を見た model が出す WebFetch の PreToolUse より先に一覧ができる（今回の 4 回の run でもそうだった）。stream は SDK の側で非同期に読むので、読み終える前に PreToolUse が来る順序を排除できない（今回の run では順序の崩れは見ていない）。
- 実機の結果には `https://www.Wikipedia.org/...` のような大文字の host が混ざった。突き合わせは両方を `new URL(u).href` に揃えて行った。

### 3. WebFetch の呼び出しごとに許可と拒否を決める口

| 口 | `allowedTools` に WebFetch 無し | `allowedTools` に WebFetch あり |
|---|---|---|
| `canUseTool` | 呼ばれない。2 件とも「no approval surface」で自動で拒否 | 呼ばれない。allow rule で 2 件とも走り、`?q=secret` も取れた |
| `hooks.PreToolUse` | 呼ばれる。`allow` で走り、`deny` で拒否 | 呼ばれる。`deny` が allow rule より先に効く |

- `canUseTool` が呼ばれないのは `permissionPrompts` の説明どおり（`sdk.d.ts:2014-2021` の「`canUseTool` is never called」）。`allowedTools` で許した tool も `canUseTool` を通らない（https://code.claude.com/docs/en/agent-sdk/permissions の「Auto-approved tools never reach `canUseTool`」）。
- 評価の順は hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool`（同じ docs の「How permissions are evaluated」）。hook の `deny` は allow rule より先に決まる。docs は hook の `allow` も deny と ask の rule を飛ばさないと書く。Chat は rule を `disallowedTools: ['mcp__*']` しか持たないので WebFetch には当たらない。
- 実機では、hook の `allow` だけで（`allowedTools` に WebFetch が無いまま）WebFetch が走った。gate を hook に置くなら `allowedTools` に WebFetch を入れない方がよい。hook が `allow` を返さなかったとき、allow rule で走らずに `'none'` の自動拒否に落ちるため（hook が例外を投げたときの扱いは確かめていない）。
- hook の型: `PreToolUseHookInput { tool_name, tool_input, tool_use_id }`（`sdk.d.ts:2741-2747`）、返す値は `hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason }`（`sdk.d.ts:2749-2755`）。`permissionDecision` は `'allow' | 'deny' | 'ask' | 'defer'`（`sdk.d.ts:984`）。`options.hooks` は `sdk.d.ts:1731`。

hook で拒否したとき model に返る tool_result（`is_error: true`）:

```text
PreToolUse:WebFetch hook error: URL not in search results: https://example.com/?q=secret
```

- 後半は `permissionDecisionReason` に渡した文字列そのまま。result の `permission_denials` にも 1 件入る。
- model は拒否を受けて次の手順に進み、最後の答えに拒否の文言を引用した。

`'none'` の自動拒否で model に返る tool_result（比較用）:

```text
Permission for this tool use was denied. It requires approval, and this session has no approval surface — nobody can answer a permission prompt here — so it was denied automatically. The action was NOT performed; do not claim it succeeded, and do not retry it: ... What required approval: Claude requested permissions to use WebFetch, but you haven't granted it yet.
```

gate の probe の骨格（scratchpad の `gate.ts` から抜粋）:

```ts
const allowed = new Set<string>()
const norm = (u: string) => new URL(u).href

hooks: {
  PostToolUse: [{ matcher: 'WebSearch', hooks: [async (input) => {
    for (const r of input.tool_response?.results ?? [])
      if (typeof r !== 'string') for (const c of r.content) allowed.add(norm(c.url))
    return { continue: true }
  }] }],
  PreToolUse: [{ matcher: 'WebFetch', hooks: [async (input) => {
    const ok = allowed.has(norm(input.tool_input.url))
    return { hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: ok ? 'allow' : 'deny',
      permissionDecisionReason: ok ? 'URL is in search results' : `URL not in search results: ${input.tool_input.url}`,
    } }
  }] }],
},
allowedTools: ['WebSearch'],
```

### 4. WebFetch が model に返すもの と redirect

- model に返るのは取ったページそのものではなく、WebFetch の `prompt` をページに当てた別の model 呼び出しの答え。`example.com` に「What is the h1?」で頼むと tool_result は `The h1 is **"Example Domain"**.` の 1 行だった（`tool_use_result` は `{ bytes: 577, code: 200, codeText: "OK", result, durationMs, url }`、型は `sdk-tools.d.ts:3716-3740` の `WebFetchOutput`）。docs も「runs the prompt against the content in a separate model call, and Claude receives the result of that call rather than the raw page」と書く（https://code.claude.com/docs/en/tools-reference#webfetch-tool-behavior）。
- 長いページは 100,000 字までで切り、その旨を tool_result の末尾に足す（実機: `[WebFetch note: this page's text is 274521 characters long and the answer above covers only characters 0 to 100000; ... call WebFetch again with the same url and offset: 100000.]`）。`offset` を付けた呼び出しも同じ URL なので gate を通る。
- result の `modelUsage` には `claude-haiku-5-5` の 1 行しか出なかった。抽出の model が何で、その費用がどこに数えられるかは stream から分からなかった。

redirect（gate の一覧に redirect する URL を 1 つ足して試した）:

- `https://httpbin.org/redirect-to?url=https://example.com/` → tool_result は `REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically.` に続けて、元の URL・`Redirect URL (from the server's Location header — server-supplied, not verified): https://example.com/`・`Status: 302 Found`・「この url でもう一度 WebFetch を呼べ」という指示。`tool_use_result.code` は 302。
- model は指示どおり `https://example.com/` で WebFetch を呼び直し、PreToolUse が一覧に無いので拒否した。
- 検索結果に実際に出た短縮 URL `https://g.co/kg/m/01qkx`（→ `https://www.google.com/search?...`）でも同じで、redirect 先の取得は gate で拒否された。
- docs は、別 host への redirect は追わずに伝え、同じ host への redirect は追うと書く（同上の「When a URL redirects to a different host ...」と「including any redirects WebFetch follows」）。同じ host の redirect 先は server が決める URL で、model が会話の中身を載せる口にはならない。

### 5. restricted mode

5 回の run のすべてで、`CLAUDE_CODE_RESTRICTED=1` のまま init の tools が `["WebFetch","WebSearch"]` だった。`tools` に名前で書けば WebFetch が残る（上の「restricted mode」と同じ）。

### gate で塞げないもの

- 検索結果の URL は、検索に引っかかるページを作れる人なら選べる。gate は「model が URL を組み立てる」経路を塞ぐが、query string まで決まった URL を検索結果に載せる経路は残る。ただし URL は検索の時点で決まっているので、会話の中身を後から載せることはできない。
- WebSearch の `query` には会話の中身を載せられる。送り先は Anthropic の検索 backend で、任意の host ではない。
- 1 で書いたとおり、ページの中身は WebSearch の要約を通って model に届く。指示を紛れ込ませる入口は WebFetch を外しても残る。
- 確かめていないこと: hook が例外を投げたときの扱い、PreToolUse で `updatedInput` を返して URL を書き換えられるか、domain safety check に落ちた URL の tool_result の形。

## 4. SDK の版

- 入っている版: `@anthropic-ai/claude-agent-sdk@0.3.293`（`package.json:10` の catalog、`bun.lock:262,318`）。同梱の Claude Code は `claudeCodeVersion: "2.1.293"`（SDK の `package.json:91`）。
- CHANGELOG の最新は 0.3.296。
- 1〜3 で使うものの入った版:
  - `ModelInfo.supportsEffort` / `supportedEffortLevels` / `supportsAdaptiveThinking`: 0.2.49
  - `EffortLevel` の export: 0.2.84
  - `startup()`: 0.2.89（public になったのは 0.2.111）
  - `applyFlagSettings()` の文書化と `null`: 0.2.132。`effortLevel: 'max'` の型: 0.3.214
  - `system/init` の `effort`: 0.3.234
  - `setModel()` が知らない id を API で確かめる: 0.3.268
  - `prewarm()` と `claim()`（alpha）: 0.3.282
  - `WebFetchInput.offset`: 0.3.290
- どれも 0.3.293 に入っていて、実機でも動いたので、上げる必要は無い。

## 確かめていないこと

- `supportedModels()` の initialize の間に claude が API へ問い合わせるか。result と usage は出なかった。
- plan の login で WebSearch と WebFetch が plan の使用量にどう数えられるか。
- SDK の stdio で `system`（`init`）の `effort` が届くか（実機の script では見ていない）。
- `setModel()` / `applyFlagSettings()` を spare の `warm.query()` の直後に呼んだとき、最初の request に間に合うか。
