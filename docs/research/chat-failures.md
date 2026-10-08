# Chat の失敗の届き方

wayfinder の map #254「ブラウザ拡張の side panel で、開いているページについて質問できるチャットを作る」のチケット #269「Chat の失敗の見せ方」を grilling で決めるために集めた事実。決めた形はチケットの resolution comment にある。ここには事実と数字だけを置く。

確かめた環境: macOS（Darwin 25.6.0、arm64）、Bun 1.4.2、`@anthropic-ai/claude-agent-sdk` 0.3.293（同梱の claude 2.1.293、`haiku` は `claude-haiku-5-5`）、Claude Team の plan の login、@orpc/* 1.15.4、hono 4.13.12、zod 4.6.5、HeadlessChrome 155（agent-browser 0.33.2）。【実機】と書いたものは scratchpad で動かして確かめた。agent は ADR-0033 の options（`settingSources: []`、`skills: []`、`tools: []`、`disallowedTools: ['mcp__*']`、`permissionPrompts: 'none'`、`strictMcpConfig: true`、`persistSession: false`、文字列の `systemPrompt`、空の cwd、env の `ENABLE_CLAUDEAI_MCP_SERVERS=false`・`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`）に `model: 'haiku'`、`effort: 'low'`、`title`、`includePartialMessages: true` を足し、prompt は文字列で 1 問だけ渡して `env -i` の下で起こした。API の失敗は `ANTHROPIC_BASE_URL` を手元の proxy に向けて作った。

## 要点

| 問い | 答え |
|---|---|
| API の失敗の形 | 【実機】`assistant`（`model: "<synthetic>"`、`error: SDKAssistantMessageError`、表示用の文字列）→ `result`（`subtype: "success"`、`is_error: true`、`terminal_reason: "api_error"`、`api_error_status`）。その 0.5〜1.4 秒後に iterator が `Error("Claude Code returned an error result: <result の文字列>")` を投げる |
| 速く分かる失敗 | 【実機】login 無し 0.2 秒、不正な API key 0.95 秒、plan の上限 0.5 秒（どれも再試行しない）、claude が起きない 5ms〜0.35 秒、SIGKILL 9〜22ms |
| 遅く分かる失敗 | 【実機】529・500・header の無い 429・network に届かないときは、CLI が 10 回再試行して 176〜186 秒かかる。その間は `system/api_retry` だけが来る |
| plan の使用量 | 【実機】成功した答えにも毎回 `rate_limit_event` が付く。上限では `status: rejected` と `resetsAt`・`rateLimitType`、使用率 90% 超では成功のまま `allowed_warning` と `utilization` |
| 途中で切れた API の stream | 【実機】CLI が答えを最初からやり直す。それまでの text delta はもう流れている |
| abort | 【実機】abort から約 2 秒 text delta が届き続け、`AbortError` になる。子の claude はその後も残る |
| oRPC の途中の error | 【実機】yield した後に投げた typed error は、それまでの値の後に `ORPCError` で届き、`isDefinedError` が true、`code`・`data` も届く。素の `Error` は `INTERNAL_SERVER_ERROR`「Internal server error」になる |
| Backend に届かない | 【実機】Chromium の fetch は、listen の無い port で `TypeError: Failed to fetch`（3ms）、stream の途中で server が死ぬと `TypeError: network error` |

## 1. SDK の型（`sdk.d.ts`）

- export される error の class は `AbortError`（:17）だけ。
- `SDKAssistantMessageError`（:3698）: `authentication_failed | oauth_org_not_allowed | account_on_hold | verification_required | billing_error | rate_limit | overloaded | invalid_request | model_not_found | server_error | unknown | max_output_tokens | cloud_credential_error`。`SDKAssistantMessage` の `error?` は :3619、`aborted?: true` は :3647。
- `SDKAPIRetryMessage`（:3590-3607）: `system/api_retry`。`attempt`、`max_retries`、`retry_delay_ms`、`error_status`（接続の失敗では null）、`error`、`no_response?`。
- `SDKRateLimitEvent`（:5664-5672）と `SDKRateLimitInfo`（:5677-5699）: `status: allowed | allowed_warning | rejected`、`resetsAt?`（unix 秒）、`rateLimitType?`（five_hour、seven_day、seven_day_opus など）、`utilization?`、`overageStatus?`、`overageResetsAt?`、`overageDisabledReason?`、`isUsingOverage?`、`surpassedThreshold?`、`errorCode?`。【実機】実行時には d.ts に無い `unifiedWindows: { five_hour: {utilization, resetsAt}, seven_day: {…} }` も入っていた。
- `SDKResultError`（:5701-5756）の subtype は `error_during_execution | error_max_turns | error_max_budget_usd | error_max_structured_output_retries`。【実機】今回の失敗では一度も来なかった。
- `SDKResultSuccess`（:5763-5844）: `is_error` :5806、`api_error_status?` :5807、`result` :5811、`stop_reason` :5812、`terminal_reason?` :5834。
- `SDKAuthStatusMessage`（:3700-3707）は CLI に `--enable-auth-status` を付けたときだけ出る。0.3.293 の SDK はこの flag を渡さない。
- plan の使用率を問い合わせる口: `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`（:3057）。
- SDK が投げる error（`sdk.mjs` の errorClass）: `aborted`（AbortError。"Claude Code process aborted by user"、"Operation aborted"、"Connection aborted"）、`executable_not_found`・`executable_launch_failed`（ReferenceError）、`process_exited_nonzero`（"Claude Code process exited with code N. stderr: …"）、`process_killed_by_signal`（"Claude Code process terminated by signal SIG…"）、`error_result`（上の置き換え）、`initialize_timeout`、`control_request_failed`。

## 2. 失敗ごとの message の並び

【実機】時刻は `query()` を呼んでからの ms。どの case でも `system/session_title_changed`・`system/init`・`system/status requesting` が約 0.2 秒で来る（下では省いた）。

| 失敗 | 来た message の並び | iterator が投げた error | 時間 |
|---|---|---|---|
| 正常 | stream_event…、assistant(text)、rate_limit_event(allowed)、result(success) | なし | 最初の text 1.0 秒、終わり 1.5 秒 |
| login 無し（`CLAUDE_CONFIG_DIR` を空の directory に） | assistant(`authentication_failed`, "Not logged in · Please run /login")、result(is_error, api_error_status null) | "…error result: Not logged in · Please run /login" | result 0.22 秒、throw 0.74 秒 |
| 不正な `ANTHROPIC_API_KEY` | assistant(`authentication_failed`, "Invalid API key · Fix external API key")、result(401) | 同じ形 | result 0.95 秒、throw 2.34 秒 |
| plan の 5 時間の上限（429 と header） | rate_limit_event(rejected, resetsAt, five_hour)、assistant(`rate_limit`, "You've hit your session limit · resets 10am (Asia/Tokyo)")、result(429) | 同じ形 | request 1 回。result 0.50 秒、throw 1.48 秒 |
| plan の週の上限 | 同じ形。seven_day、"You've hit your weekly limit · resets Oct 12 at 4:27pm (Asia/Tokyo)" | 同じ形 | throw 1.48 秒 |
| 使用率の警告（200 と allowed_warning） | 正常の並びのまま、rate_limit_event が allowed_warning、utilization 0.91、surpassedThreshold 0.9 | なし | 正常と同じ |
| header の無い 429 | api_retry×10、rate_limit_event(rejected、resetsAt 無し)、assistant(`rate_limit`, "API Error: Server is temporarily limiting requests (not your usage limit) · …")、result(429) | 同じ形 | 179.7 秒 |
| 529 | api_retry×10（delay 517、1046、2098、4292、8425、17692、35847、33859、38845、35885 ms）、assistant(**`server_error`**, "API Error: 529 Overloaded. …")、result(529) | 同じ形 | 179.8 秒 |
| 500 | api_retry×10、assistant(`server_error`, "API Error: 500 Internal server error. …")、result(500) | 同じ形 | 185.8 秒 |
| listen の無い port | api_retry×10(error_status null, `unknown`)、assistant(`server_error`, "API Error: Connection refused — …(ECONNREFUSED)")、result(null) | 同じ形 | 176.6 秒 |
| 引けない host | 同じ並び。"API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" | 同じ形 | 184.0 秒 |
| 再試行の途中で abort | api_retry×4 の後は何も来ない | AbortError "Claude Code process aborted by user" | abort から 2.0 秒 |
| path に何も無い | 何も来ない | ReferenceError "Claude Code native binary not found at <path>. …" | 5ms |
| 実行権の無い file | 何も来ない | ReferenceError "Claude Code native binary at <path> exists but failed to launch. …" | 5ms |
| 起きてすぐ exit 1 | 何も来ない | "Claude Code process exited with code 1. stderr: …" | 0.35 秒 |
| 最初の text の後で abort | abort の後も text delta が約 2 秒来る。assistant と result は来ない | AbortError "Claude Code process aborted by user" | abort から 2.0 秒。子は throw の 1.5 秒後も生きていた |
| 同じ abort を `spawnClaudeCodeProcess` で | abort から 2.0 秒後に SDK が子に SIGTERM を送り、`SpawnOptions.signal` も abort する。子は exit 143 で 3.18 秒後に終わり、それまで delta が来る | AbortError "Operation aborted" | 3.18 秒 |
| 最初の text の後で子を SIGKILL | 何も来ない | "Claude Code process terminated by signal SIGKILL" | 9〜22ms |
| proxy が 1 回だけ stream を切る | 一部の delta、CLI が作った `content_block_stop`・`message_stop`、api_retry(attempt 1)、新しい message_start から答えを最初からやり直す、assistant、result(success) | なし | 8.5〜9.7 秒。assistant と result は 2 回目の文字だけ |
| 毎回 EOF で切る | 2 回目から、CLI は stream しない request（`stream: false`、max_tokens 64000）に替え、答えを assistant 1 つで返す | なし | 10.3 秒 |
| 毎回 RST で切る（thinking が出た run） | CLI は途中まで残し、合成の user message "Your response above was cut off mid-stream. Resume directly from where it stops …" を足して続きを頼む。api_retry×10 の後、stream しない request で成功 | なし | 216.5 秒 |
| max_tokens（`CLAUDE_CODE_MAX_OUTPUT_TOKENS=60`） | message_delta が `stop_reason: "max_tokens"`、合成の user message（`isSynthetic: true`、"Output token limit hit. Resume directly …"）で続きを頼むのを 3 回、最後に assistant(`max_output_tokens`)、result(is_error, stop_reason "stop_sequence") | "…error result: API Error: Claude's response exceeded the 60 output token maximum. …" | 3.5〜4.6 秒 |

- 既定の request の max_tokens は 128000。
- 再試行は CLI 自身がする（`x-stainless-retry-count` は常に 0）。回数の既定は 10 で、CLI のコードでは env `CLAUDE_CODE_MAX_RETRIES` で変えられ、上限は 15（この env は試していない）。
- subscriber への 429 は、`anthropic-ratelimit-unified-representative-claim`・`-overage-status`・`-overage-disabled-reason` のどれかがあれば再試行しない（CLI のコード）。
- result の文字列は Mac の時刻帯で変わる。500 と 529 の末尾は、`ANTHROPIC_BASE_URL` を変えたときだけ gateway の一文になる。
- 【実機】run ごとに `~/.claude/sessions/<pid>.json` と `<pid>.<hash>.key` ができ、正常に終われば消える。SIGKILL で止めると残り、次に claude が起きたときに消える。`persistSession: false` なので projects には何もできない。

### plan の上限を真似た 429

```
status 429, body {"type":"error","error":{"type":"rate_limit_error","message":"…"}}
retry-after: <reset までの秒>
anthropic-ratelimit-unified-status: rejected
anthropic-ratelimit-unified-reset: <now+18000>
anthropic-ratelimit-unified-representative-claim: five_hour
anthropic-ratelimit-unified-5h-status: rejected / -5h-reset / -5h-utilization: 1.0
anthropic-ratelimit-unified-7d-status: allowed / -7d-reset / -7d-utilization: 0.4
anthropic-ratelimit-unified-overage-status: rejected
anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled
anthropic-ratelimit-unified-fallback-percentage: 0.5
```

header の名前は、本物の 200 の応答に付いていた `anthropic-ratelimit-unified-*` と、CLI の binary の中の mock（`setScenario("session-limit-reached")`）と header を読む関数から取った。本物の上限の 429 には当てていない。

## 3. oRPC の途中の error（RPCLink）

【実機】Bun と Chromium で同じだった。

| handler の throw | 先に yield した値 | 投げる場所 | client が受けるもの |
|---|---|---|---|
| 2 回 yield した後に `errors.X({ data })`（`.errors()` で宣言） | 届く | for-await | `ORPCError`、`isDefinedError` true、code・status・contract の message・data が届く |
| 同じ位置で素の `Error('…SIGKILL')` | 届く | for-await | `ORPCError`、`INTERNAL_SERVER_ERROR`・500・「Internal server error」。元の message は届かない |
| 同じ位置で `ORPCError('SERVICE_UNAVAILABLE', { message })` | 届く | for-await | `ORPCError`、503、渡した message。`isDefinedError` false |
| iterator を返す前に typed error | - | `await client.x()` が reject（HTTP 409 の JSON） | `ORPCError`、`isDefinedError` true、data が届く |

- wire では途中の error が `event: error` の 1 行（`{"json":{"defined":…,"code":…,"status":…,"message":…,"data":…}}`）になり、stream はそこで閉じる（standard-server-fetch の `dist/index.mjs:121-137`、client の `client.BrcgsQH9.mjs:374-384, 404-421`）。
- data が schema を通らない typed error は `defined: false` になる（`contract.D_dZrO__.mjs:15-29` を読んだだけ）。
- RPCHandler は最初と 5 秒ごとに SSE の comment を送る（`standard-server-fetch/dist/index.mjs:75-77`）。

### 繋がらないとき

| 場面 | Bun の fetch | Chromium の fetch | 分かるまで |
|---|---|---|---|
| listen の無い port | `TypeError`、`code: 'ConnectionRefused'` | `TypeError: Failed to fetch` | 0〜3ms |
| stream の途中で server を `kill -9` | for-await で `TypeError`、`code: 'ECONNRESET'` | `TypeError: network error` | 2〜6ms |
| `Bun.serve` の `stop(true)` | 同じ ECONNRESET | `TypeError: network error` | 0〜2ms |

- どれも、切れる前に yield した値は届いていた。どれも `ORPCError` ではない。

### client の abort

- 【実機】client の for-await は `DOMException` AbortError を投げ（Chromium では「signal is aborted without reason」）、server の handler の `signal` は 0〜1ms で abort した。generator の `finally` は走っている `await` が終わってから走った。

### retry の道具

- `ClientRetryPlugin`（`@orpc/client/plugins`）: 既定は `retry: 0`。event iterator の途中で error が来ると procedure を最初から呼び直し、最後の event の `id` を `last-event-id` で送る。【実機】`retry: 2` で途中に typed error を投げると、client には先に流した値が 3 回重なって届いた。
- `RetryAfterPlugin`: HTTP の応答が 429 か 503 で `Retry-After` を持つときだけ再試行する。stream の途中の error は対象外（source を読んだだけ）。

## 4. repo の今の扱い

- 規約 4（`docs/packages.md:145`）: 「呼び手が分岐する domain エラー（close の guard のように `data` に理由の一覧を持つもの）だけを `.errors()` で宣言する。それ以外は oRPC の標準 code（`NOT_FOUND`、`BAD_REQUEST`）を投げる。」
- task の `CLOSE_REFUSED` は、ui が `closeErrors.CLOSE_REFUSED.data.safeParse` で読み、`describeRefusal` で 1 行の文にして toast に出す（`packages/task/src/ui/close-bench.ts:27-53`）。note の `CONFLICT` は `e instanceof ORPCError && e.code === 'CONFLICT'` で分ける（`packages/note/src/ui/save-queue.ts:162-169`）。`isDefinedError` は repo のどこにも使われていない。
- note の画面は、`ORPCError` 以外の失敗を「届かなかった」とみなし、届くようになるのを待って送り直す（`packages/note/src/ui/note-references.ts:52-63`）。再接続の帯は 1 秒たっても届かなければ出し、届かない間は 1 秒ごとに確かめる（`docs/packages/note-ui.md:207-216`）。
- 帯と通知は日本語（「Backend に再接続中…」と「再試行」、`apps/desktop/src/backend-provider.tsx:49-66`）。toast は server の英語の message をそのまま出す（`packages/ui/src/toast.ts:28-34`）。
- CLI は `ConnectionRefused` を 200ms おきに 3 秒再試行してから `BACKEND_NOT_RUNNING` にする（`apps/cli/src/backend.ts:15-44`）。
- prototype（`prototype/side-panel-chat` の `apps/extension-prototype`）の Chat の状態は `idle | thinking | streaming` だけで、失敗の状態は無い。止めた turn に「止めました」を淡く出す表示（`variant-c.tsx:42-48`）と、fluid の `--destructive`・`--warning` などの token はある。

## 確かめられなかったこと

- 本物の plan の上限の 429。body の文言は使われていない可能性がある（representative-claim があると CLI が自分で文を作る）。
- keychain の login が本当に切れた状態と、期限切れの OAuth token の 401（CLI のコードでは token を更新して再試行する分岐がある）。
- env `CLAUDE_CODE_MAX_RETRIES` の効き目。
- 既定の 128000 で max_tokens に当たる場合。
- stream を切ったときに、stream しない request に替わる回数の違いが、切り方と thinking のどちらによるものか。
- spare（`startup()`）を使ったときの失敗と、`initialize_timeout`。
- 本物の Chrome Extension の side panel で、Backend に届かないときの message と、閉じたときの abort にかかる時間。
