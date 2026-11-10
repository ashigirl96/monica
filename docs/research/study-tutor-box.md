# Study の箱を Agent SDK 0.3.293 で組めるか

問い: [#519](https://github.com/ashigirl96/monica/issues/519)（map は [#508](https://github.com/ashigirl96/monica/issues/508)）。[#517](https://github.com/ashigirl96/monica/issues/517) で決めた「Study（学習）の箱」を、`@anthropic-ai/claude-agent-sdk` 0.3.293（同梱の claude 2.1.293）で組めるかを、手元で組んで確かめた。箱の線は #517 の resolution のとおり: home の中で読めるのは Study の dir・Learning Preference（学び方の好み）の file・Tutor（先生）の dir だけ、書けるのは Study の dir と Learning Preference の file だけ、internet には出られ、loopback と LAN には出られず、箱の外の command は 1 回ごとに web で聞く。

この文書は事実だけを書き、どの組み方を取るかは決めない。

## 調べ方

- 一次資料: 入れた SDK 0.3.293 の型定義（`sdk.d.ts`、`sdk-tools.d.ts`）、Claude Code の docs（末尾の出典。docs は今の版のもので、2.1.293 と違う所は実測を正とした）、Zed の docs と source（v1.19.1）、Nix の manual。
- 手元の確認: Bun の使い捨ての script から、repo の node_modules の SDK 0.3.293 で `claude-haiku-5-5` を 50 回ほど呼んだ。prompt は「次の command を Bash で 1 回だけそのまま走らせる」のような短いもので、tool の入力と結果、`canUseTool`（host が承認する callback）と `PreToolUse` hook に来たものを記録した。
- 置いたもの（以下 `<fake>` は scratch の directory の下に作った偽の home）:
  - Study の dir: `<fake>/.monica/studies/study-1`（`cwd`）
  - Tutor の dir: `<fake>/.monica/tutors/repository`
  - Learning Preference の file: `<fake>/.monica/learning-preference.md`
  - 読ませたくない file: `<fake>/.monica/backend.json` と `<fake>/.ssh/id_canary`（中身はどちらも偽物）、`~/.cache/` の下に自分で置いた canary の file（終わって消した）
  - 本物の `~/.ssh`・`~/.claude`・`~/.monica`・`~/.monica/backend.json` は、読めるかだけを `ls` と `head -c 1 … >/dev/null` で見た（中身は出していない）
  - `127.0.0.1` だけで待つ `python3 -m http.server` を 2 つ（port 18519 と 18520）。動いている Backend の port には触れていない
  - LAN の宛先は手元の router（以下「LAN の IP」）
- 基本の options（Chat（問答）の `packages/chat/src/claude.ts` に寄せた）:

```ts
{
  model: 'claude-haiku-5-5',
  cwd: '<Study の dir>',
  settingSources: [], skills: [], strictMcpConfig: true, persistSession: false,
  tools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch'],
  permissionMode: 'default',
  permissionPrompts: 'none', // canUseTool を試す case だけ 'host'
  env: { USER, HOME, PATH: '<下の PATH>', CLAUDE_CODE_RESTRICTED: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
         ENABLE_CLAUDEAI_MCP_SERVERS: 'false', DISABLE_AUTOUPDATER: '1' },
  settings: { crossSessionInbound: 'refuse' },
  sandbox: {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: ['~', '<fake>'],
      allowRead: ['<Study の dir>', '<Tutor の dir>', '<Learning Preference の file>'],
      allowWrite: ['<Learning Preference の file>'],
      denyWrite: ['<Tutor の dir>'],
    },
  },
}
```

  PATH は `/nix/var/nix/profiles/default/bin`・`/opt/homebrew/bin`・`/usr/local/bin`・`/usr/bin`・`/bin`・`/usr/sbin`・`/sbin` と、mise が入れた node の dir（`~/.local/share/mise/installs/node/<版>/bin`）にした。
- 「実測」は手元で確かめた結果。「導いた」は docs・source・実測から読み取ったことで、その形では動かしていない。「未確認」は確かめられなかったこと。

## 要点

1. **箱の中の道具**: nix・mise・npm は、置き場所を Study の dir に向けて箱の中で動いた（実測）。道具ごとに足すものがある。nix は daemon の socket を **実の path**（`/private/var/run/nix-daemon.socket`）で `allowUnixSockets` に足し、`HOME` を Study の dir の下に向ける。`/var/run/nix-daemon.socket` や `/nix/var/nix/daemon-socket/socket` は symlink を通る path なので効かない。mise は `allowMachLookup` に configd と trustd を足す。npm は home の下にある node の dir を `allowRead` に足す。nix の daemon の socket を開けると、daemon が箱の外で build を走らせる道ができる（導いた）。
2. **読む線**: 組める（実測）。Bash は `denyRead: ['~']` と、Study の dir・Tutor の dir・Learning Preference の file の `allowRead` で、`~/.ssh`・`~/.monica/backend.json`・`~/.claude` を読めなくなった。file の tool は `CLAUDE_CODE_RESTRICTED=1` か `blockReadsOutsideWorkingDirectories` で作業場所（`cwd` と `additionalDirectories`）に閉じた。ただし、作業場所の外の 1 つの file（Learning Preference の file）は allow rule では開かなかった。その file を専用の dir に置いて作業場所に足すか、`PreToolUse` hook で path を判定する（hook は実測で組めた）。箱の中の Bash は外を指す symlink を Study の dir に作れたが、その symlink を通して読むことは Bash でも Read でも断られた。
3. **書く線**: 組める（実測）。Bash は Study の dir と `allowWrite` の file にだけ書け、Tutor の dir は `additionalDirectories` に入れても `denyWrite` で断られた。2.1.293 の `CLAUDE_CODE_RESTRICTED=1` は file の tool を作業場所に閉じた。作業場所に入れた Tutor の dir への Write は、`acceptEdits` でも deny rule（`Edit(//<Tutor の dir>/**)`）で断れた。穴が 1 つある。Claude Code の per-user temp（`/tmp/claude-<uid>`。Bash の `$TMPDIR`）は箱の中から読み書きでき、同じ user の他の Claude Code の session の一時 file もそこにある。
4. **通信**: 許可先を並べずに internet だけを開ける形は、proxy が新しい host ごとに出す `canUseTool('SandboxNetworkAccess', { host })` に host が答える形で組めた。host 名を引いて loopback・private・link-local なら断る関数で、`example.com` は通り、loopback と LAN は書き方を変えても断れた（実測）。`*` で全部を許すと、proxy を通して loopback の全 port と LAN に届いた（`WebFetch(domain:*)` でも `allowedDomains: ['*']` でも同じ。実測）。`deniedDomains` を足しても `0.0.0.0` で loopback に届いた（実測）。WebFetch は `localhost` だけを断り、`127.0.0.1`・`*.localhost`・`0.0.0.0`・LAN の IP には繋ぎに行った（実測）。http は https に上げられるので、平文で待つ口には TLS の挨拶が届いて失敗した。
5. **箱の外の許可**: 組める（実測）。`allowUnsandboxedCommands: true` と `permissionPrompts: 'host'` にすると、`dangerouslyDisableSandbox: true` を付けた Bash が `canUseTool('Bash', { command, description, dangerouslyDisableSandbox: true }, { decisionReason: 'dangerouslyDisableSandbox' })` で届く。断れば `message` が Tutor に返り、許せば箱の外で走った。`excludedCommands` は使えない。`docker *` を入れると、`docker ps` のように読むだけの command は聞かれずに箱の外で走った。
6. **container**: 届く（実測）。Docker Desktop 4.82.0 の container から `http://host.docker.internal:18519/` で、host の `127.0.0.1` だけで待つ server の中身を取れた。server の log の接続元は `127.0.0.1` だった。
7. **`allowLocalBinding` を port ごとに**: 絞れない。型は boolean で、`true` にすると 18519 と 18520 の両方に直に届いた（実測）。port を絞れるのは、proxy を通る接続を `allowedDomains: ['127.0.0.1:18519']` で許す形だけだった（実測）。`SandboxNetworkAccess` の問い合わせには port が無いので、host の側で port ごとに答えることはできない。
8. **Zed**: 実機では未確認（Zed を起こしていない）。docs では、新しい worktree は Restricted Mode で始まり、`.zed/settings.json` を読まず、language server も MCP server も起こさない。ただし手元の Zed（1.19.0）は `session.trust_all_worktrees: true` で、この守りが外れている。source では、`open -a Zed <file>` で開いた file を含む worktree が無ければ、Zed はその file だけの worktree を作るか、今の窓に足す。そのため file の dir の `.zed/` は読まれない（導いた）。Study の dir を folder として開いている窓があれば、その dir の `.zed/settings.json` が効き、手元の設定では聞かずに language server が起きる（導いた）。

## 1. 箱の中の道具（nix・mise・npm）

箱の中から tool の置き場所を Study の dir の下（`<Study の dir>/env/…`）に向けるため、env に次を足した。

```
XDG_CONFIG_HOME / XDG_CACHE_HOME / XDG_STATE_HOME / XDG_DATA_HOME = <Study の dir>/env/{config,cache,state,data}
MISE_DATA_DIR / MISE_CACHE_DIR / MISE_CONFIG_DIR / MISE_STATE_DIR = <Study の dir>/env/mise/…
MISE_GLOBAL_CONFIG_FILE = <Study の dir>/env/mise/config/config.toml
npm_config_cache = <Study の dir>/env/npm-cache、npm_config_userconfig = <Study の dir>/env/npmrc
```

通信は 4 章の `SandboxNetworkAccess` に答える関数（public の address だけを許す）で開けた。

### nix の daemon の socket

| `allowUnixSockets` | `nix store info` |
| :- | :- |
| 無し | `cannot connect to socket at '/nix/var/nix/daemon-socket/socket': Operation not permitted` |
| `['/nix/var/nix/daemon-socket/socket']` | 同じ |
| `['/var/run/nix-daemon.socket']` | 同じ |
| `['/private/var/run/nix-daemon.socket']` | `Store URL: daemon` / `Version: 2.34.6` / `Trusted: 0` |
| `allowAllUnixSockets: true` | 同じく通った |

- 手元の socket は `/nix/var/nix/daemon-socket/socket` → `/var/run/nix-daemon.socket` の symlink で、macOS の `/var` は `/private/var` への symlink。Seatbelt は解いた後の path で照らすので、`allowUnixSockets` には解いた後の path を書く必要がある（実測から導いた）。
- 実測: `HOME=<Study の dir>/env/home nix profile add --profile <Study の dir>/env/nix-profile nixpkgs#hello && <Study の dir>/env/nix-profile/bin/hello` が `Hello, world!` を出した。proxy が聞いた host は、Determinate Nix の registry と flakehub（`install.determinate.systems`、`flakehub.com`、`api.flakehub.com`、`flake-archives.flakehub.com`）の 4 つ。`hello` の本体は daemon が `cache.nixos.org` から取ったので、box の proxy を通っていない。
- `HOME` を向け替えないと、`error: creating Git repository "<Study の dir>/env/cache/nix/tarball-cache-v2": failed to stat '~/.gitconfig' (libgit2 error code = 7)` で止まった。`denyRead` の下の file を stat すると、無い（ENOENT）ではなく `Operation not permitted` が返るため（導いた）。home の下の設定 file を読みに行く道具は、同じ理由で止まりうる。
- 後始末: profile の link を消し、足された 4 つの store path（`hello` とその `.drv` 2 つ、`profile`）を `nix store delete` で消せた。nixpkgs の source は store に入らず、`XDG_CACHE_HOME` の下の git の cache に入った。
- **daemon の道（導いた。動かしていない）**: daemon は untrusted の user（`Trusted: 0`）からも derivation の build を受ける。手元の `nix config show` は `sandbox = false`、`allowed-users = *`。Nix の manual は sandbox の既定を「true on Linux and false on all other platforms」とし、fixed-output derivation は Linux の sandbox でも network を持つと書く。macOS では、box の中から頼んだ build の builder が、Seatbelt の外で build user として走り、network も proxy を通らない。loopback に届く builder を書けば、4 章の線を越えられる。

### mise

| 足したもの | `mise install jq@1.7.1 && mise exec jq@1.7.1 -- jq --version` |
| :- | :- |
| 無し | panic: `Attempted to create a NULL object.`（`system-configuration` crate の `dynamic_store.rs`） |
| `allowMachLookup: ['com.apple.SystemConfiguration.configd']` | `client error (Connect): The certificate was not trusted.` |
| 上に `com.apple.trustd.agent` と `com.apple.trustd` を足す | `jq-1.7.1`（通った） |

- mise の HTTP client は macOS の system の proxy 設定（configd）と証明書の検証（trustd）を Mach の service に聞く。Seatbelt は既定でどちらも塞ぐ（実測から導いた）。docs は `allowMachLookup` を「Sandboxed commands can reach outside the sandbox to each service that you list」と書く（[Settings reference](https://code.claude.com/docs/en/settings-reference#sandbox-network-allowmachlookup)）。
- trustd の 2 つのうち、どちらが要るかは分けていない（未確認）。

### npm

- `npm --version` は `bash: ~/.local/share/mise/installs/node/<版>/bin/npm: Operation not permitted`（exit 126）で止まった。node が home の下にあり、`denyRead: ['~']` で実行もできなくなるため。
- `allowRead` に `~/.local/share/mise/installs/node` を足すと、`npm install --prefix <Study の dir>/proto is-number@7.0.0` が `added 1 package` で通った。proxy が聞いた host は `registry.npmjs.org` だけ。
- 手元の login shell の PATH は 67 個の dir のうち 44 個が home の下にある。login shell の PATH を渡すなら、そのうち使う道具の dir ごとに `allowRead` が要る（導いた）。

## 2. 読む線

### Bash

実測（左が基本の options、右が `filesystem` を渡さない sandbox）:

| path | `filesystem` あり | 無し |
| :- | :- | :- |
| `<Study の dir>/notes.md` | 読めた | 読めた |
| `<Tutor の dir>/SKILL.md` | 読めた | 読めた |
| `<Learning Preference の file>` | 読めた | 読めた |
| `<fake>/.monica/backend.json`、`<fake>/.ssh/id_canary` | 断られた | 読めた |
| `~/.cache/` の下の canary | 断られた | 読めた |
| `~/.monica/backend.json` | 断られた | 読めた |
| `ls ~/.ssh`・`ls ~/.claude`・`ls ~/.monica` | 断られた | 通った |
| scratch の下の別の dir の file（`/tmp/claude-<uid>` の下） | 読めた | 読めた |

- `allowRead` は `denyRead` の内側を開け直す。dir だけでなく file 1 つも開けられた（Learning Preference の file）。docs: 「Re-open reading for specific paths inside a region that `denyRead` blocks, to build workspace-only read access」（[Settings reference](https://code.claude.com/docs/en/settings-reference#sandbox-filesystem-allowread)）。
- `~/.claude` を読めなくしても、Bash の tool は動いた。
- 最後の行は穴になる。`/tmp/claude-<uid>` は home の外なので #517 の線では読めてよい側に入る。だがこの dir には、同じ user の他の Claude Code の session の scratchpad や、tool の出力を書いた file が置かれる。手元ではこの調べの session の scratchpad もここにあった。`denyRead` に足すかは 3 章の temp と一緒に決める。
- **symlink**: 箱の中の Bash で `ln -sf <canary> <Study の dir>/link.txt` は通った（作るだけなら、指す先を読む権限は要らない）。その link を `cat` すると `Operation not permitted` になった（実測）。Seatbelt は解いた先で照らす。

### file の tool（Read・Grep・Write・Edit）

| 組み方 | 作業場所の中（Study の dir、`additionalDirectories` の Tutor の dir） | 作業場所の外（Learning Preference の file、`backend.json`、canary） |
| :- | :- | :- |
| `CLAUDE_CODE_RESTRICTED=1` | Read は通る | Read も Grep も `… is outside <作業場所>; --restricted confines the file tools to the working directory.` で断られた。`Edit(//<Learning Preference の file>)` の allow rule を足しても同じ |
| `blockReadsOutsideWorkingDirectories: true`（restricted なし） | Read は通る | `… the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories.` で断られた。`Read(//<Learning Preference の file>)` の allow rule を足しても同じ |
| どちらも無し（restricted なし） | Read は通る | allow rule のある file（Learning Preference の file）は読めた。他は承認に回り、`permissionPrompts: 'none'` で断られた |
| `PreToolUse` hook（restricted なし） | hook が allow を返して通る | 下に書く |

- path の rule は `//` で始めると絶対 path になる（[Permissions](https://code.claude.com/docs/en/permissions)）。表の rule はどれもこの形で書いた。
- **hook で線を引く形**（実測）: `PreToolUse` hook で、Read・Write・Edit・Grep・Glob の `file_path` か `path` を `realpath` で解く。Study の dir の中か Learning Preference の file なら `permissionDecision: 'allow'`、Read で Tutor の dir の中なら allow、それ以外は `deny` を返した。
  - 作業場所の外の Learning Preference の file の Read と Edit は通った。
  - `backend.json`・canary の Read、canary の dir の Grep、Tutor の dir への Write は `PreToolUse:Read hook error: outside the box: …` で断られた。
  - Study の dir に作った canary への symlink は、解いた先で判定したので断れた。
  - Glob の `pattern` に絶対 path を書いた時に hook が何を見るかは試していない（未確認）。
- **symlink**: restricted でも `blockReadsOutsideWorkingDirectories` でも、Study の dir の symlink を通した Read は `… resolves through a symlink to ~/.cache/…, which is outside <Study の dir>` で断られた（実測）。docs も、allow は要求した path と解いた先の両方が合う時だけ効くと書く（[Permissions](https://code.claude.com/docs/en/permissions)）。

## 3. 書く線

### Bash

実測（基本の options に `additionalDirectories: [<Tutor の dir>]` を足した）:

| path | 結果 |
| :- | :- |
| `<Study の dir>/w.txt` | 書けた（`cwd`） |
| `<Learning Preference の file>` | 書けた（`allowWrite`） |
| `<Tutor の dir>/w.txt` | `operation not permitted`（`denyWrite` は `additionalDirectories` より強い） |
| `~/.cache/` の下 | `operation not permitted` |
| `<fake>/.monica/w.txt`、scratch の下の別の dir | 書けた（下の temp の dir の中にあるため） |

- **per-user temp**: 箱の中の `$TMPDIR` は `/tmp/claude-<uid>` で、その直下にも書けた（実測）。docs は「A per-user temp directory is writable inside the sandbox by default」と書く（[Sandboxing](https://code.claude.com/docs/en/sandboxing)）。この dir は同じ user のすべての Claude Code の session が使う。そのため、乗っ取られた Tutor が他の session の一時 file を書き換えられる（導いた）。
- `CLAUDE_CODE_TMPDIR` を scratch の下の長い path に向けても、箱の中の `$TMPDIR` は `/tmp/claude-<uid>` のままで、直下にも書けた（実測）。docs は「sandboxed Bash subprocesses receive a short fallback `$TMPDIR` under the system default when your override is a long path」と書く（[Environment variables](https://code.claude.com/docs/en/env-vars)）。短い path に向ければ他の session の dir と分かれるかは、scratch の外に dir を作る必要があり試していない（未確認）。実の Study の dir（`~/.monica/studies/…`）は home の下なので、表の `<fake>/.monica/w.txt` の行は実の配置では断られる側になる（`~/.cache/` の行と同じ。導いた）。

### file の tool

- 2.1.293 で `CLAUDE_CODE_RESTRICTED=1` は file の tool を作業場所に閉じた（実測）。作業場所の外への Write は `… is outside …; --restricted confines the file tools to the working directory.` で断られた。docs の「confines the built-in file tools to the working directories」（[CLI reference](https://code.claude.com/docs/en/cli-reference)）と合う。
- 作業場所に入れた Tutor の dir への Write の結果:
  - `default` の mode: 承認に回り、`permissionPrompts: 'none'` で断られた。`'host'` なら `canUseTool` に来る（導いた。Bash では実測）。
  - `acceptEdits` の mode: deny rule `Edit(//<Tutor の dir>/**)` で `File is in a directory that is denied by your permission settings.` になった（実測）。
- `blockWritesOutsideWorkingDirectories` は 0.3.293 の型に無く、docs は v2.1.314 以降と書く（[Permissions](https://code.claude.com/docs/en/permissions)）。restricted が同じ働きをした。
- Study の dir への Write は、restricted の下で allow rule `Edit(//<Study の dir>/**)` を付けて通った（実測）。

## 4. 通信

### proxy の振る舞い（Bash）

箱の中の env には proxy の変数と `NO_PROXY` が入っていた。`NO_PROXY` には `localhost`・`127.0.0.1`・`::1` と、link-local と 3 つの private の範囲（CIDR）が並んでいた。`curl` は既定でこれらに直に繋ぎ、Seatbelt に断られる。`curl --noproxy ''` は proxy を通す。

実測（`ext` は `https://example.com/`。loopback は自分の server。`lo` は `127.0.0.1`）:

| 設定 | ext | lo に直に | lo:18519 を proxy で | lo:18520 を proxy で | `localhost`・`foo.localhost` を proxy で | LAN の IP を proxy で |
| :- | :- | :- | :- | :- | :- | :- |
| 許可先なし・`'none'` | 403 | 失敗 | 403 | 403 | 403 | 403 |
| `WebFetch(domain:*)` の allow rule | 200 | 失敗 | **200** | **200** | **200** | **届いた** |
| `allowedDomains: ['*']` | 200 | 失敗 | **200** | **200** | **200** | **届いた** |
| `*` に `deniedDomains: ['localhost', '*.localhost', '127.0.0.1', '[::1]', <LAN の IP>]` | 200 | 失敗 | 403 | 403 | 403 | 403 |
| `allowedDomains: ['127.0.0.1:18519']` | 403 | 失敗 | **200** | 403 | 403 | 403 |
| `allowLocalBinding: true` | 403 | **200** | 403 | 403 | 403 | 403 |
| `'host'` で `SandboxNetworkAccess` を全部許す | 200 | 失敗 | **200** | **200** | **200** | **届いた** |
| `'host'` で public の address だけ許す | 200 | 失敗 | 403 | 403 | 403 | 403 |

- 直に繋ぐ道は、`allowLocalBinding` 以外のどの設定でも Seatbelt に断られた。
- proxy の「名前が local の address に解けたら断る」確かめは、IP の literal には効かない。docs は「The check applies to hostnames. Your allowed domains and permission mode decide a connection to an IP address.」と書く（[Sandboxing](https://code.claude.com/docs/en/sandboxing)）。`*` を許すと `127.0.0.1` に届くのはこのため。`localhost` と `*.localhost` は docs のとおり loopback に解けてよい名前として通った。
- **`deniedDomains` の抜け道**（実測。`*` と上の deny を並べた）:
  - `127.1`・`2130706433`・`[::ffff:127.0.0.1]`・`[::1]` は、proxy が `127.0.0.1` か `::ffff:7f00:1`・`::1` に直してから deny に当てて断った。
  - `127.0.0.1.nip.io` は `resolved to a deny-listed address` で断られた。
  - **`0.0.0.0:18519` は deny に当たらず、loopback の server の中身が返った。**
  - private の範囲の address に解ける nip.io の名前（以下 `<private>.nip.io`）は断られず、繋ぎに行って timeout した。docs も「An allowed intranet hostname that resolves to a private range … connects」と書く。
  - `deniedDomains` は domain・wildcard・IP の literal だけを受け、CIDR の範囲は書けない（[Settings reference](https://code.claude.com/docs/en/settings-reference#sandbox-network-denieddomains)）。LAN の全範囲は並べられない。

### `SandboxNetworkAccess` に host が答える形

- `permissionPrompts: 'host'` で許可先を並べないと、proxy は新しい host ごとに `canUseTool('SandboxNetworkAccess', { host: 'example.com' }, …)` を呼んだ（実測）。`input` は `host` だけで、port は無い。型定義にこの tool の名前は無く、claude の binary の中にある名前（2.1.293）。`permissionPrompts: 'none'` だと呼ばれず、`deny network-outbound example.com:443 (user denied)` で断られた。
- 答える関数（実測で使った形）: host 名を `dns.lookup(host, { all: true })` で引く。`localhost`・`*.localhost` と、どれかの address が `127.`・`10.`・`192.168.`・`172.16-31.`・`169.254.`・`0.`・`::1`・`::`・`::ffff:`・`fc`/`fd`・`fe80` で始まるもの、引けないものは断る。
- 結果（実測）: `example.com`・`registry.npmjs.org`・`api.github.com` などは通った。proxy から次の host が届き、すべて断れた: `127.0.0.1`（`127.1`・`2130706433` も proxy が直してから聞いた）・`0.0.0.0`・`::ffff:7f00:1`・`::1`・`localhost`・`foo.localhost`・`127.0.0.1.nip.io`・`<private>.nip.io`・LAN の IP。
- **残る穴（導いた）**: 許した名前が後で別の address に引き直される（DNS rebinding）場合。proxy は答えの後に自分で名前を引き直し、loopback に解けた名前は自分で断った（実測: 全部を許した上で `localtest.me` と `127.0.0.1.nip.io` が `blocked: resolved to a loopback address`）。だが private の範囲に解けた名前は断らない（docs と `<private>.nip.io` の実測）。public の名前を LAN の address に引き直させれば、LAN には届きうる。docs は Yes の答えを「for the rest of the current session」効くとする（[Sandboxing](https://code.claude.com/docs/en/sandboxing)）。
- host の答えは sandbox の中の command だけに効く。WebFetch は別（下）。

### WebFetch

allow rule `WebFetch` で全部を許して実測した。

| URL | 結果 |
| :- | :- |
| `http://localhost:18519/` | `WebFetch cannot fetch localhost or other hostnames without a dot.` |
| `http://127.0.0.1:18519/`、`http://foo.localhost:18519/`、`http://monica.localhost:18519/`、`http://0.0.0.0:18519/` | `SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER`。server の log に TLS の ClientHello が届いていた |
| `http://<LAN の IP>/` | `unable to verify the first certificate`（LAN の機器の https に繋いだ） |

- WebFetch は claude の process の中で動き、sandbox の proxy を通らない。refuse するのは点の無い host 名だけで、`127.0.0.1`・`*.localhost`・LAN の IP には繋ぎに行く。http は https に上げられる（docs: [Tools reference](https://code.claude.com/docs/en/tools-reference)）。
- `http://monica.localhost:19380`（平文で待つ browser listener）にも同じく https で繋ぎに行き、TLS の挨拶で失敗するので、HTTP の要求にはならない（導いた。19380 には触れていない）。https で待つ手元の口があれば中身を取れる（導いた）。
- deny rule `WebFetch(domain:127.0.0.1)`・`WebFetch(domain:*.localhost)`・`WebFetch(domain:0.0.0.0)`・`WebFetch(domain:<LAN の IP>)` を足すと（実測）:
  - `127.0.0.1`・`monica.localhost`・`0.0.0.0` は `WebFetch denied access to domain:…` で断られた。
  - `127.1` と `2130706433` は `127.0.0.1` に直されてから断られた。
  - loopback に解ける public の名前（`127.0.0.1.nip.io`）は断られず、server に TLS の挨拶が届いた。
- 名前で閉じるには、WebFetch を allow rule で通さず、`canUseTool` か `PreToolUse` hook で `url` の host を引いて判定する必要がある（導いた）。その場合も、判定の後の引き直しの穴は残る。

## 5. 箱の外の command を web に聞く

実測（command は `docker ps -q --filter label=monica.study=research-519`。`'host'` の case は `canUseTool` が断るか許す）:

| 設定 | 結果 |
| :- | :- |
| 基本の options（箱の中） | `Error loading config file: open ~/.docker/config.json: operation not permitted` と `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` |
| `allowUnsandboxedCommands: false` で `dangerouslyDisableSandbox: true` を付けさせる | 付けた値は無視され、箱の中で走って同じ失敗。`canUseTool` は呼ばれない |
| `allowUnsandboxedCommands: true`、`'host'`、断る | `canUseTool('Bash', { command, description, dangerouslyDisableSandbox: true }, { decisionReason: 'dangerouslyDisableSandbox' })` が来た。断った `message` がそのまま tool の結果として Tutor に返った |
| 同じで許す | 箱の外で走り、docker の socket に届いた |
| `excludedCommands: ['docker *']`、`'host'`、断る | `docker ps` は `canUseTool` を呼ばずに箱の外で走った |
| 同じで `docker rm monica-research-519-none` | `canUseTool('Bash', { command, description }, { decisionReason: 'This command requires approval' })` が来て、断れた |

- `PreToolUse` hook の `tool_input` にも `dangerouslyDisableSandbox: true` が見えた（実測）。
- `excludedCommands` に当たる command は箱の外で走る。そのうち Claude Code が読むだけと見なす command は、承認なしで通った（実測。docs の「goes through the regular permission flow」と食い違う。読むだけの command を自動で許す普段の決まりが効いたと見られる。導いた）。`canUseTool` の入力にも、箱の外で走るという印が無い。docs は `excludedCommands` を「A convenience, not a security boundary」と書く（`sdk.d.ts` の Settings）。
- **箱の中でも承認に回る command**: Claude Code が走らせる前に調べられない形の command は、箱の中で走るものでも承認に回った。例は `( … )` の group、`$?`、path の引数に変数（`ls "$d"`）、`HOME=… cmd` の前置き。`decisionReason` には `A group in parentheses in this command can't be checked before it runs` などが入る（実測）。
  - `'none'` では断られた。
  - `'host'` で `dangerouslyDisableSandbox` の無い Bash を許すと、箱の中で走った（canary への書き込みは断られ、Study の dir には書けた）。
  - web に 1 本ずつ聞く形にするなら、host は「`dangerouslyDisableSandbox` の無い Bash は聞かずに許す」と決めておかないと、ふつうの command でも会話が止まる（導いた）。
- docs の「unsandboxed retry」: sandbox に断られた後、Claude が `dangerouslyDisableSandbox` を付けて試し直すことがある。allow rule が当たると承認なしで通る（[Sandboxing](https://code.claude.com/docs/en/sandboxing)）。Bash の allow rule を置かなければ、試し直しは必ず `canUseTool` に来る（導いた）。

## 6. container から host の 127.0.0.1 へ

- 実測: host の `127.0.0.1:18519` だけで待つ server に対し、次を流した。

```
docker run --rm --label monica.study=research-519 alpine:3 sh -c 'getent hosts host.docker.internal; wget -qO- -T 5 http://host.docker.internal:18519/'
```

- `host.docker.internal` は Docker Desktop の中の address（IPv6 の ULA）に解け、`LOOPBACK-OK-18519`（server の中身）が返った。server の log には `127.0.0.1 - - "GET / HTTP/1.1" 200` が残った。
- Docker Desktop 4.82.0（Engine 29.6.1）。docs は「On the host, Docker Desktop's backend process receives the traffic and creates standard TCP/IP connections」と書き、host の process が繋ぎ直すので loopback だけで待つ口にも届く（[Networking](https://docs.docker.com/desktop/features/networking/)）。
- 届く以上、container の中の code は、Host header と `Sec-Fetch-Site` を自由に書いて browser listener に話しかけられる（#517 の調べた事実から導いた）。

## 7. `allowLocalBinding` を port ごとに絞れるか

- 型は `allowLocalBinding: z.ZodOptional<z.ZodBoolean>`（`sdk.d.ts` の `SandboxNetworkConfigSchema`）。docs は「`true`: sandboxed commands on macOS can listen on any local address and connect to any port on localhost」（[Settings reference](https://code.claude.com/docs/en/settings-reference#sandbox-network-allowlocalbinding)）。
- 実測: `true` で `127.0.0.1:18519` にも `:18520` にも直に届いた。
- 代わりの道（実測）: `allowedDomains: ['127.0.0.1:18519']` は、proxy を通る接続だけを 18519 に開けた（18520 は 403）。直の接続は断られたままなので、`NO_PROXY` を見る道具（curl など）は proxy を使わせないと届かない。HTTP の proxy を使わない道具は届かない（docs の「Tools that ignore the proxy variables … can't connect」）。
- `SandboxNetworkAccess` の問い合わせには port が無い（4 章）。host が `127.0.0.1` を許すと、全 port を許すことになる。

## 8. Zed で Study の dir の file を開いた時

docs と source と手元の設定だけを見た。Zed は起こしていない。

- docs（[Zed and trusted worktrees](https://zed.dev/docs/worktree-trust)）:
  - 「all worktrees start in Restricted Mode」。Restricted Mode が止めるのは「Project settings (`.zed/settings.json`) from being parsed and applied」「Language servers from being installed and spawned」「MCP servers from being installed and spawned」の 3 つ。
  - 「By default, Zed does not trust new worktrees」。`"session": { "trust_all_worktrees": true }` で全部を trust する。
  - 「Zed still trusts tools it installs globally」。global の language server（Prettier など）は trust と関係なく起きる。
  - file 1 つは「single file worktree」で、「Each single file worktree requires a separate trust grant, unless the directory containing it is trusted or all worktrees are trusted」。directory を trust すると「we also enable single file worktree trust for the host in question automatically」。
- 手元: Zed 1.19.0。`~/.config/zed/settings.json` に `"session": { "trust_all_worktrees": true }` がある。Restricted Mode は効いていない。
- source（v1.19.1。手元の 1.19.0 に一番近い tag）:
  - `crates/workspace/src/workspace.rs` の `open_paths`: 開く path を含む worktree が無く、path がすべて file なら、今の窓に見えない worktree として足す。窓が無ければ `find_or_create_worktree(<file>)` で file を root にした worktree を作る。
  - `crates/project/src/project_settings.rs`: `.zed/settings.json`・`.zed/tasks.json`・`.zed/debug.json` は worktree の中の entry の変化から読む。設定（Settings）だけを `can_trust` で止め、tasks は trust を見ずに読み込む（`update_settings`）。
- 導いた:
  - `open -a Zed <Study の dir>/<file>` で、その file を含む worktree が開いていなければ、worktree は file だけになり、Study の dir の `.zed/settings.json` は読まれない。
  - Study の dir（かその上）を folder として開いた窓が残っていれば、file はその worktree で開き、`.zed/settings.json` が効く。手元の `trust_all_worktrees: true` では、そこに書いた language server の設定（binary の path や引数）が聞かずに走りうる。
  - `.zed/tasks.json` の task は、ユーザーが走らせるか、hook（docs では `create_worktree` だけ）でしか走らない（[Tasks](https://zed.dev/docs/tasks)）。
- 未確認:
  - file だけの worktree で、global の language server が file の上の dir を見て project の code を走らせるか（たとえば build script）。
  - `format_on_save`、direnv、`.editorconfig` の扱い。
  - 実機で何が起きるか。

## 9. 組める形と残る穴

実測で線が通った組み合わせ（どれを取るかは決めていない）:

- Bash: 基本の options の `sandbox` に次を足す。
  - nix の socket（`/private/var/run/nix-daemon.socket`）
  - mise 用の `allowMachLookup`（configd、trustd）
  - 使う道具の home の下の dir を `allowRead` に
  - tool の置き場所の env（`HOME` を含む）を Study の dir の下に
- file の tool: `CLAUDE_CODE_RESTRICTED=1` と `additionalDirectories: [<Tutor の dir>]` と deny rule `Edit(//<Tutor の dir>/**)`。Learning Preference の file は専用の dir に置いて作業場所に足すか、restricted を外して `PreToolUse` hook で realpath を判定する。
- 通信: 許可先を並べず `permissionPrompts: 'host'` にし、`SandboxNetworkAccess` を host 名を引いて答える。WebFetch は allow rule で通さず、`canUseTool` か hook で同じ判定をする。
- 箱の外: `allowUnsandboxedCommands: true` にし、`dangerouslyDisableSandbox: true` の Bash を `canUseTool` で web に出す。`excludedCommands` と Bash の allow rule は置かない。`dangerouslyDisableSandbox` の無い Bash の承認は host が聞かずに許す。

残る穴:

1. `/tmp/claude-<uid>`（per-user temp）が読み書きできる（3 章）。
2. nix の daemon に build を頼むと、箱の外で network を持つ builder が走る（1 章。導いた）。
3. 許した名前の DNS rebinding で LAN に届きうる（4 章。導いた）。
4. container から host の loopback に届く（6 章）。
5. Zed は手元の設定で trust の守りが外れている（8 章）。

## 出典

- SDK 0.3.293 の型定義: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`Options` の `sandbox`・`permissionPrompts`・`canUseTool`、`SandboxNetworkConfigSchema`、`SandboxSettingsSchema`、Settings の `permissions`）、`sdk-tools.d.ts`（Bash の `dangerouslyDisableSandbox`）
- 同梱の claude 2.1.293（`claude --version`。`SandboxNetworkAccess` の名前は binary の中）
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Settings reference](https://code.claude.com/docs/en/settings-reference)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Environment variables](https://code.claude.com/docs/en/env-vars)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)
- [Configure permissions（Agent SDK）](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Docker Desktop: Networking](https://docs.docker.com/desktop/features/networking/)
- [Nix: nix.conf の `sandbox`](https://nix.dev/manual/nix/latest/command-ref/conf-file.html#conf-sandbox)
- [Zed and trusted worktrees](https://zed.dev/docs/worktree-trust)
- [Zed: Tasks](https://zed.dev/docs/tasks)
- Zed の source（v1.19.1）: `crates/workspace/src/workspace.rs`（`open_paths`）、`crates/project/src/project_settings.rs`（`update_local_worktree_settings`・`update_settings`）、`crates/project/src/worktree_store.rs`（`find_or_create_worktree`）
- [web から Study の agent を動かす口の守り方（#517）](https://github.com/ashigirl96/monica/issues/517)
- [Agent SDK で 1 つの Study の会話を何日もまたいで続けられるか（#510）](https://github.com/ashigirl96/monica/blob/research/study-agent-sdk-sessions/docs/research/study-agent-sdk-sessions.md)
