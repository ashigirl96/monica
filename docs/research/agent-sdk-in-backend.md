# Backend の中で Agent SDK を動かす

wayfinder の map #254「ブラウザ拡張の side panel で、開いているページについて質問できるチャットを作る」のチケット #257「Backend の中で Agent SDK を動かせるか」で調べた事実。どう動かすかは map の「Backend で agent をどう動かすか」で決める。ここには事実と数字だけを置く。

確かめた環境: macOS 26.6.2（arm64）、Bun 1.4.2、`@anthropic-ai/claude-agent-sdk` 0.3.293（同梱の claude は 2.1.293）、PATH の claude 2.1.292（native installer の `~/.local/bin/claude`）、Claude Team の plan の login（macOS の keychain）、model は alias `haiku`。【実機】と書いたものは、scratchpad の空の directory に SDK を入れ、`docs/research/agent-sdk-in-backend/` の script を `env -i` で絞った env から起こして確かめた。haiku を呼んだ turn は 14 回（ほかに不正な API key で 401 になった 1 回）。

## 要点

| 問い | 答え |
|---|---|
| compiled binary から `query()` を呼べるか | 【実機】呼べる。ただし claude の場所を渡さないと、起動時の cwd で結果が変わる。cwd が `/` だと `Native CLI binary for darwin-arm64 not found` で落ち、`node_modules` のある directory だとそこの claude を拾った |
| claude を同梱したとき | 【実機】`import … with { type: 'file' }` と `extractFromBunfs` で動く。binary は 68.6MB から 306.8MB になる。起動のたびに 236MB を読んで hash を取り（117〜242ms）、Backend の RSS が約 45MB から約 507MB に増えて、`Bun.gc(true)` の後も戻らなかった |
| PATH の claude を使うとき | 【実機】`pathToClaudeCodeExecutable` に `~/.local/bin/claude`（2.1.292）を渡すと動く。Backend の login shell の PATH にあるのはこれで、Tab の wrapper（`~/.monica/bin`）は無い。ただし `haiku` が `claude-haiku-4-5-20251001` に解決された（同梱の 2.1.293 では `claude-haiku-5-5`） |
| plan の login で動くか | 【実機】動く。`apiKeySource` は `none`、`accountInfo()` は `Claude Team`。PATH を launchd の既定（`/usr/bin:/bin:/usr/sbin:/sbin`）に絞っても keychain の login を読めた |
| `ANTHROPIC_API_KEY` があるとどちらを使うか | 【実機】API key を使い、login には戻らない（不正な値で 401）。docs の順位でも API key は `/login` より上。この Mac の shell と launchd の env には無い |
| 設定を切れるか | 【実機】isolated の options で tools 0・MCP 0・入力 637 token になり、既定（tools 27・MCP 8・入力 23,426 token）から外れた。`~/.claude/projects` にも `~/.claude.json` の projects にも cwd の跡は残らなかった。CLI 同梱の plugin 4 つと bundled skill 19 個は init に出る |
| multi-turn | 【実機】1 つの `query()` と 1 つの pid で 3 turn 話せ、前の turn を覚えていた。`includePartialMessages` で `text_delta` を受け取れた |
| 最初の token まで | 【実機】先に起こした process（`startup()` / `prewarm()`）なら送ってから 0.63 秒、起こしながら送ると 1.0〜1.6 秒。CLI が request を出すまでの時間が 85〜541ms から 14〜18ms に縮む。残りは API の待ちで、712〜1,315ms の幅で揺れた |
| メモリ | 【実機】claude 1 つで 270〜290MB。既定の options では user の MCP server も起き、計 1.04GiB |
| 子 process が残るか | 【実機】待機中の claude は親が死んで 0.5〜1 秒で消える。turn の途中なら 5〜10 秒残り、turn を終えてから消えた |

## SDK の形

- 本体の package は約 5.3MB で、claude は platform ごとの optionalDependencies（8 つ）に入る。darwin-arm64 の `claude` は 236,330,608 byte の native binary で、署名は `com.anthropic.claude-code`（Team ID `Q6L2SF6YDW`、hardened runtime）。【実機】`codesign -dv`
- peerDependencies は `zod ^4`、`@anthropic-ai/sdk >=0.93.0`、`@modelcontextprotocol/sdk ^1.29.0`。package.json の `claudeCodeVersion` は `2.1.293`。【実機】
- docs は、1 つの session が 1 つの subprocess になり、stdio で話すとしている。同梱の binary は SDK の版に固定される。
  - https://code.claude.com/docs/en/agent-sdk/hosting#the-subprocess-model
- `query()` に渡す `env` は子の env を丸ごと置き換える。省くと `process.env` を継ぐ（`sdk.d.ts` の `Options.env`）。

## 1. compiled binary の中から呼ぶ

### claude の探し方

- `pathToClaudeCodeExecutable` が無いと、SDK は `createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')` で探し、見つからなければ `Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.` を投げる（0.3.293 の `sdk.mjs`）。
- README と docs は、compiled binary の `$bunfs` では `require.resolve` が効かないので、platform の package の binary を file として埋め、`extractFromBunfs` で実の path に出して渡す形を示している。
  - https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk （0.3.293 の README「Compiled binaries」）
  - https://code.claude.com/docs/en/agent-sdk/typescript#compile-to-a-single-executable
- 【実機】Backend と同じ flag（`--compile --minify-whitespace --minify-syntax --bytecode --format=esm`、`scripts/build.ts`）で compile して起こした結果。

  | binary | claude の渡し方 | 起こした cwd | 結果 |
  |---|---|---|---|
  | `bun run probe.ts` | 渡さない | scratch（`node_modules` あり） | 動く（`node_modules` の 2.1.293） |
  | compiled、同梱なし | 渡さない | scratch（`node_modules` あり） | cwd の `node_modules` の claude を拾って動いた |
  | compiled、同梱なし | 渡さない | `/` | `Native CLI binary for darwin-arm64 not found` |
  | compiled、同梱なし | `~/.local/bin/claude` | `/` | 動く（2.1.292） |
  | compiled、同梱あり | `extractFromBunfs` の戻り値 | `/` | 動く（2.1.293） |

### claude を同梱したとき

- 【実機】`import binPath from '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude' with { type: 'file' }` の値は `/$bunfs/root/claude-ajke7f87.` になり、`extractFromBunfs` は `/tmp/claude-501/claude-agent-sdk-4e21122a227857da/claude-ajke7f87.` に書き出した。書き出した file も同じ署名を持つ。
- `extractFromBunfs` は呼ぶたびに埋めた file 全体を `readFileSync` で読み、sha256 の先頭 16 桁で directory を決め、既にあれば書かずに返す。書き出し先は `CLAUDE_CODE_TMPDIR` か、macOS では `/tmp/claude-<uid>`（0.3.293 の `extractFromBunfs.js`）。
- 【実機】数字。

  | 項目 | 値 |
  |---|---|
  | compiled binary の大きさ | 同梱なし 68.6MB、同梱あり 306.8MB |
  | `bun build --compile` の時間 | 同梱なし 0.5 秒、同梱あり 1.5 秒 |
  | `extractFromBunfs` | 初回（書き出しあり）242ms、2 回目以降 117〜221ms |
  | 書き出した claude の最初の起動 | `startup()` の準備が 1,901ms（2 回目以降 255〜270ms） |
  | 親（Backend にあたる process）の RSS | 取り出す前 45MB、取り出した後 507MB、`Bun.gc(true)` の後 507MB。同梱しない compiled binary は 50MB |

- 新しく置いた claude を初めて起こすときだけ遅い。`node_modules` に入れた直後の claude も、最初の `startup()` は 5,060ms かかった（2 回目から 283ms）。推論: macOS が新しい実行ファイルを初めて開くときの検査。
- 推論: `/tmp` は再起動で消えるので、再起動の後の最初の Backend は書き出しと最初の起動の遅れをもう一度払う。
- 【実機】`tsc` は `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` の import に型が無いと TS2307 を出した（TypeScript 7.0.2）。
- 推論: repo の bun は isolated linker なので（`docs/packages.md`）、apps/backend から platform の package を import するには、apps/backend の package.json にそれを直に書くことになる。

### PATH の claude を使うとき

- 【実機】Backend の `loginShellPath()` と同じ形（launchd 相当の最小の env から `zsh -ilc`）で取った PATH には `~/.local/bin/claude` があり、`~/.monica/bin` は無い。`~/.local/bin/claude` は `~/.local/share/claude/versions/2.1.292` への symlink。`~/.monica/bin` を前に置くのは Tab の shim だけ（`packages/workbench/src/tab-env.ts`）。
- 【実機】SDK 0.3.293 から 2.1.292 を起こしても、1 turn の会話は通った。
- 【実機】同じ `model: 'haiku'` でも、2.1.292 は `claude-haiku-4-5-20251001`、2.1.293 は `claude-haiku-5-5` で答えた（result の `modelUsage`）。推論: alias は claude の binary が解決するので、PATH の claude を使うと model がユーザーの入れた版で変わる。
- `prewarm()` は CLI が `--await-claim` を知らないと reject する（`sdk.d.ts` の `prewarm`）。
- docs は `pathToClaudeCodeExecutable` を、optional dependencies を入れなかったときか、対応外の platform のためのものとしている。
  - https://code.claude.com/docs/en/agent-sdk/typescript#options

## 2. 認証

- 【実機】`env -i` で HOME・USER・LOGNAME・SHELL・TMPDIR と PATH だけを渡して起こすと、plan の login で動いた。init の `apiKeySource` は `none`、`accountInfo()` は `subscriptionType: "Claude Team"`、`apiProvider: "firstParty"`。PATH は login shell のものでも launchd の既定（`/usr/bin:/bin:/usr/sbin:/sbin`）でも同じ。
- 【実機】login は login keychain の generic password（service `Claude Code-credentials`）にある。
- docs は、macOS では login を keychain に置き、`CLAUDE_CONFIG_DIR` を変えると別の keychain の entry を読むとしている。
  - https://code.claude.com/docs/en/authentication#credential-management
- docs の順位は、cloud provider → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → Anthropic profile → `/login` の login。非対話（`-p`）では API key があれば必ず使う。
  - https://code.claude.com/docs/en/authentication#authentication-precedence
- 【実機】`ANTHROPIC_API_KEY` に不正な値を入れて起こすと、`apiKeySource` は `ANTHROPIC_API_KEY` になり、結果は `Failed to authenticate. API Error: 401 API key is invalid.` で、login には戻らなかった。`accountInfo()` の `tokenSource` は `claude.ai` のまま。
- 【実機】この Mac では `ANTHROPIC_API_KEY`・`CLAUDE_CODE_OAUTH_TOKEN`・`ANTHROPIC_AUTH_TOKEN` は、Tab の shell の env にも `launchctl getenv` にも無い。Backend が login shell から取るのは PATH だけ（`apps/backend/src/login-shell-path.ts`）。
- 【実機】error の result の後、streaming input mode でも `query()` の iterator が `Claude Code returned an error result: …` を投げた。
- SDK は plan の上限の文言の先頭を `USAGE_LIMIT_ERROR_PREFIXES` などの定数で出している（`sdk.d.ts`）。
- docs は、事前の承認なしに第三者の製品で claude.ai の login を提供することを認めていない。自分の Mac で自分の plan を使う場合の扱いは charting の Notes（support の記事）にある。
  - https://code.claude.com/docs/en/agent-sdk/overview

## 3. 設定を切る

試した options（isolated）。

```ts
{
  model: 'haiku',
  cwd: '<空の directory>',
  settingSources: [],
  tools: [],
  skills: [],
  strictMcpConfig: true,
  persistSession: false,
  includePartialMessages: true,
  env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
}
```

【実機】既定（`model`・`cwd`・`persistSession: false`・`includePartialMessages` だけ）と並べた結果。cwd は同じ空の directory で、prompt も同じ。

| 項目 | isolated | 既定 |
|---|---|---|
| init の `tools` | 0 | 27 |
| init の `mcp_servers` | 0 | 8（user 6、plugin 2） |
| init の `plugins` | 4（`cc-plugin-*`） | 19 |
| init の `skills` | 19 | 72 |
| init の `agents` | 5（built-in） | 10 |
| init の `slash_commands` | 54 | 110 |
| init の `permissionMode` | `default` | `auto` |
| 1 turn の入力 token | 637 | 23,426 |
| 起きた子 process | claude 1 つ | claude と MCP server の 8 process（npm と node） |
| 子の RSS の計 | 約 280MB | 約 1.04GiB |
| `startup()` の準備 | 282〜283ms | 350〜362ms |

- user の CLAUDE.md（`~/.claude/CLAUDE.md` と `@` で読む `PATCH-SKILL.md`、計 3,890 byte）は 637 token の中に入りえない。推論: isolated では読んでいない。`InstructionsLoaded` の hook はどちらの run でも呼ばれず、hook では確かめられなかった。
- isolated でも init の `skills` に bundled の 19 個（`deep-research`、`update-config` など）が、`plugins` に CLI 同梱の `cc-plugin-sec-default`・`cc-plugin-agents-md`・`cc-plugin-telemetry`・`cc-plugin-plugin-authoring` が出る。`tools: []` なので Skill tool は無い。`skills` は文脈の filter で sandbox ではない（`sdk.d.ts` の `Options.skills`）。
- 既定の run でも init の `mcp_servers` に claude.ai の connector は出なかった。理由は未確認。
- 【実機】すべての run の後、`~/.claude` の下で probe の cwd を path か中身に含む file は無く（この session 自身の transcript を除く）、`~/.claude/projects` に cwd の directory は無く、`~/.claude.json` の `projects` にも cwd の key は無かった。
- `prewarm()` は `options.cwd` が無いと `~/.claude/spares/spare-*` に park し、close で消す（0.3.293 の `sdk.mjs`）。今回は scratch の directory を渡した。
- docs は、`settingSources: []` でも managed policy、`~/.claude.json`（常に読む）、auto memory、claude.ai の connector は読むとし、止め方を並べている。auto memory は `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、connector は `strictMcpConfig: true` か `ENABLE_CLAUDEAI_MCP_SERVERS=false`。
  - https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control
- `persistSession: false` は `~/.claude/projects/` に保存しない（`sdk.d.ts` の `Options.persistSession`）。
- 推論: dev の desktop を Tab や agent の Bash から起こすと、Backend は `CLAUDECODE` や `CLAUDE_CODE_*` を継ぐ。`env` を省くと claude の子にも届く。今回は `env -i` で外した。

## 4. multi-turn

- 【実機】`prompt` に AsyncIterable を渡し、result を受けるたびに次の user message を push した。3 turn とも同じ pid（92967）で答え、2 turn 目は 1 turn 目で覚えさせた語を返した。iterable を終えると `query()` の iterator も終わり、その時点で claude は居なかった。

  | turn | prompt | 答え | text_delta の数 | 送信から最初の delta | cache（作成 / 読み） | claude の RSS |
  |---|---|---|---|---|---|---|
  | 1 | 「kumquat を覚えて OK とだけ返して」 | `OK` | 1 | 1,562ms | 627 / 0 | 286MB |
  | 2 | 「覚えさせた語は」 | `kumquat` | 1 | 763ms | 50 / 627 | 286MB |
  | 3 | 「1 から 30 を並べて」 | `1 2 … 30` | 8 | 516ms | 60 / 677 | 288MB |

- 【実機】`stream_event` の `event` が `content_block_delta` で `event.delta.type` が `text_delta` のものに text が来た。
- 【実機】result の `total_cost_usd` と `duration_api_ms` は session の累計だった（`duration_api_ms` が 1,400 → 2,142 → 2,861）。
- docs は streaming input mode を推奨の形とし、1 つの query を長く生きる process として使うとしている。
  - https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode

## 5. 測った数字

### 最初の token まで

【実機】prompt はどれも「1 から 30 を空白で並べて」（出力 61 token）。isolated の options、`bun run`、login shell の PATH。「送信」は、事前に起こした場合は `warm.query()` / `spare.claim()` を呼んだ時刻、それ以外は `query()` を呼んだ時刻。CLI の値は result の `time_to_request_ms`（prompt を受けてから request を出すまで）。

| 起こし方 | 準備（spawn から initialize まで） | 送信から最初の text delta | CLI の time_to_request_ms | prompt cache |
|---|---|---|---|---|
| `query()`（1 回目） | 送信に含む | 973ms | 201ms | 作成 |
| `query()`（2 回目） | 送信に含む | 1,411ms | 311ms | 読み |
| `query()`、compiled で同梱 | 送信に含む | 1,311ms | 541ms | 作成 |
| `startup()` → `warm.query()` | 253ms | 628ms | 18ms | 読み |
| `prewarm()` → `spare.claim()` | 253ms | 635ms | 14ms | 読み |
| 起きている process の 2・3 turn 目 | なし | 763ms、516ms | 22ms、6ms | 読み |

- API の側（result の `ttft_ms`）は、haiku 5.5 の turn で 712〜1,315ms の幅で揺れた。
- 【実機】prompt を送らずに `startup()` の準備だけを測った値。isolated は 282〜283ms（compiled では 251〜270ms、PATH の 2.1.292 では 252〜258ms）、既定の options は 350〜362ms、`prewarm()` は 246〜296ms。
- `startup()` は folder と options を先に決めて spawn と initialize を済ませる。`prewarm()` は folder を決めずに起こし、tools・plugin・MCP の handshake も先に済ませる。`prewarm()` は alpha（`sdk.d.ts`）。
  - https://code.claude.com/docs/en/agent-sdk/typescript#startup

### メモリ

【実機】`ps` の RSS。

| process | RSS |
|---|---|
| claude、initialize の後に待機（isolated） | 270〜276MB |
| claude、1 turn の後 | 280〜289MB |
| claude、3 turn の後 | 288MB |
| `prewarm()` の spare | 270〜272MB（docs と `sdk.d.ts` は 230〜260MB） |
| claude、既定の options | 302〜315MB と MCP server の 5〜8 process。計 1.04GiB |
| 親、`bun run` | 55〜58MB |
| 親、compiled（同梱なし） | 50〜51MB |
| 親、compiled（同梱して `extractFromBunfs`） | 507〜513MB |

- docs は 1 agent あたり 1GiB を出発点とし、会話が長くなるとメモリが伸びるとしている。
  - https://code.claude.com/docs/en/agent-sdk/hosting

### 親が死んだときの子

【実機】親（probe）に signal を送り、claude が生きているかを `kill -0` で見た。「待機中」は `startup()` で起こしただけ、「turn の途中」は「1 から 400 を並べて」の text delta を受けている最中。

| 親 | 子の状態 | 親の止め方 | 子が消えた時刻 |
|---|---|---|---|
| `bun run` | 待機中 | SIGKILL | 0.5〜1.0 秒 |
| `bun run` | 待機中 | SIGTERM（handler なし） | 0.5〜1.0 秒 |
| `bun run` | 待機中 | SIGTERM で `process.exit(0)`（Backend の終了と同じ形） | 0.5〜1.0 秒 |
| compiled（同梱） | 待機中 | SIGKILL | 0.5〜1.0 秒 |
| `bun run` | turn の途中 | SIGKILL | 5 秒で生きていた（5 秒で見るのをやめた） |
| `bun run` | turn の途中 | SIGKILL | 5〜10 秒 |
| `bun run` | turn の途中 | SIGTERM（handler なし） | 5〜10 秒 |
| `bun run` | turn の途中 | SIGTERM で `q.close()` の後に `process.exit(0)` | 2.5〜5 秒 |

- 60 秒まで見た turn の途中の 3 回は、どれも 10 秒以内に子が消えた。
- 推論: 子は stdin の EOF で抜けるが、turn の途中なら turn を終えてから抜ける。その間も API への request は続き、plan の使用量を使う。親が死んだ後の子の ppid は 1 になる。
- SDK は起こした子を覚え、`process.on('exit')` で SIGTERM を送る。`close()` は stdin を閉じ、2,000ms 後に SIGTERM、さらに 5,000ms 後に SIGKILL を送るが、その timer は `unref` されている（0.3.293 の `sdk.mjs`）。推論: `close()` の直後に `process.exit()` すると、この timer は走らない。
- docs に、親が死んだときの子の扱いの記述は見つからなかった。

## 確かめていないこと

- `.app` から起こした（launchd が親の）Backend で keychain の login を読めるか。今回は terminal の process から `env -i` で起こした。
- Monica の自己署名と hardened runtime の下で、`/tmp` に書き出した claude を spawn できるか。
- login の token が期限切れになり、子の claude が refresh して keychain に書くときの振る舞い。
- 長い会話でのメモリの伸びと、複数の query を同時に持ったときの振る舞い。
- plan の上限に達したときの result の形。
- 既定の options で claude.ai の connector が init に出なかった理由。
- claude が `~/.claude.json` に何かを書くか。他の session が同時に書くので切り分けられなかった。
- turn の途中の `process.exit(0)` だけ（`close()` なし）の場合と、`interrupt()`。

## 試した script

`docs/research/agent-sdk-in-backend/` に置いた。`npm` 由来の 236MB の binary を入れるので repo の外の空の directory に写して使う。

- `probe-core.ts`: mode ごとに SDK を呼び、時刻・init・result・子 process の RSS を JSON 行で出す。mode は `cold`・`startup`・`prewarm`・`multi`・`baseline`・`init-only`・`init-only-baseline`・`prewarm-only`・`hold-idle`・`hold-turn`。
- `probe.ts`: 既定の解決か、env の `R257_CLAUDE_PATH` で claude を渡す entry。
- `probe-embed.ts`: claude を埋めて `extractFromBunfs` で渡す entry。compile は `bun build --compile --minify-whitespace --minify-syntax --bytecode --format=esm probe-embed.ts --outfile bin/probe-embed`。
- `login-path.sh`: Backend の `loginShellPath()` と同じ形で login shell の PATH を出す。
- `run.sh`: `env -i` で env を絞って起こす。
- `orphan.ts`: 親に signal を送り、子が消えるまでを見る。
- `claude-writes.ts`: 印の file より後に `~/.claude` の下で変わった file から、probe の cwd を含むものを探す（読むだけ）。

## 出典

- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/hosting
- https://code.claude.com/docs/en/agent-sdk/claude-code-features
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://code.claude.com/docs/en/authentication
- https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk （0.3.293 の README、`sdk.d.ts`、`sdk.mjs`、`extractFromBunfs.js`）
