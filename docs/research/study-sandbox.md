# Study の隔離環境の道具

[#509](https://github.com/ashigirl96/monica/issues/509) の調査。macOS で、Study（学習）ごとにツールやライブラリを入れて試し、手元の環境を汚さない方法には何があり、それぞれ何ができるかを調べた。どれを使うかは決めない（後の grilling のチケットで決める）。ここには事実と、その事実から読める得失だけを書く。

- 調べた日: 2026-11-10
- 手元: macOS 26.6.2（Apple Silicon）、Determinate Nix 3.21.0（nix 2.34.6）、Docker Desktop 4.82.0（Engine 29.6.1）、mise 2026.1.9、direnv 2.37.1、`@anthropic-ai/claude-agent-sdk` 0.3.293
- 「手で確かめた」と書いた項目は、scratch の dir に `study-*/env` を作って動かした結果。数字はこの 1 台で 1 回ずつ測ったもので、目安にとどまる。

## 要点

1. **道具は 2 種類に分かれる。** nix と mise は「道具を揃える」もので、書き込みも通信も囲わない。Seatbelt（Agent SDK の `sandbox`、`@anthropic-ai/sandbox-runtime`）は「書き込みと通信を囲う」もので、道具を揃えない。docker は Linux の VM の中で両方をやるが、試せるのは Linux のものだけになる。
2. **global な install は、どの道具でも「よそへ向け直す」か「止める」かのどちらかになる。** nix と mise は何もしないので、`NPM_CONFIG_PREFIX`・`npm_config_cache`・`CARGO_HOME` などを Study の dir へ向ける必要がある。Seatbelt は向け直さずに書き込みを拒む（`EPERM`）。docker は container の層に書かれ、container ごと消える。
3. **消した後に残るもの** は、nix なら store の path（`nix store gc` で回収）と `~/.cache/nix`、docker なら image と VM の disk、mise なら共有の install。Seatbelt は状態を持たない。
4. **agent と人が同じ環境に入る方法** は道具ごとに違う。nix は `CLAUDE_ENV_FILE` と Tab（端末画面）の起動コマンドで両方を揃えられる。docker は `docker exec` で両方が入れる。Seatbelt は agent の Bash にだけ掛かり、人の Tab を囲うには shell を `srt` で包む必要がある。
5. **macOS でしか動かないもの**（brew で配るツール、macOS の GUI）は docker では試せない。nix は macOS の binary をそのまま動かすが、隔離はしない。

## 比べた表

| 観点 | nix（flake の devShell・Study ごとの profile） | docker（Docker Desktop） | Seatbelt（Agent SDK の `sandbox`・`srt`） | mise |
|---|---|---|---|---|
| file の書き込み | 囲わない | container の中と bind mount だけ | 既定で cwd と `$TMPDIR` だけ書ける | 囲わない |
| `npm -g`・`cargo install` | 既定では `npm -g` は read-only の store に当たって失敗する。shellHook で prefix を Study の dir に向ければ入る | container の層に入る | 拒まれる（`EPERM`）。prefix を cwd の中へ向ければ入る | 使っている版の install dir（全 project で共有）に入る |
| `brew install` | 止めない（`/opt/homebrew` に入る） | brew が無い（Linux）。代わりの `apt` は container の中で閉じる | 拒まれる | 止めない |
| network | 囲わない | 既定では外へ出られる。host へは `host.docker.internal` | proxy を通し、許した domain だけ。最初は空 | 囲わない |
| 消し方 | Study の dir を消し、`nix store gc` で回収 | `docker rm`。image は別に消す | 消すものが無い | `mise.toml` を消す。install は共有なので残る |
| agent の Bash の入り方 | `CLAUDE_ENV_FILE` で `nix print-dev-env` の出力を読ませる | `spawnClaudeCodeProcess` で container の中に claude を起こす。または Bash を MCP の tool に向け直す | SDK の `sandbox` option | `mise exec` か shims |
| 人の Tab の入り方 | `nix develop <profile>`、または direnv の `use flake` | `docker exec -it <container> bash` | 自動では掛からない。`srt` で shell を包む | zsh の activate hook |
| CLI・ライブラリ | macOS の binary がそのまま動く | Linux（arm64）のものだけ | host にあるものが囲われて動く | 言語の runtime と、その package |
| 常駐する service | host の process として動き、port は localhost に出る | `-p` で publish するのが自然 | `allowLocalBinding` が要る。有効にすると localhost の全 service に届く | host の process |
| GUI | macOS の app として動く（確かめていない） | Linux の GUI を出すには別に X か VNC が要る（推測） | `open` と Apple Events は既定で拒まれる | 対象外 |
| Study ごとの容量（手で確かめた） | dir は数 MB。store は Study 間で共有し、`mkShell` の devShell の閉包は 1.4 GiB（その大半は compiler） | image は共有（`node:22-bookworm-slim` で 349 MB）。container の層は 5 MB | 0 | install は共有 |
| 作る時間（手で確かめた） | 初回 11 秒、2 回目から 1 秒未満、保存した profile なら 0.15 秒 | image があれば container の作成と起動で約 1 秒 | 準備は要らない | 測っていない |

## nix

### 何をするか

- `nix develop` は「derivation の build 環境を持つ bash を起こす」コマンドで、flake では `devShells.<system>.default` を選ぶ。`--profile` を渡すと、その環境を profile として残せる（[nix develop の manual](https://nix.dev/manual/nix/latest/command-ref/new-cli/nix3-develop)）。
- `nix shell` は、指定した package を `$PATH` に足した shell を起こすだけ（手元の `nix shell --help`）。
- `nix print-dev-env` は、build 環境を再現する shell のコードを出す。`. <(nix print-dev-env ...)` で今の shell に読み込める（手元の `nix print-dev-env --help`）。
- manual は `nix develop` に、file の書き込みや `HOME` を隔離する仕組みを書いていない。nix の環境は sandbox ではない。

### 手で確かめたこと

- **devShell を Study の dir に作れる。** `study-a/env/flake.nix` に `mkShell { packages = [ nodejs_22 ripgrep ]; shellHook = ...; }` を書き、`nix develop --profile env/.dev-profile` で入った。
- **`npm -g` は、向け直さないと失敗する。** nix の node の global の prefix は store の中（`/nix/store/...-nodejs-slim-22.23.4`）で、`npm i -g` は `EACCES: permission denied, mkdir '/nix/store/...'` で止まった。shellHook で `NPM_CONFIG_PREFIX` と `npm_config_cache` を `$STUDY_ENV` の下へ向けると、`npm i -g cowsay` は `env/.npm-global/bin/cowsay` に入った。
- **向け直さない npm は home に書く。** prefix だけ問う `npm prefix -g` でも、npm は `~/.npm/_logs` に debug log を書いた。cache を向け直さない限り、npm は `~/.npm` を使う。
- **`cargo install` は `CARGO_HOME` で向け直す。** 既定は `$HOME/.cargo/` で、`cargo install` の binary は `$CARGO_HOME/bin` に入る（[The Cargo Book](https://doc.rust-lang.org/cargo/guide/cargo-home.html)）。
- **Study ごとの profile も作れる。** `nix profile add --profile env/profile nixpkgs#gum nixpkgs#ripgrep` は、ユーザーの `~/.nix-profile` に触らずに `env/profile/bin` へ入れた（1 秒）。agent が flake を書き換えずに道具を足す道になる。

### 消し方と残るもの

- `nix develop --profile` と `nix profile add --profile` は、`/nix/var/nix/gcroots/auto/` に Study の dir の profile を指す symlink を作った。これが GC root になり、Study の dir があるうちは store の path が回収されない。
- GC root は「`gcroots` の下の store path を指す symlink」と、「store の外の path を経由して store path を指す symlink」の 2 種類（[GC roots の manual](https://nix.dev/manual/nix/latest/package-management/garbage-collector-roots)）。
- Study の dir を `rm -rf` すると、`nix-store --gc --print-dead` で `nix-shell-env`・`ripgrep`・`gum`・`apple-sdk` などの path が「消せる」側に移った。外れた auto の root は、次に root を走査したとき nix が消した。他の root から使われている path（この手元では `nodejs-22.23.4`）は残る。
- 消すコマンドは 2 つ。`nix store gc` は store 全体で「どの root からも届かない path」を消す（手元の `nix store gc --help`）。`nix store delete <path>` は、root から届かない場合に限って指定した path だけを消す（手元の `nix store delete --help`）。`nix store gc` を Job（定期処理）で回すと、Study と関係のないユーザーのごみも消える。
- 残るもの: `~/.cache/nix`（評価と取得の cache。この手元では 106 MB）と、他の root が使う store の path。

### agent と人が入る方法

- **agent**: `CLAUDE_ENV_FILE` は「各 Bash コマンドの前に同じ shell process で中身を走らせる shell script」を指す変数で、export がコマンドに見える（[Claude Code の環境変数](https://code.claude.com/docs/en/env-vars)）。SDK の `env` option で Claude Code の process に渡せる（`sdk.d.ts`）。`nix print-dev-env` の出力を file に保存すると 75 KB で、読み込みは 0.05 秒だった。
- **人**: Tab で `nix develop env/.dev-profile` を起こすと 0.15 秒で入れた。direnv の stdlib の `use_flake` は `nix print-dev-env --profile "$(direnv_layout_dir)/flake-profile"` を呼ぶので、`.envrc` に `use flake` と書けば、`cd` で入り、`.direnv/` の profile が GC root になる（手元の `direnv stdlib`）。nix-direnv は cache を足して速くする版で、`.envrc` から `source_url` で読み込める（[nix-direnv](https://github.com/nix-community/nix-direnv)）。この手元に nix-direnv は無い。

### 容量と時間

- Study の dir: 5 MB（ほぼ npm の cache）。
- `mkShell` の devShell の閉包は 1.4 GiB で、大きい順に `llvm-21.1.8-lib`（約 400 MB）、`apple-sdk-14.4`（約 340 MB）、`clang-21.1.8-lib`（約 300 MB）。`mkShell` が C の compiler を持つ stdenv を引くため。同じ nixpkgs を使う Study 同士は store を共有するので、2 つ目からは増えない。compiler の要らない Study は `mkShellNoCC` で避けられる（[nixpkgs の manual](https://nixos.org/manual/nixpkgs/stable/#sec-pkgs-mkShell)）。ただし native の module を build する npm の package は入らなくなる。
- 時間: 初めての `nix develop` が 11 秒（nixpkgs の取得と評価、1.7 MiB の取得）。flake が同じなら 2 回目から 0.7〜1 秒。store に無い `gum`（4.3 MiB）を `nix shell` で入れるのに 2 秒。時間はほぼ取得する量で決まる。

## docker（Docker Desktop）

### 何をするか

- Docker Desktop は Mac の上に Linux の VM を起こし、container はその中で動く。VM を作る仕組みは Apple Virtualization framework か Docker VMM（Beta）から選ぶ。VM の memory の既定は host の 50%（[Docker Desktop の設定](https://docs.docker.com/desktop/settings-and-maintenance/settings/)）。
- 手で確かめた: container の中は `Linux aarch64` だった。macOS の binary は動かない。

### 隔離できる範囲

- **file**: host と共有するのは bind mount だけ。既定で共有できるのは `/Users`・`/Volumes`・`/private`・`/tmp`・`/var/folders` の下で、file の共有は VirtioFS が既定（[Docker Desktop の設定](https://docs.docker.com/desktop/settings-and-maintenance/settings/)）。`~/.monica/studies/<Study>/env` は `/Users` の下なので、そのまま mount できる。手で確かめた: container の中の root が bind mount に書いた file は、host では自分の user の file になった。
- **global な install**: 手で確かめた: prefix を向け直さない `npm i -g` は、container の層の `/usr/local/bin/cowsay` に入った（`docker diff` で見えた）。container を消せば一緒に消える。
- **network**: 手で確かめた: container の中の `npm install` は registry に届いた。既定では外への通信を絞らない。container から host の service へは `host.docker.internal` で届く。host から container の IP へは届かず、`-p` で port を publish する（[Docker Desktop の networking](https://docs.docker.com/desktop/features/networking/networking-how-tos/)）。publish した port は既定で全 interface（`0.0.0.0`）で待ち受ける（[networking](https://docs.docker.com/desktop/features/networking/)）。

### 消し方と残るもの

- `docker rm -f <container>` で container と、その層に入れたものが消える。bind mount した Study の dir は別に消す。
- image は Study 間で共有し、`docker image rm` か prune まで残る。image と container は Docker Desktop の VM の disk image に入っている。

### agent と人が入る方法

- **agent**: SDK の `spawnClaudeCodeProcess` は「VM や container や remote で Claude Code を起こす」ための option で、Claude Code の process ごと container の中で動かせる。その場合 `options.cwd` は container の中にある dir にする（`sdk.d.ts`）。別の道として、`toolAliases` に `{ Bash: 'mcp__workspace__bash' }` のように書けば、model が出した Bash の呼び出しを、remote の sandbox で Bash を走らせる MCP の tool へ向け直せる（`sdk.d.ts` の例）。
- **人**: Tab で `docker exec -it <container> bash` を起こす。container が止まっていれば `docker start` が要り、Docker Desktop が起きている必要がある。
- Claude Code の sandbox は docker と組み合わせられない（「`docker` is incompatible with the sandbox」、[sandboxing](https://code.claude.com/docs/en/sandboxing)）。docker のコマンドは `excludedCommands` で sandbox の外に出す。

### 試せるもの

- Linux の CLI とライブラリ、常駐する service（`-p`、compose）は自然に試せる。
- macOS でしか動かないもの（brew で配るツール、Swift や AppKit を使うもの、macOS の app）は試せない。
- GUI について Docker の文書は何も書いていない。Linux の GUI を Mac の画面に出すには、X の server か VNC を別に用意する必要があると見ている（確かめていない）。

### 容量と時間（手で確かめた）

- image が手元にあれば、`docker run --rm alpine true` の 5 回が合わせて約 1 秒。Study 用に `docker run -d ... sleep infinity` で常駐させる container の作成と起動も約 1 秒。
- `node:22-bookworm-slim` は disk 上 349 MB（Study 間で共有）。`npm i -g cowsay` の後の container の層は 5.44 MB。
- image の取得にかかる時間は測っていない（使った image は手元にあった）。

## Seatbelt（Agent SDK の `sandbox`・`@anthropic-ai/sandbox-runtime`）

### 何をするか

- Claude Code の Bash の sandbox は、macOS では OS の Seatbelt で囲う。既定では切ってある。Bash・PowerShell・Monitor のコマンドと、それが起こす子の process にも掛かる（[sandboxing](https://code.claude.com/docs/en/sandboxing)）。
- 中身は open source の `@anthropic-ai/sandbox-runtime`（`srt`）。macOS では `sandbox-exec` に、その場で作った Seatbelt の profile を渡す。単体の CLI（`srt <command>`、設定は `~/.srt-settings.json` か `--settings`）としても、library（`SandboxManager.wrapWithSandbox`）としても使える。Beta の research preview（[sandbox-runtime](https://github.com/anthropics/sandbox-runtime)、最新は v0.0.81）。
- 手元の `man sandbox-exec` は、`sandbox-exec` 自体を `(DEPRECATED)` としている。
- SDK 0.3.293 の `Options.sandbox` は `enabled`・`failIfUnavailable`・`autoAllowBashIfSandboxed`・`allowUnsandboxedCommands`・`filesystem`（`allowWrite`・`denyWrite`・`denyRead`・`allowRead`）・`network`（`allowedDomains`・`allowLocalBinding` など）・`credentials`・`excludedCommands` などを持つ。option で `enabled: true` を渡すと、sandbox を起こせないとき `query()` は sandbox 無しで走らずに error で終わる（`sdk.d.ts`）。

### 既定で囲うもの（[sandboxing](https://code.claude.com/docs/en/sandboxing)）

- **書き込み**: cwd とその下、`additionalDirectories` で足した dir、`$TMPDIR` が指す user ごとの temp だけ。Claude Code は sandbox のコマンドの `$TMPDIR` をこの dir にする。`.claude` の設定、shell の rc、`.gitconfig`、`.git/hooks` などは、書ける dir の中でも書けない。
- **読み込み**: 拒んだ dir を除くマシン全体。`~/.ssh` や `~/.aws/credentials` も既定では読める。
- **network**: 直接は外へ出られない。host で動く proxy が、許した domain だけを通す。許す domain は最初は空。proxy を使わない `ssh` や多くの DB の driver はつながらない。UDP・QUIC・`ping` は出られない。
- **localhost**: macOS では `network.allowLocalBinding` を有効にすると port で待ち受けられるが、localhost の全 port に届くようになる。

### 手で確かめたこと

`sandbox-exec -p` に「`$HOME` への書き込みを拒み、Study の dir だけ許す」最小の profile を渡して試した（`srt` が作る profile とは違い、書き込みだけを囲う）。

- `touch ~/...` は `Operation not permitted` で止まり、file はできなかった。
- prefix を向け直さない `npm i -g` は、home の mise の prefix に書けず `EPERM` で止まった。拒むだけで、よそへ向け直しはしない。
- `NPM_CONFIG_PREFIX` と `npm_config_cache` を Study の dir に向けると入った（1 秒）。ただし mise の npm の wrapper が install の後に `mise reshim` を走らせ、`~/Library/Caches/mise` への書き込みで警告を出した。mise の dir には何も残らなかった。

### 囲わないもの・合わないもの（[sandboxing](https://code.claude.com/docs/en/sandboxing)）

- Read・Edit・Write・WebFetch などの組み込みの tool は sandbox ではなく permission の規則に従う。hook と MCP の server も sandbox の外で動く。
- 合わないもの: `docker`、`watchman`、`gh` などの Go の CLI（TLS の検証）、SSH の remote への git。`open`・`osascript` は Apple Events が拒まれて動かない。`allowAppleEvents` で許すと、起こした app は sandbox の外で動く。
- **人の Tab には掛からない。** Tab の shell を同じ規則で囲うには `srt` で shell を包む。pty を自分で確保するコマンドには、macOS では `allowPty` が要る（[sandbox-runtime](https://github.com/anthropics/sandbox-runtime)）。`srt` で包んだ対話の shell は試していない。
- SDK から使うとき、新しい domain への通信を誰に問うかは確かめていない。

### 消し方・容量・時間

規則を当てるだけで、状態を持たない。準備の時間も容量も要らない。道具を揃えないので、nix や mise や host の道具と組み合わせて使う。

## mise

- 各 dir の `mise.toml` が、その dir で使う道具と版を決める（[mise の設定](https://mise.jdx.dev/configuration.html)）。
- install は user ごとの 1 か所に版ごとに入る（`~/.local/share/mise/installs/<tool>/<version>`）。`MISE_DATA_DIR` などで場所を変えられるが、mise は `mise.toml` を読む前に dir を決めるので、`[env]` ではなく mise を起こす環境で渡す（[mise の dir](https://mise.jdx.dev/directories.html)）。
- `npm install -g` は、`.npmrc` で prefix を変えない限り、使っている Node.js の版に入る。macOS では mise が各版の `bin/npm` を wrapper に置き換え、global な install の後に `mise reshim` を走らせる（[mise の Node.js](https://mise.jdx.dev/lang/node.html)）。手で確かめた: この手元の `npm prefix -g` は `~/.local/share/mise/installs/node/22.23.4` で、同じ版を使う全 project で共有している。
- 隔離するのは「どの版を使うか」だけで、file・global な install・network は囲わない。
- Study ごとの install にするには `MISE_DATA_DIR` を Study の dir に向けることになり、版を Study 間で共有できなくなる（推測、試していない）。

## 調べなかった候補

- **Apple の `container`**: Linux の container を軽い VM で動かす。Apple Silicon と macOS 26 が要り、OCI の image を使う（[apple/container](https://github.com/apple/container)）。手元に入っていない。Linux の中で動く点の得失は docker と同じと見ている。
- **macOS の VM**（tart など）: brew や macOS の GUI まで隔離できる唯一の道だが、重いので調べていない。
- **devbox・flox**: nix を包む道具。調べていない。

## Study に当てはめたときの論点

決めるのは後のチケット。ここでは事実から読める分かれ道だけを並べる。

- **「汚さない」の意味**: (a) 消した後に何も残らない、(b) そもそも外に書かせない、のどちらか。(a) は nix の GC と `docker rm` で満たせる。(b) を満たすのは Seatbelt と docker だけ。
- **macOS で動くものを試すか**: `repository` の Tutor（先生）の学習対象が brew で配る macOS のツールや GUI なら、docker では試せない。nix は macOS の binary を動かすが囲わない。
- **向け直す変数の一覧**: nix か mise を使うなら、`NPM_CONFIG_PREFIX`・`npm_config_cache`・`CARGO_HOME` などを Study ごとに向け直す一覧を持つことになる。一覧に無いツールが `~/.config` に書くのは止まらない。止めるには Seatbelt を重ねる。`HOME` ごと向け直すと、git の設定や `gh` の認証まで見えなくなる。
- **agent と人の入り口を揃える**: nix は `CLAUDE_ENV_FILE` と Tab の起動コマンドで、docker は `docker exec` で揃う。Seatbelt を人の Tab にも掛けるなら `srt` が要る。
- **3 ヶ月の自動削除**: どの道具も「最後に使った時」を持たないので、monica が Study ごとに記録することになる。nix で `nix store gc` を Job で回すと、Study と関係のないごみも消える。Study の path だけを消すなら `nix store delete`。docker は container と、どの Study も使わなくなった image を消す。

## 手元に残したもの

- **nix の store**: 試しに取得した path（`gum-2.0.2`、`bash-interactive-5.3p20`、`readline-8.3p3` と、devShell の `nix-shell-env` などの derivation）。どれも GC root が無く、次の `nix store gc` で回収される。試した Study の dir は消し、外れた auto の root も nix が消した。
- **`~/.cache/nix`**: nixpkgs の評価と取得の cache が増えた。
- **`~/.npm/_logs`**: `npm prefix -g` が書いた debug log が 1 つ。npm は 10 個を超えると古い log から消す。
- **docker**: image は取得していない（手元の `alpine:latest` と `node:22-bookworm-slim` を使った）。試した container は `docker rm -f` で消した。
