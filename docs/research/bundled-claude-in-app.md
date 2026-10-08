# 同梱した claude を .app の Backend から起こす

wayfinder の map #254「ブラウザ拡張の side panel で、開いているページについて質問できるチャットを作る」のチケット #268「同梱した claude を .app の Backend から起こせるか」で調べた事実。ADR-0031・0032・0033 を実装する前に、`.app` の中に置いた claude を `.app` から起こした Backend が spawn し、この Mac の Claude Code の login で答えられるかを確かめた。ここには事実と数字だけを置く。

確かめた環境: macOS 26.6.2（25G83、arm64）、Bun 1.4.2、rustc 1.95.0、`@anthropic-ai/claude-agent-sdk` 0.3.293（2026-10-09 の npm の `latest` と `next`。同梱の claude は 2.1.293）、Claude Team の plan の login（macOS の keychain）、model は alias `haiku`、effort は `low`。【実機】と書いたものは、scratchpad に組んだ probe の `.app`（Shell 役 → Backend 役 → claude）を `open -n` で launchd の子として起こして確かめた。`/Applications/Monica.app`・`~/.monica`・動いている Monica の process には触れていない（署名を読むだけの `codesign -dv` は除く）。haiku を呼んだ turn は 9 回で、うち 1 回は turn の途中で止めた。

## issue の前提と違った事実

- **`.app` は hardened runtime ではない。** 今の `/Applications/Monica.app` の CodeDirectory は `flags=0x0(none)`、`Authority=Monica`、`TeamIdentifier=not set`。`install-app` の `codesign --force --sign Monica` に `--options runtime` が無いため。中の `monica`・`monica-backend`・`monica-ptyd` は linker が付けた ad-hoc の署名（`flags=0x20002(adhoc,linker-signed)`）のままで、`install-app` は署名し直していない。【実機】`codesign -dvv`
- **`open` で起こした `.app` は、`open` を呼んだ process の env を継ぐ。** 親は launchd（pid 1）になるが、env は launchd の既定ではない。Monica の Tab の agent の Bash から `open -n` で probe を起こすと、Shell 役に 100 個の key が入り、その中に `CLAUDECODE`・`CLAUDE_CODE_SESSION_ID`・`CLAUDE_CODE_MESSAGING_SOCKET`・`CLAUDE_CODE_MESSAGING_TOKEN`・`CLAUDE_EFFORT`・`MONICA_TERMINAL_SESSION_ID`・`MONICA_HOME` があった。`NSWorkspace.openApplication` で起こしても同じだった。`open` の前に `env -i` で env を絞ると、Shell 役の env は 13 個になった。【実機】
  - ADR-0032 の「今の Backend の env には `ANTHROPIC_API_KEY` が無い」は、Monica を env の絞られた起こし方で起こしたときにだけ言える。shell で `ANTHROPIC_API_KEY` を export した terminal から `open /Applications/Monica.app` すると、Backend の env に入る（推論。上の継ぎ方から）。
  - release-app skill の「`open /Applications/Monica.app` で起こす」を agent の Bash から行うと、その agent の Claude Code の env が Shell と Backend に入る。
  - 以下の 1〜5 の実機の run は、すべて `env -i` で絞ってから `open -n` した。

## 要点

| 問い | 答え |
|---|---|
| 1. spawn | 【実機】`Contents/MacOS/claude` でも `Contents/Resources/claude` でも、Backend 役が `pathToClaudeCodeExecutable` で spawn して答えた。`codesign --force --sign Monica <bundle>`（`--deep` 無し）は claude を書き換えず、Anthropic の署名（Developer ID、Team `Q6L2SF6YDW`、hardened runtime、entitlements 5 つ、cdhash `a7cbd4ac…`）が残った。`codesign --verify --deep --strict` は通り、`spctl -a -t exec` は今の Monica.app と同じく `rejected`（`origin=Monica`）。置き場所は `Contents/MacOS` を勧める（Apple の文書と、codesign が nested code として検めるため） |
| 2. login | 【実機】launchd → Shell 役 → Backend 役 → claude と起こした claude が、keychain の login で答えた。init を記録した 8 turn とも `apiKeySource` は `none`、`accountInfo()` は `Claude Team` / `firstParty`。keychain の許可のダイアログは出なかった |
| 3. options | 【実機】ADR-0033 の options で、init の `tools` は 0、`mcp_servers` は 0。`permissionPrompts: 'none'` は SDK 0.3.293 の型にあり、`--permission-prompts none` で claude に渡る。`haiku` は `claude-haiku-5-5` に解決された。最初の text delta まで、spare 無しで 963〜1,316ms（5 回）、spare ありで送ってから 519〜650ms（3 回） |
| 4. spare | 【実機】`startup()` で起こした WarmQuery から 3 回とも答えた。準備は 224〜239ms（8 回）。使わずに `close()` すると、子は 0.75〜2 秒で消え（5 回）、Backend 役の子孫は 0 になった |
| 5. 始末 | 【実機】`spawnClaudeCodeProcess` で持った claude を最初の text delta で SIGKILL すると、6.4ms で exit が届き、10ms 後には居なかった。孫は無く、5 秒後も Backend 役の子孫は 0。`query()` の iterator は 7.7ms 後に `Claude Code process terminated by signal SIGKILL` を投げた |
| 止めずに確かめる手順 | 別の bundle id の probe の `.app` を使い捨ての `MONICA_HOME` で、`env -i` で絞って `open -n` で起こす。実装の確認は、build した `.app` の写しを install-app と同じく署名し、その中の Backend を headless で起こす。`.app` の写しそのものは並べて起こさない |

## probe の形

`docs/research/bundled-claude-in-app/` の script で組んだ。

- Shell 役 `probe-shell`（Rust の `shell.rs` を `rustc -O` で build）: `apps/desktop/src-tauri/src/backend.rs` の `command()` と同じ形で Backend 役を起こす。Shell の env をそのまま継ぎ、`MONICA_HOME`・`MONICA_PTYD_PATH`（`Contents/MacOS/monica-ptyd`。probe には無い）・`MONICA_NOTES_PORT=19380`、それに実装で足す想定の `MONICA_CLAUDE_PATH`（claude の場所）を足す。stdin は pipe にして書き側を握ったまま、stdout は pipe、stderr は継ぎ、`process_group(0)`。
- Backend 役 `monica-backend`: `backend.ts` を `scripts/build.ts` と同じ flag（`--compile --minify-whitespace --minify-syntax --bytecode --format=esm`）で compile した。起動時に `apps/backend/src/login-shell-path.ts` と同じ形で PATH を login shell のものに置き換え、SDK で claude を起こし、結果を `$MONICA_HOME/results.jsonl` に JSON 行で書く。
- `.app`: `Contents/Info.plist`（`CFBundleExecutable=probe-shell`、bundle id `com.ashigirl96.monica-claude-probe.<variant>`、`LSBackgroundOnly`）、`Contents/MacOS/` に Shell 役と Backend 役。claude は SDK の `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` を `cp` で写した。署名は `install-app` と同じ `codesign --force --sign Monica <bundle>`（Keychain の自己署名の identity「Monica」）と `xattr -dr com.apple.quarantine`。
- 起こし方: `env -i HOME=… USER=… LOGNAME=… SHELL=/bin/zsh TMPDIR=… PATH=/usr/bin:/bin:/usr/sbin:/sbin SSH_AUTH_SOCK=… __CF_USER_TEXT_ENCODING=… open -n <app> --args --home <MONICA_HOME> --claude <macos|resources> -- <run id> <steps>`（`run-app.sh`）。`MONICA_HOME` は scratchpad の下の使い捨ての directory。chat の cwd はその下の空の `chat`。
- 【実機】どの run でも、Backend 役から辿った親は `monica-backend` → `probe-shell` → `/sbin/launchd`（pid 1）だった。

## 1. spawn と codesign

### 置き場所と署名の組み合わせ

【実機】すべて `Contents/MacOS` に Shell 役と Backend 役を置き、claude の場所と署名の flag だけを変えた。

| claude の場所 | 署名 | `codesign --verify --deep --strict` | `spctl -a -t exec`（.app） | claude の署名 | spawn して答えたか |
|---|---|---|---|---|---|
| `Contents/MacOS` | `--force --sign Monica`（install-app と同じ） | valid。claude を nested code として `--validated` | rejected（origin=Monica） | Anthropic のまま | 答えた（6 turn と、途中で SIGKILL した 1 turn） |
| `Contents/Resources` | 同上 | valid。claude は resource の hash だけ | rejected（origin=Monica） | Anthropic のまま | 答えた（1 turn） |
| `Contents/MacOS` | `--options runtime` を足す | valid | rejected（origin=Monica） | Anthropic のまま | 答えた（1 turn） |
| `Contents/MacOS` | `--deep` を足す | valid | rejected（origin=Monica） | Monica に置き換わる | `.app` の中の `--version` と、terminal の bun からの `startup()` の initialize は通った（turn は送っていない） |
| `Contents/MacOS` | `--deep --options runtime` | valid | rejected（origin=Monica） | Monica に置き換わる | Backend 役が起動しない。claude も terminal の bun から `startup()` すると落ちる |

- 今の `/Applications/Monica.app` も `codesign --verify --deep --strict` は valid、`spctl -a -t exec` は `rejected`（`origin=Monica`）。quarantine を外しているので、Gatekeeper の評価は起動を止めない（今の Monica と同じ）。【実機】
- claude 単独の `spctl -a -t exec` は、どの場所でも `rejected (the code is valid but does not seem to be an app)`、`origin=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`。app bundle でない Mach-O への `-t exec` の評価で、`codesign --verify --strict` は valid。【実機】

### `--deep` 無しの署名は claude を書き換えない

- 【実機】`Contents/MacOS/claude` は、署名の前後で `Identifier=com.anthropic.claude-code`、`flags=0x10000(runtime)`、`Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`、CDHash `a7cbd4ac3bb1bd68a9f0f484d94e7239aef60286` のまま。entitlements も `allow-jit`・`allow-unsigned-executable-memory`・`disable-library-validation`・`automation.apple-events`・`device.audio-input` のまま。
- 【実機】`Contents/MacOS` に置くと、外側の `_CodeSignature/CodeResources` の `files2` に `MacOS/claude` の cdhash と、Anthropic の designated requirement（`identifier "com.anthropic.claude-code" and anchor apple generic and … certificate leaf[subject.OU] = Q6L2SF6YDW`）が記録された。今の Monica.app の ad-hoc の 3 つは `cdhash H"…"` だけが requirement になっている。
- 【実機】`Contents/Resources` に置くと、`files` と `files2` に hash だけが記録され、`--verify --deep` は claude を code として検めない。
- Apple の文書は、helper tool の置き場所を `Contents/MacOS/` か `Contents/Helpers/` とし、`Contents/Resources/` は code でないものの場所としている。置き場所を誤った code は手元では動いても notarization で問題になりうる、とも書いている。
  - https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle
- 今の Monica.app の `Contents/MacOS` には Tauri の externalBin（`monica`・`monica-backend`・`monica-ptyd`）が並んでいる。externalBin は `binaries/<name>-<target triple>` に置くと、build で triple を剥がした名前で `Contents/MacOS/` に写される（`docs/research/tauri-bun-sidecar.md`）。`bundle.macOS.files` を使えば `Contents/` の下の任意の場所にも置ける。
  - https://v2.tauri.app/distribute/macos-application-bundle/

### hardened runtime と `--deep`

- 【実機】`--options runtime`（`--deep` 無し）では、main executable の `probe-shell` だけが `flags=0x10000(runtime)` になり、`monica-backend` は linker の ad-hoc、claude は Anthropic のままだった。Backend 役も claude も起き、1 turn 答えた（最初の text delta まで 1,058ms）。library validation で claude の起動が止まることは無かった。推論: library validation は process に読み込む library に効くもので、exec した子はそれぞれ自分の署名で起きる。
- 【実機】`--deep` を足すと、claude は `Identifier=claude`、`Authority=Monica`、`flags=0x0(none)`、entitlements 無しで署名し直された。Anthropic の署名は消える。runtime が無いので JIT は止まらず、`claude --version` も `startup()` の initialize も通った（initialize まで 730ms）。
- 【実機】`--deep --options runtime` では、`monica-backend` と claude の両方が entitlements 無しの hardened runtime になった。Backend 役は `ReferenceError: SharedArrayBuffer is not defined` で exit 1 し、Shell 役は `exit status 256` を記録した。claude を単独で `startup()` すると、同じ `SharedArrayBuffer is not defined`（claude の中の Bun は 1.4.3）で exit 1 した。`claude --version` だけは通った。推論: JIT の entitlement が無い hardened runtime で、Bun（JavaScriptCore）が JIT を使えない。
- Tauri の bundler に署名させると、externalBin も app の entitlements で署名し直す（`docs/research/tauri-bun-sidecar.md` の「制約と注意」）。claude を externalBin で入れたまま bundler の署名を有効にすると、`--deep` と同じく Anthropic の署名が消える（推論）。

### 新しく置いた claude の最初の起動

- 【実機】`.app` に写した直後の claude の `claude --version` は 20〜84ms、2 回目は 7〜8ms。#257 で見た「新しく置いた claude の最初の `startup()` が数秒」は出なかった。推論: 同じ cdhash の claude を #257 と、この調べの前の run で既に起こしていた。SDK の版を上げた後の最初の spawn は遅いかもしれない。
- 【実機】`query()` から init までは、`Contents/MacOS` の run の最初の 1 回だけ 556ms で、ほかの 4 回は 231〜264ms だった。

## 2. login

- 【実機】`env -i` で絞って `open -n` したとき、Shell 役の env は `COMMAND_MODE`・`HOME`・`LOGNAME`・`OSLogRateLimit`・`PATH`（`/usr/bin:/bin:/usr/sbin:/sbin`）・`SHELL`・`SSH_AUTH_SOCK`・`TMPDIR`・`USER`・`XPC_FLAGS`・`XPC_SERVICE_NAME`・`__CFBundleIdentifier`・`__CF_USER_TEXT_ENCODING` の 13 個だった。`ANTHROPIC_*` と `CLAUDE*` は無い。Backend 役には Shell が足す 4 つが加わり、SDK を import した時点で `NoDefaultCurrentDirectoryInExePath=1` が入る（`sdk.mjs` が `process.env` に書く）。Backend 役の PATH は login shell のもの（`~/.local/bin` を含み、`~/.monica/bin` を含まない）に置き換わった。
- 【実機】その env から起こした claude は、3 つの `.app`（`Contents/MacOS`、`Contents/Resources`、`--options runtime`）で init を記録した 8 turn すべてで、`apiKeySource` が `none`、`accountInfo()` が `subscriptionType: "Claude Team"`、`apiProvider: "firstParty"` だった。keychain の許可のダイアログは出ず、待ちも無かった（turn は 1 秒台で返った）。
- claude は keychain を、`security find-generic-password -a <account> -w -s <service>` を子として起こして読む（2.1.293 の binary の文字列）。推論: keychain を読む process は `/usr/bin/security` なので、claude の場所や署名が変わっても、keychain の item の ACL は問われない。#257 の terminal からの run と同じく、`.app` から起こしても読めた。
- 【実機】`open` の env の継ぎ方。

  | 起こし方 | Shell 役の親 | Shell 役の env |
  |---|---|---|
  | Tab の agent の Bash から `open -n` | launchd（pid 1） | 呼んだ shell の env ほぼ全部（100 個。`CLAUDECODE`・`CLAUDE_CODE_*`・`MONICA_HOME`・`MONICA_TERMINAL_SESSION_ID` などを含む） |
  | 同じ Bash から `NSWorkspace.openApplication`（`launch.swift`） | launchd（pid 1） | 同上 |
  | `env -i …` の後に `open -n`（`run-app.sh`） | launchd（pid 1） | 上の 13 個 |

  - `launchctl print gui/<uid>` の `environment` は `SSH_AUTH_SOCK` だけだった。
  - `osascript` の `launch` は、bundle id でも path でも probe を起こせなかった（`LSBackgroundOnly` の bundle）。Dock・Finder から起こしたときの env は、GUI の操作が要るので確かめていない。
- Monica は Tab の env をこの継ぎ方から守っている。ptyd を起こすとき、Backend の env から `MONICA_*`・`CLAUDECODE`・`CLAUDE_CODE_*` を落とす（`packages/workbench/src/ptyd.ts` の `inheritableEnv()`）。ptyd は `DIRENV_*` も落とす（`crates/terminal-daemon/src/manager.rs`）。

## 3. options

試した options（`backend.ts` の `chatOptions()`）。

```ts
{
  model: 'haiku',
  effort: 'low',
  cwd: `${MONICA_HOME}/chat`, // 空の directory
  settingSources: [],
  skills: [],
  tools: [],
  strictMcpConfig: true,
  disallowedTools: ['mcp__*'],
  permissionPrompts: 'none',
  persistSession: false,
  systemPrompt: 'You answer questions about the web page the user is reading. Reply in plain text.',
  includePartialMessages: true,
  pathToClaudeCodeExecutable: process.env.MONICA_CLAUDE_PATH,
  env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
}
```

- `permissionPrompts` は SDK 0.3.293 の `Options` にある。型は `'host' | 'none'` で、`'none'` は「permission mode・rule・hook は今までどおり決め、prompt を出すはずのものは、承認の窓口が無いと Claude に伝えてすぐ拒む。`canUseTool` は呼ばない」（`sdk.d.ts`）。
- 【実機】SDK が claude に渡した引数（`args-check.ts`。prompt は送っていない）: `--output-format stream-json --verbose --input-format stream-json --effort low --model haiku --permission-prompts none --disallowedTools mcp__* --tools "" --setting-sources= --strict-mcp-config --include-partial-messages --no-session-persistence`。system prompt と `skills` は argv に出ず、initialize の control request で渡る。
- 【実機】init（記録した 8 turn とも同じ）。

  | 項目 | 値 |
  |---|---|
  | `apiKeySource` | `none` |
  | `claude_code_version` | `2.1.293` |
  | `model` | `claude-haiku-5-5`（result の `modelUsage` の key も同じ） |
  | `tools` | 0（`[]`） |
  | `mcp_servers` | 0（`[]`） |
  | `skills` | 19（bundled） |
  | `plugins` | 4（`cc-plugin-sec-default`・`cc-plugin-agents-md`・`cc-plugin-telemetry`・`cc-plugin-plugin-authoring`） |
  | `agents` | 5（`claude`・`Explore`・`general-purpose`・`Plan`・`statusline-setup`） |
  | `slash_commands` | 54 |
  | `permissionMode` | `default` |
  | `cwd` | `$MONICA_HOME/chat` |

- 【実機】1 turn の入力は 662〜663 token（`input_tokens` 2 と、cache の作成か読みの 660〜661）、出力は 61 token。#257 の isolated（637 token）と同じ桁。
- 【実機】run の後、`$MONICA_HOME/chat` は空のまま、`~/.claude/projects` に probe の cwd の directory は無く、`~/.claude.json` に probe の home の path は無かった。
- init に effort は出ない。SDK は `effort` を `--effort low` で渡す（上の引数）。

### 最初の text delta まで

【実機】prompt はどれも「1 から 30 を空白で並べて」（出力 61 token）。spare 無しは `query()` を呼んでから、spare ありは `startup()` が resolve して 1 秒待った後に `warm.query()` へ送ってから、最初の `text_delta` を受けるまで。CLI の値は result の `time_to_request_ms` と `ttft_ms`。

| .app | 起こし方 | 準備（`startup()`） | 最初の text delta | CLI の time_to_request_ms | CLI の ttft_ms |
|---|---|---|---|---|---|
| `Contents/MacOS` | spare 無し 1 回目 | 送信に含む | 1,316ms | 112ms | 848ms |
| `Contents/MacOS` | spare 無し 2 回目 | 送信に含む | 1,003ms | 283ms | 1,012ms |
| `Contents/MacOS` | spare 無し 3 回目 | 送信に含む | 963ms | 225ms | 966ms |
| `Contents/Resources` | spare 無し | 送信に含む | 1,022ms | 226ms | 1,021ms |
| `Contents/MacOS`、`--options runtime` | spare 無し | 送信に含む | 1,058ms | 221ms | 1,022ms |
| `Contents/MacOS` | spare あり 1 回目 | 224ms | 650ms | 16ms | 819ms |
| `Contents/MacOS` | spare あり 2 回目 | 227ms | 519ms | 15ms | 775ms |
| `Contents/MacOS` | spare あり 3 回目 | 227ms | 535ms | 16ms | 762ms |

- #257 の terminal からの数（spare 無し 973〜1,411ms、spare あり 628〜635ms）と同じ幅だった。`.app` から起こしたことで遅くはならなかった。
- 【実機】claude の RSS は、`startup()` の後の待機で 262〜270MB、1 turn の後で 273〜284MB。Backend 役は 45〜46MB。

## 4. spare

- 【実機】`startup({ options })` で起こした WarmQuery に `warm.query(input)` で送ると、3 回とも答えた。init は spare の時点の options（cwd・model・tools 0・MCP 0）で、`apiKeySource` は `none`。答え終えて iterator を閉じると、300ms 後には Backend 役の子孫は 0 だった。
- 【実機】`startup()` の後 1 秒待ち、送らずに `warm.close()` を呼んで、子を `kill -0` で見た。

  | .app | 回 | 準備 | close の後に子が居た最後の時刻 | 居なかった最初の時刻 |
  |---|---|---|---|---|
  | `Contents/MacOS` | 1 | 227ms | 1,000ms | 2,000ms |
  | `Contents/MacOS` | 2 | 227ms | 1,000ms | 2,000ms |
  | `Contents/Resources` | 1 | 235ms | 1,000ms | 1,250ms |
  | `Contents/Resources` | 2 | 239ms | 1,000ms | 1,250ms |
  | `Contents/Resources` | 3 | 230ms | 750ms | 1,000ms |

  - 8 秒まで見て、どの回も子は戻らず、Backend 役の子孫は 0 だった。
  - SDK の `close()` は stdin を閉じ、2,000ms 後に SIGTERM、さらに 5,000ms 後に SIGKILL を送る（#257 で読んだ 0.3.293 の `sdk.mjs`）。`Contents/Resources` の 3 回は 2,000ms より前に消えたので、claude は stdin の EOF で自分から抜けた。`Contents/MacOS` の 2 回は 1,000ms と 2,000ms の間のどこかで消えた。

## 5. turn の途中の SIGKILL

【実機】`spawnClaudeCodeProcess` で `node:child_process` の `spawn(command, args, { cwd, env, stdio: pipe×3, signal })` を返し、その child を持った。prompt は「1 から 400 を並べて」。最初の `text_delta` を受けた時点（`query()` から 1,162ms）で Backend 役の子孫を ps で取り、claude の pid に SIGKILL を送った。

| 項目 | 値 |
|---|---|
| kill の時点の子孫 | claude 1 つ（281MB）。claude の子（Backend 役から見た孫）は無い |
| child の `exit` event | 6.4ms 後、`code: null`、`signal: "SIGKILL"` |
| `kill -0` | 0ms では居て、10ms 以降（10・50・100・250・500ms、1・2.5・5 秒）は居ない |
| `query()` の iterator | 7.7ms 後に `Claude Code process terminated by signal SIGKILL` を投げた |
| 5 秒後の Backend 役の子孫 | 0 |

- ADR-0033 の options では tool も MCP server も無いので、turn の途中の claude は子を持っていなかった。
- `SpawnOptions.signal` は SDK が持つ abort の signal で、stdin の EOF と約 2 秒の猶予の後に abort する（`sdk.d.ts`）。即座に止めるには、持っている child に直に signal を送る。
- `sdk.mjs` の既定の spawn には `options.onProcessSpawned(pid)` を呼ぶ口があるが、`sdk.d.ts` の `Options` には無い。

## Monica.app を止めずに確かめる手順

### この調べで使った手順

本物の Monica に触れずに、`.app` の中の claude と launchd が親の Backend を確かめる。

1. 別の bundle id の `.app` を scratchpad に組む（`make-app.sh`）。identifier が違うので、Monica の `tauri_plugin_single_instance` にも、LaunchServices の Monica の登録にも当たらない。
2. `MONICA_HOME` は scratchpad の下の使い捨ての directory を引数で渡す。`~/.monica` の `backend.json`・`monica.db`・ptyd の socket に触れない。Shell 役は `--home` が無ければ `.app` の隣の `home-launch` に書く。
3. `env -i` で env を絞ってから `open -n` で起こす（`run-app.sh`）。Tab の env（`MONICA_HOME=~/.monica` や、この agent の `CLAUDE_CODE_*`）を probe に渡さないため。
4. probe は自分の子孫だけを ps で見る（`descendants()`）。止めるのは probe が記録した pid だけにし、名前で kill しない。
5. 終えたら、`.app` と home を消し、`lsregister -u <app>` で LaunchServices の登録を外す。

### 実装の受け入れ確認（入れ替える前）

release の build を入れずに、Chat の経路を確かめる。

1. worktree で `bun run build` を走らせる（release-app skill の 1）。書くのは worktree の `target/` と `apps/desktop/src-tauri/binaries/` だけで、動いている Monica には触れない。
2. `install-app` と同じ署名を、scratchpad の写しで確かめる。

   ```bash
   cp -R target/release/bundle/macos/Monica.app "$SCRATCH/Monica.app"
   codesign --force --sign Monica "$SCRATCH/Monica.app"
   codesign --verify --deep --strict --verbose=2 "$SCRATCH/Monica.app"
   codesign -dvv "$SCRATCH/Monica.app/Contents/MacOS/claude"   # Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)
   plutil -p "$SCRATCH/Monica.app/Contents/_CodeSignature/CodeResources" | grep -A3 'MacOS/claude'
   ```

3. 写しの中の Backend を、backend-headless skill の「release の build の Backend を確かめるとき」の形で起こす。`MONICA_HOME` は使い捨て、`MONICA_PTYD_PATH` と claude の場所は写しの `Contents/MacOS` を指す。env は `env -i` で launchd 相当に絞る。notes の口の port は 19380 以外を `MONICA_NOTES_PORT` で渡す。本物の Backend が 19380 を持っているため。ブラウザの口に `Sec-Fetch-Site: none` で質問を送り（ADR-0028）、答えが返ること、ps で Backend の子に claude が出て消えることを見る。launchd が親でも login と spawn が変わらないことは、この調べで確かめた。
4. 写しの `.app` そのものは並べて起こさない。identifier が `com.ashigirl96.monica` のままだと single-instance で抜けて本物の窓が前に出る。identifier を変えて起こしても、release の Shell は `~/.local/bin/monica` を写しの CLI に張り替える（`apps/desktop/src-tauri/src/cli_link.rs`）。写しを消すとこの link は切れる。

### 本物の `/Applications/Monica.app` を入れ替えるとき

release-app skill の「入れる」に沿う。

1. ユーザーの了承を得る。Monica が終了している間、Tab の会話を読んでいるユーザーには返事が見えないので、終了と起動はひと続きに行う。
2. `bun run install-app`。起きている Monica を `osascript … to quit` で終了させ、`.app` を一時の場所に `cp -R` し、`codesign --force --sign Monica`（`--deep` 無し）と quarantine の解除を済ませてから `/Applications` に置く。Tab の shell と claude は ptyd が持つ。ptyd は setsid で自分を切り離して Backend より長生きし（`packages/workbench/src/ptyd.ts`）、Shell が終了しても切れない。起こし直した Backend は同じ ptyd に繋ぎ直す。
3. 起こす。agent の Bash から起こすなら env を絞る。

   ```bash
   env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TMPDIR="$TMPDIR" \
     PATH=/usr/bin:/bin:/usr/sbin:/sbin open /Applications/Monica.app
   ```

   素の `open` では、その agent の `CLAUDECODE`・`CLAUDE_CODE_*`・`MONICA_TERMINAL_SESSION_ID` が Shell と Backend に入り、Chat の claude と user の Job に届く（backend-headless skill によれば Job は Backend の env をそのまま受ける）。Tab は ptyd が env を落とすので届かない。ユーザーに Dock から起こしてもらってもよい。
4. 確かめる。`~/.monica/backend.json` の pid が新しくなり、その port の `/health` が答える。`codesign -dvv /Applications/Monica.app/Contents/MacOS/claude` が Anthropic の署名。Chat で 1 問訊き、新しい Backend の pid の子に claude が出て、答えた後に消える。

## 後の実装に効く事実

- **install-app が claude を `.app` に写す**: 置き場所は `Contents/MacOS`。今の `codesign --force --sign Monica <bundle>`（`--deep` 無し）のままで claude の Anthropic の署名は残り、外側の署名は claude をその designated requirement で記録する。`--deep` は付けない。hardened runtime を入れるときも、claude と Bun の 2 つは `--deep` で一括に署名し直さない。`--deep --options runtime` では Backend も claude も `SharedArrayBuffer is not defined` で起きない。Tauri の bundler に署名させる場合も、externalBin は署名し直される。
  - `.app` は 236,330,608 byte 増える。`install-app` の `cp -R` と `rmSync` もその分重くなる。
- **Shell が env で場所を渡す**: probe は `locations::ptyd()` と同じ形で `Contents/MacOS/claude` を求め、`MONICA_CLAUDE_PATH` で Backend に渡した。Backend はそれを `pathToClaudeCodeExecutable` に渡すだけで spawn できた。dev の Backend（`bun --watch`）はこの env を受けず、SDK の既定の解決で node_modules の claude を拾う（#257）。
- **`packages/chat` の `ChatAgent`**:
  - claude の env は `process.env` を丸ごと渡さず、`packages/workbench/src/ptyd.ts` の `inheritableEnv()` と同じく `MONICA_*`・`CLAUDECODE`・`CLAUDE_CODE_*` を落としてから、ADR-0033 の 2 つを足す。Monica が Tab から `open` で起こされると、Backend の env にはその Tab の agent の `CLAUDE_CODE_SESSION_ID`・`CLAUDE_CODE_MESSAGING_SOCKET` などが入る。`inheritableEnv()` は `CLAUDE_EFFORT`・`CLAUDE_PID` のような `CLAUDE_CODE_` で始まらない key は落とさない。`ANTHROPIC_API_KEY` を落とすかは、ADR-0032 の「API key に替えるときは env で渡せば切り替わる」と合わせて決める。
  - 止めるための child は `spawnClaudeCodeProcess` で持てる。`node:child_process` の `spawn` に SDK の `command`・`args`・`cwd`・`env`・`signal` をそのまま渡せばよい。SIGKILL で子は 10ms 以内に消え、`query()` の iterator は `Claude Code process terminated by signal SIGKILL` を投げる。自分で止めた場合と claude が落ちた場合を、この error だけでは見分けられない。
  - spare の `close()` の後、子は最大で約 2 秒残る。Backend の終了では、ADR-0031 のとおり spare も含めて pid で SIGKILL する。

## 確かめていないこと

- Dock・Finder・login item から起こしたときの env。GUI の操作が要るので、`env -i` で絞った `open` で代えた。
- 本物の Tauri の Shell（NSApplication を持つ process）から起こした場合。probe の Shell 役は Rust の CLI で、`backend.rs` の env・stdio・process group だけを真似た。
- Tauri の bundler が externalBin の claude を手を加えずに写すか。今の Monica.app の externalBin は linker の ad-hoc の署名のままなので、署名の identity を渡さない今の build では bundler は署名していない（推論）。
- `CLAUDECODE`・`CLAUDE_CODE_*` を継いだ env で claude を起こしたときの振る舞い。この session の messaging socket に触れうるので試していない。
- SDK の版を上げた直後の、新しい cdhash の claude の最初の spawn の時間。
- Developer ID での署名と notarization。
- login の token の期限切れと refresh を、`.app` から起こした claude が行うとき。

## 試した script

`docs/research/bundled-claude-in-app/` に置いた。236MB の claude と compile の出力は repo に入れない。SDK を入れた scratch の directory で使う（`R268_SDK` と `R268_BUILD` に渡す）。

- `shell.rs`: Shell 役。`backend.rs` の `command()` と同じ形で Backend 役を起こし、自分の pid・ppid・env の key と Backend 役の stdout・終了を `$MONICA_HOME/shell.jsonl` に書く。
- `backend.ts`: Backend 役。step は `env`・`version`・`ask`・`spare`・`spare-close`・`kill`（`ask*3` のように回数を付ける）。
- `make-app.sh`: Shell 役と Backend 役を build し、claude を `Contents/MacOS` か `Contents/Resources` に写した `.app` を組み、`plain`・`runtime`・`deep`・`deep-runtime` のどれかで署名する。
- `run-app.sh`: `env -i` で絞って `open -n` で起こし、`results.jsonl` に `done` が出るまで待つ。
- `inspect.sh`: `.app` と claude の署名、`codesign --verify --deep --strict`、`spctl`、`CodeResources` の claude の行を読む。
- `launch.swift`: `NSWorkspace.openApplication` で起こす（env の継ぎ方を比べるため）。
- `init-check.ts`: prompt を送らずに `startup()` の initialize まで通す。
- `args-check.ts`: ADR-0033 の options で SDK が claude に渡す引数を出す。

## 出典

- https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle
- https://v2.tauri.app/distribute/macos-application-bundle/
- https://v2.tauri.app/reference/config/#externalbin
- https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk （0.3.293 の `sdk.d.ts` の `permissionPrompts`・`spawnClaudeCodeProcess`・`SpawnOptions`・`WarmQuery`、`sdk.mjs`）
- `docs/research/agent-sdk-in-backend.md`（branch `research/agent-sdk-in-backend`、#257）
- `docs/research/tauri-bun-sidecar.md`
- repo: `scripts/install-app.ts`、`scripts/build.ts`、`apps/desktop/src-tauri/src/backend.rs`・`locations.rs`・`cli_link.rs`・`lib.rs`、`apps/backend/src/main.ts`・`login-shell-path.ts`、`packages/workbench/src/ptyd.ts`・`tab-env.ts`、`crates/terminal-daemon/src/manager.rs`、`.claude/skills/release-app/SKILL.md`、`.claude/skills/backend-headless/SKILL.md`
