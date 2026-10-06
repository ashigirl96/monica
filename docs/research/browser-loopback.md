# ブラウザから loopback の Backend を使う

wayfinder の map「monica の notes を tania に移す」のチケット「ブラウザに notes を配る形」で調べた事実。決定は ADR-0017 にある。

確かめた環境: macOS 26.6.2、Bun 1.4.2、Brave 1.96.61（Chromium 154。agent-browser の headless で新規 profile）、oRPC 1.15.4、hono 4.13.12。【実機】と書いたものは、この環境で scratchpad の server を立てて確かめた。

## 要点

| 問い | 答え |
|---|---|
| `*.localhost` は解決されるか | Chromium（Brave を含む）は DNS を使わず `[::1, 127.0.0.1]` の順で返す。macOS 26 の system resolver も `::1`・`127.0.0.1` を返す。Safari は macOS 26 で OS 側の変更により解決できるようになった |
| secure context か | `http://*.localhost`・`localhost`・`127.0.0.1` はどれも potentially trustworthy。【実機】Brave で `isSecureContext === true` |
| cookie と localStorage の分かれ方 | cookie は host ごとで、port では分かれない。localStorage は port を含む origin ごと |
| 外部の site から loopback に届くか | Brave の Local Network Access は fetch と iframe を止める。【実機】top-level の form POST は届いた |
| oRPC は単純リクエストを実行するか | 1.15.4 は `text/plain`・urlencoded・multipart の POST を実行する。multipart なら input を指定できる |
| `Sec-Fetch-Site` は付くか | loopback と `*.localhost` 宛てなら、Chromium 76 以降・Safari 16.4 以降が付ける |
| 同じ host:port に何本繋げるか | Chromium は HTTP/1.1 で 6 本まで。ブラウザは h2c を使わない |
| SPA を compiled binary に入れる | `--asset <dir>` で `/$bunfs/root/<basename>/` に置かれ、`Bun.file()` で配れる |

## 名前解決と secure context

- RFC 6761 §6.3 は、localhost 名を名前解決の API が loopback として返すことを SHOULD としている。https://www.rfc-editor.org/rfc/rfc6761#section-6.3
- Chromium の `IsLocalHostname` は `localhost` と `*.localhost` を真にし、`ResolveLocalHostname` は DNS を使わずに `[::1, 127.0.0.1]` をこの順で返す。https://chromium.googlesource.com/chromium/src/+/main/net/base/url_util.cc ／ https://chromium.googlesource.com/chromium/src/+/main/net/dns/host_resolver_manager.cc
- W3C Secure Contexts は、`.localhost` で終わる host を potentially trustworthy とする（「Is origin potentially trustworthy?」の step 5）。https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy
- Safari は名前解決を OS に任せている。macOS 15.7 では解決できず、macOS 26 で直った（WebKit bug 160504 は RESOLVED MOVED。2025-09-19 のコメント）。https://bugs.webkit.org/show_bug.cgi?id=160504 。Safari の画面での動作は確かめていない。
- 【実機】macOS 26.6.2 の `dscacheutil`・`dns-sd -G`・`getaddrinfo('tania.localhost')` は、どれも `::1` を先に、`127.0.0.1` を後に返した。
- curl は 7.85.0 から OS に頼らず `*.localhost` を loopback に解決する。https://curl.se/ch/7.85.0.html

## cookie と localStorage

- RFC 6265 §8.5「Cookies do not provide isolation by port.」。Domain 属性が無ければ host-only になる。https://www.rfc-editor.org/rfc/rfc6265#section-8.5
- localStorage は storage key（origin）ごとに分かれ、origin には port が入る。https://storage.spec.whatwg.org/#storage-keys
- 【実機 Brave】`tania.localhost:47821` で書いた値を別の URL から読んだ結果。

  | 読んだ側 | cookie | localStorage |
  | --- | --- | --- |
  | `tania.localhost:47822`（port だけ違う） | 見える | 見えない |
  | `localhost:47821` | 見えない | 見えない |
  | `127.0.0.1:47821` | 見えない | 見えない |
  | `other.localhost:47821` | 見えない | 見えない |

## 外部の site から loopback への request

- Chromium の Local Network Access（LNA）は、public → loopback、public → local、local → loopback の request を許可制にする。loopback から出る request は対象外。prompt の launch は Chrome 142。https://developer.chrome.com/blog/local-network-access ／ https://github.com/WICG/local-network-access/blob/main/explainer.md
  - mode を問わず、fetch・subresource・iframe の navigation が対象になる。top-level の navigation は対象外（仕様に「Chromium only applies LNA restrictions to iframe navigations currently」）。https://wicg.github.io/local-network-access/
  - Chrome 145 で許可が `local-network` と `loopback-network` に分かれた。Chrome 156 で opt-out の policy が消える。
- Brave は 1.88.x で Chromium の LNA に乗り換えた（brave-browser #51843）。prompt が出ないという未解決の報告がある（#54898、#53727）。
- 【実機 Brave 1.96.61 headless】`https://example.com` から試した結果。

  | 送り方 | 結果 |
  | --- | --- |
  | `127.0.0.1` へ no-cors の text/plain POST を fetch | 届かなかった（`loopback-network` は `denied`） |
  | iframe を target にした form POST | 届かなかった |
  | top-level の form POST（multipart） | 届いた。`Origin: null`、`Sec-Fetch-Site: cross-site`、`Sec-Fetch-Mode: navigate` |

## Origin と Fetch Metadata

- POST と `text/plain`・`multipart/form-data`・`application/x-www-form-urlencoded` は CORS-safelisted なので、preflight 無しで送れる。https://fetch.spec.whatwg.org/
- Fetch Metadata（`Sec-Fetch-*`）は potentially trustworthy な URL にしか付かない。`http://localhost`・`*.localhost`・`127.0.0.1` には付く。対応は Chrome 76、Firefox 90、Safari 16.4。https://w3c.github.io/webappsec-fetch-metadata/
- site は port を見ないので、`localhost:3000` から `localhost:19380` への request の `Sec-Fetch-Site` は `same-site` になる。
- 【実機 Brave】server が受け取った header。

  | 送り方 | Origin | Sec-Fetch-Site | Sec-Fetch-Mode |
  | --- | --- | --- | --- |
  | 同じ origin で POST（json） | `http://127.0.0.1:47811` | same-origin | cors |
  | 同じ origin で POST（no-cors、text/plain） | `http://127.0.0.1:47811` | same-origin | no-cors |
  | `http://tania.localhost:47812` から no-cors POST | `http://tania.localhost:47812` | cross-site | no-cors |
  | 同上から cors の json（preflight の OPTIONS が届いた） | `http://tania.localhost:47812` | cross-site | cors |
  | 同上から top-level の form POST | `http://tania.localhost:47812` | cross-site | navigate |

## oRPC 1.15.4

- 【実機】`RPCHandler`（fetch）は request の content-type ごとに body を読む（`@orpc/standard-server-fetch` の `toStandardBody`）。

  | content-type | 結果 |
  | --- | --- |
  | `text/plain` | 200。procedure が input=undefined で実行された |
  | urlencoded | 200。input=undefined で実行された |
  | multipart で `data={"json":...}` | 200。input を指定して実行できた |
  | GET | 既定の StrictGetMethodPlugin が 405 |

- `SimpleCsrfProtectionHandlerPlugin` は既定で header `x-csrf-token: orpc` の有無だけを見て、無ければ 403（`CSRF_TOKEN_MISMATCH`）を返す。client 側は `SimpleCsrfProtectionLinkPlugin` が付ける。v2 の beta では Sec-Fetch を見る方式に変わった（#1840、#1846）が、1.15.4 には無い。https://github.com/dinwwwh/orpc/blob/9e01c51d23/apps/content/docs/plugins/simple-csrf-protection.md
- event iterator の応答は `content-type: text/event-stream` で、client の RPCLink は EventSource ではなく fetch で読む。keepalive の comment は既定で 5 秒おき。

## 接続数の上限

- Chromium の socket pool は group ごとに 6 本で、group の鍵は scheme・host・port（と privacy mode、NetworkAnonymizationKey）。https://chromium.googlesource.com/chromium/src/+/main/net/socket/client_socket_pool_manager.cc
- 【実機 Brave】1 つのタブで EventSource を 8 本開くと server に届いたのは 6 本で、同じ host:port を別のタブで開くと navigation が止まった。3 本閉じると進んだ。host が違えば別の group になる。
- ブラウザは平文の HTTP/2（h2c）を使わない。https://http2.github.io/faq/ 。Bun 1.4.1 以降の `Bun.serve({ http2: true })` は、TLS 無しでは prior knowledge の接続だけを HTTP/2 にする。

## Bun

- `--asset <path>` は 1.4.0 から（PR #36302）。`--compile` が必須で、ファイルは `/$bunfs/root/<basename>/<相対パス>` に hash 無しで置かれる。`readdirSync({ recursive })` が使え、`Bun.Glob` での走査は 1.4.1 から。【実機】Vite の出力を模した `dist/` を埋め込み、`Bun.file()` で返すと `text/html` と `text/javascript` で配れた。
- HTML import（fullstack）は 1.2.17 から `--compile` に埋め込める。【実機 1.4.2】`--bytecode --format=esm` でも動いた。ただし bunfig の `[serve.static] plugins`（Tailwind など）は「work in `Bun.build()`'s JS API, but not yet in the CLI」で、CLI の `bun build --compile` では効かなかった。https://bun.com/docs/bundler/fullstack
- `Bun.serve` は Windows 以外で listen socket に SO_REUSEADDR を必ず付ける。【実機】TIME_WAIT が残っていてもすぐ再 bind できた。https://github.com/oven-sh/bun/blob/bun-v1.4.2/packages/bun-usockets/src/bsd.c
- 【実機】port が使われていれば `Bun.serve` は同期的に throw し、try/catch で捕まえられる（`code=EADDRINUSE`、`syscall=listen`）。1 つの process で port の違う `Bun.serve` を同時に動かせる。
- 【実機】macOS では、他の app が `0.0.0.0:N` を listen していても `127.0.0.1:N` に bind できる。この衝突は EADDRINUSE にならない。

## Tauri の resources

- `bundle.resources` は macOS の `.app` の `Contents/Resources` に、externalBin は `Contents/MacOS` に置かれる。https://v2.tauri.app/develop/resources/
- `resource_dir()` は macOS で `${exe_dir}/../Resources`。dev では `target/<profile>` を返し、tauri-build が resources をそこへコピーする。https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html
- tania の Shell は今 resources を使っていない。
