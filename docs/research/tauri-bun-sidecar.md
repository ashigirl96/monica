# Tauri 2 で Bun 製 sidecar を起動・終了・接続する

Issue #4 の調査結果。ADR-0001 の「desktop は Bun でコンパイルした backend を sidecar として起動し HTTP/oRPC で呼ぶ」が Tauri 2 で成立するかを、Tauri / Bun / WebKit の一次資料と旧 Monica の実装、scratchpad での計測で確認した。

確認時の版: Tauri crate 2.12.1（2026-09-30、crates.io の最新 stable）、旧 Monica は tauri 2.11.6 / tauri-build 2.6.3 / wry 0.55.1 / tauri-cli 2.10.0、Bun 1.3.13、host `aarch64-apple-darwin`。

## 結論

| 問い | 答え |
|---|---|
| `bun build --compile` のバイナリを externalBin で同梱する手順と命名規約 | **Yes**。`bundle.externalBin` に `binaries/monica-backend` と書き、ファイルは `monica-backend-<Rust target triple>`（Windows は `.exe` 付き）で置く。Bun の `--target` 名と Rust triple は対応表で読み替える。dev では `target/debug/`、build では `Contents/MacOS/` に triple を剥がした名前でコピーされる |
| shell plugin / Command API での起動、app 終了時の kill、crash 時の再起動 | **部分的に成立**。起動は Rust の `app.shell().sidecar("monica-backend")` か旧 Monica 同様の `std::process::Command`。JS から `spawn()` した子は shell plugin が `RunEvent::Exit` で自動 kill するが、Rust から spawn した子は自前で `RunEvent::Exit` に kill を書く。`kill()` は SIGKILL なので graceful shutdown は別経路が要る。`RunEvent::Exit` は SIGKILL / crash では踏まれず孤児が残る。crash 再起動は Tauri に機能が無く、`CommandEvent::Terminated` を見て respawn する |
| port と `MONICA_HOME` の受け渡し | **Yes**。引数は `.args()`、env は `.env()` / `.envs()`（JS は `SpawnOptions.env`）。port は Bun 側で `port: 0` で bind して `server.port` を stdout に 1 行で出し、Rust 側は `CommandEvent::Stdout`（既定で行単位）で読む。計測でも `{"port":64829}` が取れた |
| dev では compile せず `bun run` で起動する切り替え | **Yes、Rust 側で分岐する**。`cfg!(debug_assertions)` か env 上書き（旧 Monica の `MONICA_PTYD_PATH` 方式）。ただし externalBin のファイルは dev でもコンパイル時に存在必須（無いと tauri-build が失敗）。compile は 69 ms なので `beforeDevCommand` で毎回作ってよい。JS 側で切り替えると capability に `cmd: "bun"` を常駐させることになるので避ける |
| webview から localhost HTTP を叩く CSP と capabilities | **Yes**。capabilities は Tauri command / plugin の許可であり、fetch は対象外。`csp` を `null` にすれば制限なし（旧 Monica と同じ）。CSP を書くなら `connect-src` に `ipc: http://ipc.localhost` と `http://127.0.0.1:*` `ws://127.0.0.1:*` を足す。CORS は sidecar 側で `tauri://localhost`（macOS/Linux 配布）、`http://tauri.localhost`（Windows）、`http://localhost:1420`（dev）を許可する |
| WKWebView（macOS）での fetch / SSE / WebSocket | **Yes、条件付き**。macOS の page origin は `tauri://localhost` で https ではないため、WebKit の mixed content 判定の対象外になり `http://` `ws://` の 127.0.0.1 に届く。EventSource / WebSocket は標準 API で使える。Bun 側は `hostname: "127.0.0.1"` と、SSE には `server.timeout(req, 0)` が要る（既定 10 秒で切れる）。https origin にすると WebKit は localhost を遮断する（2017 年から未解決）。旧 Monica の webview は localhost を直接 fetch していないので、in-house の実証は無い |
| sidecar バイナリのサイズ | **約 60 MB / target**。hello world の `Bun.serve` が 63,072,928 bytes（arm64）、x64 cross は 68,272,640 bytes。`--minify --bytecode` でも変わらない。旧 Monica の monica-ptyd（Rust、release）は 638,816 bytes |

## 根拠

### externalBin の命名と配置

- 命名規約は "binary-name{-target-triple}{.system-extension}"。例として `my-binary-x86_64-pc-windows-msvc.exe` / `my-binary-x86_64-apple-darwin` / `my-binary-x86_64-unknown-linux-gnu`。https://v2.tauri.app/reference/config/#externalbin
- host triple は `rustc --print host-tuple`。JS からは `Command.sidecar('binaries/my-sidecar')`（externalBin に書いたパス）、Rust からは `app.shell().sidecar("my-sidecar")`（ファイル名だけ）。https://v2.tauri.app/develop/sidecar/
- tauri-build は `TARGET` env の triple で `copy_binaries()` を呼び、ファイル名から `-{target_triple}` を `replace` で消して `OUT_DIR` から逆算した target ディレクトリへコピーする。ファイルが無いと `"{:?} does not exist"` で build が失敗する。https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-build/src/lib.rs
- bundler も `Settings::copy_binaries()` で同じ `replace` を行い、macOS では `bundle_directory.join("MacOS")` に置いて署名対象（`is_an_executable: true`）に加える。https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/settings.rs / https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/app.rs
- shell plugin の sidecar 解決は `relative_command_path()`。current exe のディレクトリ基準で、Windows は `.exe` を付け Unix は外す。https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs
- Bun の `--target` は `bun-darwin-arm64` / `bun-darwin-x64` / `bun-linux-x64` / `bun-linux-arm64` / `bun-linux-{x64,arm64}-musl` / `bun-windows-{x64,arm64}`。cross compile 時は target の runtime を自動 download する。https://bun.sh/docs/bundler/executables
- 対応表（Rust 側は Tauri の `TAURI_ENV_TARGET_TRIPLE` と一致させる）: `bun-darwin-arm64` → `aarch64-apple-darwin`、`bun-darwin-x64` → `x86_64-apple-darwin`、`bun-linux-x64` → `x86_64-unknown-linux-gnu`、`bun-linux-arm64` → `aarch64-unknown-linux-gnu`、`bun-windows-x64` → `x86_64-pc-windows-msvc`（`.exe`）。
- `beforeDevCommand` / `beforeBuildCommand` には `TAURI_ENV_PLATFORM` `TAURI_ENV_ARCH` `TAURI_ENV_TARGET_TRIPLE` が渡り、`TAURI_ENV_DEBUG` は debug build だけ `true`。https://docs.rs/tauri-utils/latest/tauri_utils/config/struct.BuildConfig.html

build 手順は 1 行で足りる。

```bash
bun build --compile --minify --target=bun-darwin-arm64 src/main.ts \
  --outfile src-tauri/binaries/monica-backend-aarch64-apple-darwin
```

### 起動・終了・再起動

- Rust API: `Command` に `arg` `args` `env` `envs` `env_clear` `current_dir` `set_raw_out`。`spawn()` は stdin/stdout/stderr を pipe にして `(Receiver<CommandEvent>, CommandChild)` を返す。`CommandEvent` は `Stdout(Vec<u8>)` `Stderr` `Error` `Terminated`。stdout は既定で `read_until(b'\n')` の行単位。`CommandChild` に `Drop` は無い。https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs
- JS API: `Command.sidecar(program, args?, options?)`、`SpawnOptions { cwd, env, encoding }`、`Child.kill()` `Child.write()`。https://v2.tauri.app/reference/javascript/shell/
- shell plugin の `init()` は `on_event` で `RunEvent::Exit` を受けると `shell.children` の全員を `kill()` する。`shell.children` に入れるのは JS の `spawn` command だけで、Rust の `app.shell().sidecar().spawn()` は登録されない。https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/lib.rs / https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/commands.rs
- `CommandChild::kill` は `SharedChild::kill`。"On Unix this sends SIGKILL, and you should call wait afterwards to avoid leaving a zombie". https://docs.rs/shared_child/latest/shared_child/struct.SharedChild.html
- `std::process::Child` は "There is no implementation of Drop for child processes" なので、ハンドルを捨てても子は生き続ける。https://doc.rust-lang.org/std/process/struct.Child.html
- `RunEvent::Exit` は "Event loop is exiting"、`ExitRequested` は "The app is about to exit"。https://docs.rs/tauri/latest/tauri/enum.RunEvent.html
- Node 互換の `process.on('SIGTERM')` で graceful shutdown でき、`process.ppid` で親 pid が読める。Bun の `node:process` は "Mostly implemented"。https://nodejs.org/api/process.html / https://bun.sh/docs/runtime/nodejs-apis

### port と env

- `Bun.serve({ port: 0 })` は "To randomly select an available port, set port to 0"、選ばれた port は `server.port`。`hostname` の既定は `0.0.0.0`。`idleTimeout` の既定は 10 秒で、streaming 中にも効くので `server.timeout(req, 0)` で外す。`websocket` handler と `server.upgrade(req)` で WebSocket。https://bun.sh/docs/api/http
- JS の `spawn` command は `options.env` を `.envs()` で適用する。https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/commands.rs
- scratchpad の `hello.ts`（`Bun.serve({ port: 0 })` して `JSON.stringify({ port })` を出力）は起動直後に `{"port":64829}` を stdout に出した。

### capabilities と CSP

- capability は "which permissions are granted or denied for specific windows or webviews" を決めるもので、対象は Tauri command / plugin。https://v2.tauri.app/security/capabilities/
- sidecar を JS から呼ぶ scope は `{ "identifier": "shell:allow-spawn", "allow": [{ "name": "binaries/monica-backend", "sidecar": true, "args": true }] }`。`args: true` は "will allow any arguments"、list 形式では `validator` 正規表現。kill には `shell:allow-kill`。https://v2.tauri.app/develop/sidecar/ / https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/build.rs
- `csp` は "The Content Security Policy that will be injected on all HTML files on the built application. If devCsp is not specified, this value is also injected on dev"。null 許容。"The CSP protection is only enabled if set on the Tauri configuration file"。例は `"connect-src": "ipc: http://ipc.localhost"`。https://docs.rs/tauri-utils/latest/tauri_utils/config/struct.SecurityConfig.html / https://v2.tauri.app/security/csp/
- `useHttpsScheme` の doc: "Using a https scheme will NOT allow mixed content when trying to fetch http endpoints and therefore will not match the behavior of the `<scheme>://localhost` protocols used on macOS and Linux"。既定 `false`。Windows/Android だけに効く。https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-utils/src/config.rs
- oRPC の CORS は `@orpc/server/plugins` の `CORSHandlerPlugin({ origin: [...] })`。https://orpc.dev/docs/plugins/cors
- 配布 origin を CORS allowlist に入れ忘れる事故は community でも繰り返されている（macOS/Linux `tauri://localhost`、Windows `http://tauri.localhost`）。https://github.com/Tombomeke-Studios/NexusNotes/issues/245

### WKWebView の挙動

- WebKit の `MixedContentChecker` は document origin の `protocol() == "https"` のときだけ mixed content を判定する。`tauri://` はこの条件に当たらない。https://github.com/WebKit/WebKit/blob/main/Source/WebCore/loader/MixedContentChecker.cpp
- wry は macOS で `setURLSchemeHandler_forURLScheme` を使うだけで、scheme を secure 登録していない。https://github.com/tauri-apps/wry/blob/dev/src/wkwebview/mod.rs
- https origin から loopback へのアクセスは WebKit bug 171934 で 2017 年から未解決（REOPENED）。Tauri 側は upstream 扱い。https://bugs.webkit.org/show_bug.cgi?id=171934 / https://github.com/tauri-apps/tauri/issues/5451
- ATS は "connections made to: Internet protocol (IP) addresses, Unqualified host names, Local hosts employing the .local TLD" には適用されない。一方で同じ節が "To connect to an unqualified host name ... you must set the value of the NSAllowsLocalNetworking key to YES" とも書くので、URL は `localhost` ではなく `127.0.0.1` で組む。https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CocoaKeys.html
- sidecar の SSE を `EventSource` で受けた報告（Tauri discussion）。https://github.com/orgs/tauri-apps/discussions/14552
- https origin の page からは `ws://` が "An insecure WebSocket connection may not be initiated from a page loaded over HTTPS" で遮断される。`tauri://localhost` では起きない。https://github.com/tauri-apps/tauri/issues/7701

### サイズ

- Bun docs 自身が "Bun's binary is still way too big and we need to make it smaller" と書く。https://bun.sh/docs/bundler/executables
- 計測（Bun 1.3.13、scratchpad）: `bun build --compile hello.ts` 63,072,928 bytes、`--minify --bytecode` 63,072,928 bytes、`--target=bun-darwin-x64` 68,272,640 bytes。compile は 69 ms。
- 旧 Monica の externalBin: `monica-ptyd` release 638,816 bytes、debug 4,116,576 bytes、`monica-browser-bridge` debug 14,892,504 bytes（`crates/monica-desktop/binaries/`）。

## 旧 Monica で既に実証済みの部分

- externalBin の命名と beforeBuildCommand: `cp target/release/monica-ptyd "crates/monica-desktop/binaries/monica-ptyd-$(rustc -vV | sed -n 's/host: //p')"`。`crates/monica-desktop/tauri.conf.json` L8、`externalBin` L56。
- dev でもファイルが必要なので justfile `ptyd-bin` recipe が debug バイナリを同名で置く。コメントに "tauri.conf.json's externalBin makes every monica-desktop compile (dev, clippy, tests) require binaries/monica-ptyd-<host-triple>"。`justfile` L55-60。
- shell plugin を使わず `std::process::Command` で spawn し、パスは env 上書き → `current_exe().parent()/<name>` → PATH の順で解決（`src/ptyd.rs` `ptyd_binary()`、`src/bridge.rs` `bridge_binary()`）。dev は `MONICA_PTYD_PATH=target/debug/monica-ptyd` で差し替える（`justfile` L46）。monica で `bun run` に切り替えるのも同じ場所でよい。
- 引数で home を渡す: `.arg("--monica-home").arg(&base)`（`ptyd.rs` L318、`bridge.rs` L53）。monica の `MONICA_HOME` も同じ形か `.env()` で渡せる。
- app 同寿命の子を `RunEvent::Exit` で kill: `src/lib.rs` L218-225 と `bridge.rs` `stop()`。
- `RunEvent::Exit` を踏めない終了（SIGKILL / crash / SIGINT）への対策: pid file を書き、次回起動時に `ps -o comm=` で同名を確認してから SIGTERM（`bridge.rs` `kill_stale_bridge()`）。`lib.rs` L235 のコメントが SIGINT/SIGTERM で `Exit` が来ないことを記録している。
- 即死検知: spawn 後 500 ms に `try_wait()` して port 衝突などを warn（`bridge.rs` `watch_early_exit()`）。自動 respawn は無い。
- `csp: null`、capabilities は `core:default` と plugin の default だけ（`capabilities/default.json`）。
- 実証されていないもの: webview から localhost HTTP への fetch（旧 Monica の web server は vite proxy と terminal env `MONICA_WEB_URL` 経由で、webview は直接叩かない）、Bun バイナリの署名と notarization。

## 制約と注意

- `hardenedRuntime` の既定は `true` で "required for notarization"。bundler は externalBin も同じ `entitlements` で署名する（`sign.rs` が `entitlements_path` と `is_an_executable && hardened_runtime` を渡す）。Bun は JIT を使うので、`bundle.macOS.entitlements` に `com.apple.security.cs.allow-jit` などを入れる必要がある。https://v2.tauri.app/reference/config/#hardenedruntime / https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/sign.rs / https://bun.sh/docs/bundler/executables
- `kill()` は SIGKILL。graceful に落とすなら `libc::kill(pid, SIGTERM)` か HTTP の shutdown endpoint を別に用意し、Bun 側で `process.on('SIGTERM')` を受ける。
- `Bun.serve` の `hostname` 既定は `0.0.0.0`。必ず `127.0.0.1` を指定する。
- `idleTimeout` 既定 10 秒は SSE を切る。`server.timeout(req, 0)`。
- 配布 origin が OS で違う（`tauri://localhost` / `http://tauri.localhost`）ので CORS の allowlist は 3 つ持つ。`credentials: true` にすると wildcard が使えない。
- Windows は `useHttpsScheme: false` のまま。`.exe` を付けた triple 名で置く。Bun の Windows metadata（icon 以外）は cross compile では付けられない。
- target ごとに 60 MB 超が増える。`--target` ごとに runtime を download するので CI の cache を考える。
- Bun の `--compile` は worker を明示 entrypoint にする必要があり、`--outdir` `--target=node` は使えない。

## 未確認

- Bun 1.3.13 で `process.ppid` と `process.stdin` の EOF 検知（親死亡時の自殺）が動くか。Bun の docs は `node:process` を "Mostly implemented" としか書いていない。
- Bun バイナリに Tauri の entitlements を付けて notarization が通るか。
- WKWebView が `tauri://localhost` から WebSocket を開くときの `Origin` ヘッダの値（community 報告のみ）。
- Tauri PR #14443（process tree kill / `cleanup_before_exit`）が 2.12.x に入ったか。2.12.0 の changelog に sidecar 関連の項目は無い。https://github.com/tauri-apps/tauri/pull/14443
- 旧 Monica の tauri 2.11.6 と最新 2.12.1 の差分が sidecar に影響するか。
