# Agent SDK で 1 つの Study の会話を何日もまたいで続けられるか

問い: [#510](https://github.com/ashigirl96/monica/issues/510)（map は [#508](https://github.com/ashigirl96/monica/issues/508)）。Study（学習）の agent を Backend（バックエンド）の中で `@anthropic-ai/claude-agent-sdk` 0.3.293 で動かすとき、会話の再開・compact・Tutor（先生）の渡し方・専用の tool・権限の絞り方・web への流し方について、SDK が何を用意しているかを調べた。設計は後の grilling で決める。この文書は事実と分かれ道だけを書き、どれを取るかは決めない。

SDK を Backend で動かすこと自体の事実（認証、streaming input の multi-turn、設定を切った options、process の重さ）は [#257 の resolution](https://github.com/ashigirl96/monica/issues/257) にあり、ここでは測り直していない。

## 調べ方

- 一次資料: 入れた SDK 0.3.293 の型定義（`sdk.d.ts`。同梱の claude は 2.1.293）、公式の Agent SDK と Claude Code の docs（末尾の出典）、TypeScript SDK の [CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)。
- 手元の確認: scratch の directory に SDK 0.3.293 を入れ、Bun の使い捨ての script から `haiku` を 10 回ほど呼んだ。options は Chat（問答）の実装（`packages/chat/src/claude.ts`）に寄せ、`settingSources: []`（user・project・local の設定を読まない）、`strictMcpConfig: true`、env は `USER`・`HOME`・`PATH`・`TMPDIR` と `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` などだけにした。以下で scratch の directory は `<scratch>` と書く。
- 「実測」と書いたものは手元で確かめた結果、それ以外は docs か型定義に書かれていること。docs から読み取った推測には「推測」と書いた。

## 要点

1. **再開**: `resume`（再開する session の id）で、別の process からも、別の `cwd` からも同じ会話に戻れた（実測）。SDK は会話を `~/.claude/projects/<cwd を変換した名前>/<session-id>.jsonl` に書く。ただしこの file は同じ machine にしか無く、中身の形は Claude Code の内部の形で、既定では 30 日より古いものが掃除で消える。今の Chat の `persistSession: false` では再開できない。
2. **monica 側を正本にする道**: `sessionStore`（transcript を外の保存先に写す adapter。alpha）を使うと、monica の DB を再開の元にできる。in-memory の store から再開でき、その turn は `~/.claude/projects` に残らなかった（実測）。もう一つの道は、SDK の再開に頼らず、monica の記録から毎回新しい session の prompt を組むこと。
3. **compact**: 文脈が上限に近づくと自動で縮む。`/compact <指示>` を prompt として送ると手で縮められ、`PreCompact`・`PostCompact` の hook と `compact_boundary` の message が届いた（実測）。compact の後に戻るものと消えるものは決まっている（使った skill の本文は 1 つ 5,000 token まで戻るなど）。
4. **Tutor を skill で渡す**: `settingSources: []` のままでも、`plugins: [{ type: 'local', path }]` で任意の directory の `skills/<name>/SKILL.md` を読めた。`skills` に名前を並べると、最初に文脈へ入るのは frontmatter（名前と説明）だけで、2 つで 81 token だった。本文は Skill tool で呼んだ時に、参照先の file は Read した時に入った（実測）。`additionalDirectories` の `.claude/skills/` は `'project'` を読まないと読まれない（実測）。
5. **専用の tool**: `createSdkMcpServer` と `tool()` で、Backend の process の中で動く tool を足せる。handler は Backend の中で走るので、monica の DB に直接書ける。Chat の `disallowedTools: ['mcp__*']` を残すと、自分の tool の呼び出しも拒否される（実測）。`strictMcpConfig: true` だけで外の MCP server は入らない。
6. **権限**: Bash を OS の sandbox（macOS は Seatbelt）で動かすと、作業場所の中への書き込みは通り、`~` の下への書き込みと外への通信は止まった（実測）。sandbox は Bash とその子 process だけを囲み、Read・Edit・Write・MCP の tool と hook は permission rule で絞る。読み取りは既定で machine 全体に開いている。
7. **web**: `includePartialMessages: true` で token 単位の差分が `stream_event` として届く。Chat の oRPC の `eventIterator` にそのまま流せる形。1 つの process で何 turn も話す（streaming input）か、turn ごとに process を起こして `resume` するかは、メモリと待ち時間の兼ね合い。同じ session を 2 つの process で同時に再開すると記録が混ざる。

## 1. 会話の再開

### SDK が持っているもの

`Options`（`query()` の options）の再開まわり（`sdk.d.ts`）:

| option | 何をするか |
| :- | :- |
| `resume: string` | 指定した session id の会話を読み込んで続ける |
| `continue: true` | 今の directory で最も新しい session を続ける。`resume` とは併用できない |
| `forkSession: true` | `resume` と併用し、元を変えずに新しい session id へ分岐する |
| `sessionId: string` | 新しい session に自分で決めた UUID を付ける。`resume`・`continue` と併用できるのは `forkSession` の時だけ |
| `resumeSessionAt: string` | 指定した message の uuid までで切って再開する（`resumeDropsTurn` で切る範囲を検査できる） |
| `persistSession: false` | disk に書かない。この session は後で再開できない（既定は `true`） |
| `sessionStore` | transcript を外の保存先にも写す（alpha）。`persistSession: false` とは併用できない |

session を扱う関数も export されている: `listSessions`・`getSessionInfo`・`getSessionMessages`（compact 後の鎖を返す）・`forkSession`（uuid を振り直して複製。`upToMessageId` で途中から分岐）・`renameSession`・`tagSession`・`deleteSession`。session id は init の `system` message と、成功・失敗を問わず `result` message に載る（[Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)）。

TypeScript には Python の `ClaudeSDKClient` のような「会話を持つ object」が無く、同じ process で続けるなら streaming input、process をまたぐなら `resume` を使う（同 docs）。

### 置き場所と `cwd`

- docs: 「Claude Code stores sessions under `~/.claude/projects/<encoded-cwd>/*.jsonl`」。`<encoded-cwd>` は絶対 path の英数字以外を `-` に置き換えたもの。200 字を超えると切って hash を足す。`CLAUDE_CONFIG_DIR`（設定の directory を差し替える env）を設定するとその下の `projects/` になり、`CLAUDE_CODE_PROJECT_DIR_NAME`（`projects/` の下の名前を自分で決める env。`CLAUDE_CONFIG_DIR` と一緒の時だけ効く）で名前を固定できる（[Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[Manage sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)）。
- 再開は今の directory の外も探す（claude v2.1.223 以降。同梱の 2.1.293 は該当）。ただし file がその machine に在ることが前提（同 docs）。
- 実測: `cwd` を `<scratch>/s/a` にして新しい session を作ると、`~/.claude/projects/-private-tmp-...-scratchpad-s-a/<id>.jsonl`（1 turn で約 10KB）ができた。別の process から `cwd` を `<scratch>/s/b` にして `resume` すると、前の turn で覚えさせた語を答えた。session id は変わらず、追記先は元の `s-a` の file のままで、新しい行の `cwd` だけが `s/b` になった。
- 実測: `~/.claude.json` の projects には何も足されなかった（`settingSources: []` の場合）。

### 長く残すときに効く事実

- **掃除**: `~/.claude/projects/<project>/<session>.jsonl` は `cleanupPeriodDays`（既定 30 日、最小 1）より古くなると Claude Code が消す。下の `subagents/`・`tool-results/` も一緒に消える（[Explore the .claude directory](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)）。Study の transcript をユーザーの `~/.claude` に置くと、同じ `~/.claude` を使う claude（ユーザーが端末で使う claude も）が自分の設定の日数で掃除する、と読める（推測）。年齢を最後に書いた時刻で測るかは docs から読み取れず、確かめていない。monica が起こす claude には `settings: { cleanupPeriodDays: <日数> }` で日数を渡せる（`settings` は flag settings の層に入る）。
- **形は内部のもの**: 「The entry format is internal to Claude Code and changes between versions」（[Manage sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)）。monica が jsonl を直接読むと版の更新で壊れうる。読むなら `getSessionMessages` を通す。
- **file が育つ**: `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC=1` で、compact の後に 5MB を超えた file から compact より前の履歴を落とせる。再開で戻る会話は変わらない（[env vars](https://code.claude.com/docs/en/env-vars)）。
- **同時に 2 つ**: 同じ session を fork せずに 2 か所で再開すると、両方の message が 1 つの transcript に混ざる（[Manage sessions](https://code.claude.com/docs/en/sessions#branch-a-session)）。1 つの Study の turn は 1 つずつ流す必要がある。
- **system prompt は最初の版で固まる**: `systemPrompt` は既定で最初の request の時に transcript に記録され、`resume` でもその記録を使う。後の起動で違う `append` や `prompt` を渡しても、compact か新しい session まで無視される。毎回描き直すなら `{ type: 'custom', prompt, snapshot: false }`（`sdk.d.ts` の `systemPrompt`）。Mission（学ぶ理由）や Tutor の索引を system prompt に入れると、Study の途中で直しても既存の会話には効かない。
- **何日も空けた再開は cache を作り直す**: `SessionStart` hook の入力には、再開の時に `seconds_since_last_response`・`context_tokens`・`prompt_cache_likely_expired`・`estimated_cache_write_usd` が載る（`sdk.d.ts` の `SessionStartHookInput`）。何日も空けた Study の最初の turn は、それまでの文脈を丸ごと cache に書き直す費用がかかる。compact で文脈を縮めておくと、その費用も下がる。
- **費用の通算**: 再開・fork した session の `total_cost_usd` と `modelUsage` は transcript に残った前の turn の分から続く（CHANGELOG、`sdk.d.ts` の result message）。
- **options は毎回渡す**: `--plugin-dir`・`--add-dir`・`--mcp-config`・`--settings` は再開で戻らない（[Manage sessions](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores)）。SDK では `plugins`・`additionalDirectories`・`mcpServers`・`sandbox` などを `query()` のたびに渡すことになる。
- **permission mode**: 0.3.293 の型の説明では、`permissionMode` を省くと Claude Code が `claude -p` と同じ決め方をし、使える所では `auto` になる。claude v2.1.302 以降は `default` で始まる（[Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes)）。省いた時の既定は版で変わる（`sdk.d.ts` の `permissionMode`、CHANGELOG 0.3.285）。

### monica の記録を正本にできるか

map の決定どおり会話とクイズは monica の DB に置く。そのうえで、agent の文脈を何から作るかに 4 つの形がある。

**(a) SDK の transcript を正本にし、monica は session id だけ持つ。**
- 実装は一番小さい。tool の呼び出しと結果も含めて文脈がそのまま戻る。
- 置き場所はユーザーの `~/.claude` で、上の掃除・内部の形・同じ machine 限りの制約を受ける。

**(b) `CLAUDE_CONFIG_DIR` で置き場所を monica の home の下に分ける。**
- ユーザーの claude の掃除から外れ、`cleanupPeriodDays` を monica が決められる。
- macOS では login の keychain の項目も `CLAUDE_CONFIG_DIR` ごとに分かれる（「keys the macOS Keychain entry to that directory too」、[Authentication](https://code.claude.com/docs/en/authentication#credential-management)）。分けた directory 用に login し直すか、`CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` で作る長期の token）を渡す必要がある。手元では確かめていない。

**(c) `sessionStore` で monica の DB に写す（alpha）。**
- SDK は `append(key, entries)` で transcript の行を約 100ms ごとにまとめて渡し、`resume` の時は spawn の前に `load(key)` で読み戻す。読み戻したものは一時の config directory に書き出して claude を起こし、終わると消す。そのため store から再開した run の分は store だけに残る（[Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage)）。
- 新しい session の最初の run は、ローカルにも書き、store にも写す（dual write）。ローカルに残したくなければ `CLAUDE_CONFIG_DIR` を一時の directory にするが、その場合の認証は (b) と同じ問題になる。
- 行は不透明な JSON で、`uuid` で重複を除く。`append` の失敗は 3 回まで再試行し、だめなら `mirror_error` の message を出して捨てる。store の掃除は adapter の責任。`enableFileCheckpointing` とは併用できない。
- `projectKey` は `cwd` から作るので、再開は元と同じ `cwd` から行う（同 docs）。
- 実測: `InMemorySessionStore` を付けて 1 turn 話し、同じ store と `resume` で次の turn を送ると、前の語を答えた。この Mac の keychain の login のまま、一時の config directory でも認証が通った。2 turn 目は `~/.claude/projects` の file には足されなかった。最初の turn の file は残った。
- SDK の repo の `examples/session-stores/` に Postgres・Redis・S3 の参照実装がある。SQLite の adapter は自分で書くことになる。

**(d) SDK の再開に頼らず、monica の記録から毎回新しい session を組む。**
- docs も選択肢に挙げている: 「Capture the results you need ... as application state and pass them into a fresh session's prompt. This is often more robust than shipping transcript files around.」（[Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions#resume-across-hosts)）。
- 過去の tool の呼び出しと結果（読んだ file、試した command の出力）は文脈から落ちる。何を残して要約するかは monica が持つことになる。compact を monica が自前で行う形とも言える。

どの形でも、画面に出す履歴は monica の DB から出すことになる。`getSessionMessages` は compact した後の鎖を返し、compact より前の発言は返らない（[session-storage](https://code.claude.com/docs/en/agent-sdk/session-storage#getsessionmessages-returns-the-post-compaction-chain)）。実測でも、compact の後は 5 件（境界・要約・その後）しか返らなかった。

## 2. compact

- **自動**: 文脈の窓に近づくと SDK が古い履歴を要約し、`type: 'system'`・`subtype: 'compact_boundary'` の message を出す（[How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop#automatic-compaction)）。設定は `autoCompactEnabled`・`autoCompactWindow`（10 万〜100 万 token）・`idleCompaction`（手空きの間の compact）・`precomputeCompactionEnabled`、env は `DISABLE_AUTO_COMPACT`・`DISABLE_COMPACT`・`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`・`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（`sdk.d.ts` の Settings、[env vars](https://code.claude.com/docs/en/env-vars)）。compact 中は `system/status` の `status: 'compacting'` が届く。
- **手動**: `/compact` を prompt の文字列として送る。後ろに指示を書ける（`/compact [instructions]`）。前に会話が無いと「Not enough messages to compact.」で何もしない（[skills の docs の /compact](https://code.claude.com/docs/en/agent-sdk/skills#compact-history-with-compact)）。
- **hook**: `PreCompact`（入力に `trigger: 'manual' | 'auto'` と `custom_instructions`）と `PostCompact`（入力に `compact_summary`）。
- 実測: 前の session を `resume` し、prompt に `/compact Keep the codeword verbatim.` を送った。`PreCompact` → `PostCompact`（`compact_summary` に要約が入った）→ `compact_boundary`（`trigger: 'manual'`、`pre_tokens: 845`、`post_tokens: 510`、`duration_ms: 2204` と残した message の uuid）の順に届いた。`result` は `num_turns: 0` だった。
- **compact の後に戻るもの**（[Context window](https://code.claude.com/docs/en/context-window#what-survives-compaction)）:
  - system prompt はそのまま効く。
  - 使った skill の本文は戻る。1 つ 5,000 token、合計 25,000 token までで、古いものから落ちる。
  - skill の説明の一覧は、作り直して入れ直す。ただしこれは claude v2.1.304 以降で、同梱の 2.1.293 は満たさない。
  - `SessionStart` hook のうち `compact` の source に合うものは走り、その出力が compact 後の文脈に足される。SDK の hook では `SessionStartHookSpecificOutput.additionalContext` で返す。Mission や学習記録の要約を compact の後に入れ直す口になる。
  - hook が前に足した文脈は、他の会話と一緒に要約される。
- **要約の指示**: docs は CLAUDE.md に「何を残すか」を書く方法を挙げているが、CLAUDE.md は `settingSources` に `'project'` が要る（[agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop#automatic-compaction)）。`settingSources: []` のままなら、手動の `/compact <指示>` か system prompt で伝えることになる。

## 3. Tutor を skill で渡す

ここでの skill は Claude Code の `SKILL.md` の仕組みで、GLOSSARY の Skill（手順書）とは別のもの。

- **どこから読むか**: skill は `settingSources` が読む場所（`~/.claude/skills/`、`<cwd>/.claude/skills/` と親の directory）から見つかる。`additionalDirectories` の `.claude/skills/` も読まれるが、それも `'project'` の source に含まれる。`settingSources` を明示して `'user'`・`'project'` を外すと、これらは読まれない。特定の path から読むなら `plugins` を使う（[Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills)、[claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)）。SDK には skill を program から登録する API が無く、file で置く。
- **plugin の形**: `plugins: [{ type: 'local', path }]` の path は plugin の root（`skills/`・`.claude-plugin/` の親）。`.claude-plugin/plugin.json` は無くてもよい。skill の名前は `<plugin 名>:<skill 名>` になる。存在しない path は黙って飛ばすので、init の `plugins` と `plugin_errors` で確かめる（[Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins)）。
- 実測: `<scratch>/tutors/`（`plugin.json` は `{"name":"tutors"}`）に `skills/repository/SKILL.md`（本文に「返答を MARMALADE で始める」、`reference.md` へのリンク）と `skills/math/SKILL.md` を置いた。options は `settingSources: []`、`plugins: [{ type: 'local', path: <scratch>/tutors }]`、`skills: ['tutors:repository', 'tutors:math']`、`tools: ['Skill', 'Read']`、`allowedTools: ['Read']`、`additionalDirectories: [<scratch>/s/c]`（`.claude/skills/addir-skill/` を置いた）にした。
  - init の `plugins` に `tutors@inline` が載り、command の一覧に `tutors:math`・`tutors:repository` が出た。`addir-skill` は出なかった。
  - 最初の turn の前の `getContextUsage()` は、skills が `includedSkills: 2`・`tokens: 81`（`tutors:math` 22、`tutors:repository` 59）だった。本文はまだ入っていない。
  - ky を学びたいと Mission を書いて送ると、agent が `Skill` を `tutors:repository` で呼び、`reference.md` を Read して、MARMALADE で始めて、`reference.md` にしか無い語を答えた。
  - `skills: 'all'` にすると、同梱の skill 14 個も一覧に入り、skills は 2,168 token になった。init の `skills` の配列は、一覧に入るかどうかに関係なく同梱のものも並ぶ（docs も「The array lists the same skills whether or not they're in your `skills` list」）。
- **最初に入るのは説明だけ**: 「skill descriptions are loaded into context so Claude knows what's available, but full skill content only loads when invoked」。参照先の file は読まれた時に入る。説明と `when_to_use` は合わせて 1,536 字で切られる。一覧全体の予算は文脈の 1%（`skillListingBudgetFraction`）で、超えると説明が縮む（[Extend Claude with skills](https://code.claude.com/docs/en/skills)、`sdk.d.ts` の Settings）。`skillOverrides` の `'name-only'` で名前だけにもできるが、plugin の skill には効かない（同 docs）。
- **呼んだ後**: 本文は 1 つの message として会話に入り、以後の turn に残り続ける。同じ内容をもう一度呼ぶと「既に読み込み済み」の短い注になる（同 docs）。compact の後の扱いは 2 章のとおり。
- **`skills` は文脈の絞り込みで、壁ではない**: 一覧に無い skill は model から見えず Skill tool も拒むが、file は Read・Bash で読める。`/<name>` の送信は一覧に関係なく走る（`sdk.d.ts` の `skills`、[skills の docs](https://code.claude.com/docs/en/agent-sdk/skills#allow-only-specific-skills)）。
- **tool の指定**: `tools` を明示するなら `'Skill'` を入れる。`skills` を渡すと SDK が `allowedTools` に Skill を足す（同 docs）。Tutor の補助の file が `cwd` の外にあると、Read の承認が要る。実測では `allowedTools: ['Read']` で通した（これは全 path の Read を承認する）。
- **途中で増やす**: 実行中の session に plugin を足す `reloadPlugins({ addPlugins })` は SDK 0.3.301 以降。0.3.293 にあるのは `reloadPlugins()`・`reloadSkills()`（disk から読み直す）（[Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins)、CHANGELOG）。
- **frontmatter**: `disable-model-invocation: true` で model の一覧から外し `/name` の送信でだけ使える。`user-invocable: false` で model だけが呼べる（[Extend Claude with skills](https://code.claude.com/docs/en/skills)）。

## 4. 学習記録やクイズを書く専用の tool

- **作り方**: `tool(name, description, zod の形, handler)` を `createSdkMcpServer({ name, tools })` に包み、`mcpServers: { <key>: server }` で渡す。tool の名前は `mcp__<key>__<tool>` になる。server は Backend の process の中で動く（「The server runs in-process inside your application, not as a separate process」、[Give Claude custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)）。
- 実測: `monica` の server に `record_learning`（`title`・`body` を受けて配列に足す）を置いた。options は `tools: []`・`allowedTools: ['mcp__monica__record_learning']`・`permissionPrompts: 'none'`。文字列の prompt（streaming input ではない）でも、agent が tool を呼び、handler が 1 回走った。init の tools は `["mcp__monica__record_learning"]`、`mcp_servers` は `[{ name: 'monica', status: 'connected', source: 'sdk' }]`。
- **Chat の deny とぶつかる**: 同じ options に Chat と同じ `disallowedTools: ['mcp__*']` を足すと、tool は一覧に残ったまま、呼び出しが `Permission to use mcp__monica__record_learning has been denied.` で拒否され、handler は走らなかった（実測）。docs も「`"mcp__*"` matches every MCP tool across all servers」とし、deny rule は allow rule より先に評価される（[Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions#allow-and-deny-rules)）。
- **`strictMcpConfig` とは両立する**: `strictMcpConfig: true` は「`mcpServers` で渡した server（と明示した agent 定義の server）だけを使う」ので、自分の server は残り、`.mcp.json`・ユーザーの設定・plugin の MCP は入らない（`sdk.d.ts`）。claude.ai の connector も `strictMcpConfig: true` か `ENABLE_CLAUDEAI_MCP_SERVERS=false` で止まる（[claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)）。plugin で Tutor を渡すときに plugin 側の `.mcp.json` を読ませないなら `skipMcpDiscovery: true`（`sdk.d.ts` の `SdkPluginConfig`）。
- **他に効く事実**（[custom-tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)）:
  - tool search が既定で SDK の MCP tool を後読みにする。`alwaysLoad: true` で常に schema を載せる。実測の `tools: []` では、tool は init の一覧に載り、agent は ToolSearch を経ずに直接呼んだ。
  - handler の例外は error の結果になり、agent の loop は止まらない。`isError: true` で agent が読む文を自分で書ける。
  - `structuredContent` で JSON の結果を返せる。TypeScript では、その時 `content` の text は agent に届かない。
  - `annotations.readOnlyHint` を付けた tool は並列に呼ばれうる。既定は順に呼ばれる。
  - tool ごとに `permission_policy: 'always_ask' | 'always_deny'` を付けられるのは SDK 0.3.301 以降で、0.3.293 には無い。
- `canUseTool` には `mcpServer: { name, source }` が来て、`source: 'sdk'` が host の登録した in-process の server（`sdk.d.ts` の `CanUseTool`）。
- クイズを画面の部品で出すとき、tool の入力は `input_json_delta` として stream に流れる（6 章）。web が tool の呼び出しを見て部品を出す形が取れる。組み込みの `AskUserQuestion` には web 向けに `toolConfig.askUserQuestion.previewFormat: 'html'` があるが、答えは `canUseTool` で返す必要があり、`permissionPrompts: 'none'` や `dontAsk` では拒否される（`sdk.d.ts` の `ToolConfig`、[permissions](https://code.claude.com/docs/en/agent-sdk/permissions)）。

## 5. Bash と file の書き込みを Study の作業場所に絞る

### permission の評価の順

hook → deny rule → ask rule → permission mode → allow rule → `canUseTool`（host が承認する callback）の順に決まる。deny rule と hook の deny は `bypassPermissions` でも効く。allow rule・`acceptEdits`・`bypassPermissions` が通した呼び出しは `canUseTool` に来ないので、全部を見たいなら `PreToolUse` hook を使う。`permissionPrompts: 'none'` だと `canUseTool` は呼ばれず、`PermissionRequest` hook が決めなければ拒否される（[Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)）。

### 作業場所

- 作業場所は `cwd` と `additionalDirectories`。作業場所の中の Read は承認なしで通る（同 docs）。
- `acceptEdits` は作業場所の中の Edit・Write と `mkdir`・`touch`・`rm`・`mv`・`cp`・`sed` を自動で通し、外のものは通さない（同 docs）。
- path の rule は `Edit(//abs/**)` が絶対 path、`Edit(/rel/**)` が作業場所からの相対。`Edit` の rule は Write にも効く。Bash の `tee` や `>` も見るが、Bash で走らせた script が自分で開く file は止められない。OS で止めるなら sandbox を使う（同 docs）。
- 書き込みを禁じた path がある: `.claude/` の設定・skill、`.git/hooks`・`.git/config`、`.bashrc` など（[Sandboxing](https://code.claude.com/docs/en/sandboxing)）。

### `sandbox` option

- macOS は Seatbelt、Linux は bubblewrap で、Bash とそれが起こす子 process を囲む。option で `enabled: true` を渡すと `failIfUnavailable` の既定が `true` になり、sandbox を使えない環境では起動せずに失敗の結果を返す（`sdk.d.ts` の `sandbox`）。
- 既定の書き込み先は、作業場所と `$TMPDIR`。読み取りは machine 全体で、`~/.ssh` なども含む。絞るなら `filesystem.denyRead`・`allowRead`・`credentials` を使う（[Sandboxing](https://code.claude.com/docs/en/sandboxing)）。
- 通信は proxy を通し、`allowedDomains` に無い host は既定で通らない。一覧に無い host は、`default`・`acceptEdits` では承認を求め、`dontAsk` では拒否する（同 docs）。`npm install` のような導入には、registry などの domain を `network.allowedDomains` に足す必要がある。
- `allowUnsandboxedCommands: false` で、sandbox の外での再試行（`dangerouslyDisableSandbox`）を止める。`excludedCommands` に当たる command は sandbox の外で走る（同 docs）。
- sandbox の外にあるもの: Read・Edit・Write・WebFetch などの tool、MCP server、hook（同 docs）。in-process の monica の tool も Backend の権限で走る。
- 実測: `cwd` を `<scratch>/s/f`、`tools: ['Bash']`、`sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true }`、`permissionMode: 'default'`、`permissionPrompts: 'none'` にした。
  - `touch inside.txt` は通った。
  - `touch ~/monica-study-sandbox-probe.txt` は `Operation not permitted` で止まった（file はできていない）。
  - `curl https://example.com` は `deny network-outbound example.com:443` で止まった。
  - `<scratch>` の下（Claude Code が自分の一時 file に使う directory の下）への `touch` は通った。Claude Code 自身の一時 directory への書き込みを sandbox が許しているためと見られる（推測）。
- 実測: sandbox を使った run は、`persistSession: false` でも `~/.claude/session-env/<session-id>` を残した。

### その他の口

- `canUseTool` は承認待ちの呼び出しを受け、作業場所の外に触れる時は `blockedPath` が来る（`sdk.d.ts` の `CanUseTool`）。web でユーザーに承認を求める形にするなら、ここを使う。
- `spawnClaudeCodeProcess` で claude を container や VM の中で起こせる（「Use this to run Claude Code in VMs, containers, or remote environments」）。`toolAliases` で `Bash` を自分の MCP tool に向け替えられる（`sdk.d.ts`）。sandbox ではなく docker や nix で隔てる場合の継ぎ目になる。
- 重さ: claude は 1 つ 270〜290MB（#257 の実測）。

## 6. 返答を web に流す

- `includePartialMessages: true` で `type: 'stream_event'` の message に Claude API の生の stream event が載る。text は `content_block_delta` の `text_delta`、tool の入力は `input_json_delta` で届く。subagent の差分は流れない。完成した block ごとの `assistant` message も届く（[Stream responses in real-time](https://code.claude.com/docs/en/agent-sdk/streaming-output)）。#257 でも `text_delta` を受け取れている。
- 途中で切れた stream でも `message_stop` は届く（claude v2.1.290 以降、SDK 0.3.290 以降。0.3.293 は該当）。tool の block が開いたまま `message_stop` が来たら、その入力は不完全（同 docs）。
- Chat は `query()` の stream を `translate()` で ChatEvent に直し、oRPC の `eventIterator` で流している（`packages/chat/src/chat-agent.ts`）。Study でも 1 turn の stream は同じ形で流せる。
- **process の持ち方**:
  - streaming input（AsyncIterable の prompt）なら、1 つの process で何 turn も話せる。割り込み（`interrupt()`）、画像の添付、途中のモデル変更（`setModel()`）、`setPermissionMode()` もこの形でだけ使える（[Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、`sdk.d.ts` の `Query`）。#257 の実測では 3 turn を 1 つの pid で話せ、claude 1 つで 270〜290MB。
  - turn ごとに process を起こして `resume` すると、待機中のメモリは要らない。代わりに毎回起動の待ちがある。#257 の実測では、先に起こすと送ってから最初の text まで 0.63 秒、起こしながらだと 1.0〜1.6 秒。
  - `startup()` は `Options` をそのまま受けるので `resume` も渡せる（CHANGELOG 0.3.321 に「`startup()` with `resume`」の修正がある。手元では確かめていない）。`prewarm()` で待たせた process を `claim()` で割り当てる時の options（`ClaimOptions`）には `resume` が無い（`sdk.d.ts`）。
  - 何日も続く Study では、会話中だけ process を持ち、手が空いたら閉じて次は `resume` する中間の形も取れる。どれを取っても、同じ Study の turn を 2 つの process で同時に流さない仕組みが要る（1 章）。

## 7. grilling で決めること

事実から見えた分かれ道。どれも決めていない。

1. **文脈の正本**: (a) SDK の transcript、(b) `CLAUDE_CONFIG_DIR` を分けた transcript、(c) `sessionStore` で monica の DB、(d) monica の記録から毎回組む、のどれか。分かれる点は次のとおり。
   - 掃除の 30 日と、map の「3 ヶ月触らなかった環境は自動で消す」との関係。
   - macOS の keychain の login を分けるかどうか。
   - alpha の API に寄るかどうか。
   - tool の結果を文脈に残すかどうか。
2. **process の寿命**: turn ごとに起こすか、会話中だけ持つか。同時に何本まで持つか（Chat は 4 本まで）。
3. **Tutor の置き場所**: plugin の directory を monica の repo に同梱するか、monica の home に書き出すか。skill の名前は `<plugin 名>:<tutor 名>` になる。plugin の名前を何にするか。
4. **Mission と Tutor の索引を渡す口**: system prompt は Study の最初で固まる（`snapshot` の既定）。毎回描き直すか、`SessionStart` hook の `additionalContext` で入れ直すか。
5. **Bash の隔て方**: SDK の `sandbox`（作業場所と一時 directory だけ書ける、読み取りは広い、導入には domain の許可が要る）か、container や nix か。map の「ユーザーも中に入って手を動かす」とどう噛み合うか。
6. **承認**: `permissionPrompts: 'none'` と allow rule で決め打つか、`canUseTool` で web に承認を出すか。
7. **Chat と共有する範囲**: env の allowlist と spawn は共有できるが、`persistSession: false` と `disallowedTools: ['mcp__*']` は Study では使えない。

## 出典

- SDK 0.3.293 の型定義: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`Options`、`SessionStore`、`ClaimOptions`、`CanUseTool`、`SandboxSettings`、Settings、hook の入力）
- [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills)
- [Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins)
- [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- [Give Claude custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Stream responses in real-time](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Manage sessions](https://code.claude.com/docs/en/sessions)
- [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory)
- [Context window](https://code.claude.com/docs/en/context-window)
- [Extend Claude with skills](https://code.claude.com/docs/en/skills)
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Authentication](https://code.claude.com/docs/en/authentication)
- [Environment variables](https://code.claude.com/docs/en/env-vars)
- [TypeScript Agent SDK の CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- [Backend の中で Agent SDK を動かせるか（#257）](https://github.com/ashigirl96/monica/issues/257)
