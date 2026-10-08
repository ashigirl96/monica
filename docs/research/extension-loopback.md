# 拡張のページから loopback の Backend を呼ぶ

wayfinder の map #254「ブラウザ拡張の side panel で、開いているページについて質問できるチャットを作る」のチケット #259「拡張のページから Backend の loopback の口を呼ぶ」で調べた事実。Web ページから呼ぶ場合は `docs/research/browser-loopback.md` にあり、ここでは拡張の origin から呼ぶ場合を扱う。口の形は別のチケット「拡張から Backend への口」で決める。

確かめた環境: macOS 26.6.2、Bun 1.4.2、Brave 1.97.56（Chromium 155.0.8059.40）、Chrome for Testing 153.0.8010.12（以下 CfT）、oRPC 1.15.4、hono 4.13.12、agent-browser 0.33.2。【実機】と書いたものは、`docs/research/extension-loopback/` の拡張を新しい user-data-dir の headless で読み込み、同じ directory の echo server と、desktop 無しで起こした dev の Backend（notes の口は 19419、token の口は port 0）に当てて確かめた。特に断りが無ければ Brave と CfT で同じ結果だった。

## 要点

| 問い | 答え |
|---|---|
| 拡張から届く header | host_permissions に書いた host へは `Sec-Fetch-Site: none`。`Origin: chrome-extension://<id>` は POST に付き、GET には付かない。side panel・拡張の page・service worker で同じ |
| Web ページが同じ header を作れるか | 作れない。fetch に書いた `Origin` と `Sec-*` は捨てられる。`none` が付くのはアドレスバーなどからの navigation（GET）だけ。ただし拡張の page は `Origin` を書き換えられたので、loopback の host permission を持つ他の拡張は同じ組を作れる見込み |
| CORS | host_permissions に書いた host へは、JSON の POST にも Authorization 付きにも preflight が出ず、ACAO の無い応答も読める。書いていない host へは `cross-site` で、ふつうの CORS がかかる |
| Local Network Access | 許可の prompt も拒否も起きなかった。Chromium は拡張の origin を loopback の address space として扱う。Brave も同じ |
| notes の口 | Host の照合は通り、`Sec-Fetch-Site` の `same-origin` の照合で 403 になる |
| token の口 | CORS の origin の絞りは効かず、bearer で 401 になる。token があれば `workbench.layout.get` も `workbench.changes` も通る。拡張は `backend.json` を読めない |
| streaming | side panel から RPCLink で event iterator を読める。side panel を閉じると 0.4 秒で server の request の signal が abort した |
| service worker | fetch の stream を毎秒受けていても、最後の拡張の event から 30 秒で止まり、接続が切れた |
| ID の固定 | manifest の `key` に公開鍵の DER を base64 で書くと、鍵の SHA-256 の先頭 32 桁を a〜p に写した ID になる |
| Native Messaging | Brave は host manifest を Chrome の場所（`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`）から読み、Brave 自身の directory は読まない |

## 拡張から届く header

- 【実機】echo server が受け取った header。side panel（`panel.html`）、拡張の page（`page.html`）、service worker（`sw.js`）で同じだった。manifest の `host_permissions` は `http://127.0.0.1/*` と `http://monica.localhost/*` で、`localhost` は書いていない。

  | 送り方 | Origin | Sec-Fetch-Site | preflight | 結果 |
  | --- | --- | --- | --- | --- |
  | `127.0.0.1`・`monica.localhost` へ GET | 無し | none | － | 200 を読めた |
  | 同じ host へ POST（`application/json`） | `chrome-extension://<id>` | none | 出ない | 200 を読めた |
  | 同じ host へ POST（json と `Authorization: Bearer`） | `chrome-extension://<id>` | none | 出ない | 200 を読めた |
  | `localhost`（host permission 無し）へ GET | `chrome-extension://<id>` | cross-site | － | server には届いたが、fetch は `TypeError` |
  | `localhost` へ POST（json） | `chrome-extension://<id>` | cross-site | OPTIONS が届いた | 本体は送られず `TypeError` |

  `Sec-Fetch-Mode` はどれも `cors`、`Sec-Fetch-Dest` は `empty`。echo server は CORS の header を返さない。
- extension の frame と service worker の URL loader factory は `unsafe_non_webby_initiator = true` で作られ、CORS は `OriginAccessList` を見る。https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/url_loader_factory_manager.cc
- `OriginAccessList` には `GetEffectiveHostPermissions()` の host が入る。port が `*` なら任意の port、ユーザーが取り上げた site は入らない。https://chromium.googlesource.com/chromium/src/+/main/extensions/common/cors_util.cc
- `Sec-Fetch-Site` は `GetInitiatorRelation` が決める。「Privileged requests initiated from a "non-webby" context will send `Sec-Fetch-Site: None` while unprivileged ones will send `Sec-Fetch-Site: cross-site`」。権限があるとみなすのは、redirect の先を含めて全部の URL に access を持つ場合。M80 の commit a03caef（Bug 995475）で入った。https://chromium.googlesource.com/chromium/src/+/main/services/network/sec_header_helpers.cc
- `Sec-Fetch-*` は potentially trustworthy な URL にしか付かない（同じ file の `IsUrlPotentiallyTrustworthy`）。`127.0.0.0/8` と `localhost`・`*.localhost` は該当する。https://chromium.googlesource.com/chromium/src/+/main/net/base/is_potentially_trustworthy.cc
- access list が宛先を許すと `fetch_cors_flag_` が立たず、preflight は出ず、response tainting は basic になる。Origin は `fetch_cors_flag_` が立つか、method が GET・HEAD 以外のときに付く。コメントに「OriginAccessList is in practice used to disable CORS for Chrome Extensions.」とある。https://chromium.googlesource.com/chromium/src/+/main/services/network/cors/cors_url_loader.cc
- Fetch の仕様も、tainting が cors でなければ GET と HEAD に Origin を付けない（「append a request `Origin` header」）。https://fetch.spec.whatwg.org/

## Web ページと他の拡張が同じ header を作れるか

- `Origin` は forbidden request-header で、`sec-` で始まる名前も forbidden になる。https://fetch.spec.whatwg.org/ ／ Fetch Metadata §4.2 は `Sec-` の prefix を「unmodifiable from JavaScript」の根拠にしている。https://w3c.github.io/webappsec-fetch-metadata/
- 【実機 Brave】`http://127.0.0.1:47951` の頁から、`origin: chrome-extension://<id>` と `sec-fetch-site: none` を書いた POST を fetch すると、どちらも黙って捨てられ、`Origin: http://127.0.0.1:47951` と `Sec-Fetch-Site: same-origin` が届いた。
- Fetch Metadata §2.3 は `none` を user が起こした navigation に定める。【実機 Brave】agent-browser の `open` での navigation は `Sec-Fetch-Site: none`・`Sec-Fetch-Mode: navigate`・`Sec-Fetch-User: ?1` の GET だった。Web ページからの top-level の form POST は `cross-site` になる（`docs/research/browser-loopback.md`）。
- content script の request は、host permission があっても page の origin の cross-origin request として扱われる。「Cross-origin requests are always treated as such in content scripts, even if the extension has host permissions.」https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- 【実機】拡張の page と service worker は `Origin` を書き換えられた。`origin: http://monica.localhost:19380` と `sec-fetch-site: same-origin` を書いた `127.0.0.1` 宛ての POST は、`Origin: http://monica.localhost:19380` のまま届き、`Sec-Fetch-Site` は `none` のままだった。書き換えを許すソースの箇所は確かめていない（未確認）。
- 推論: 上の結果から、`127.0.0.1` や `<all_urls>` の host permission を持つ他の拡張は、`Origin: chrome-extension://<monica の拡張の id>` と `Sec-Fetch-Site: none` の組を作れる。他の拡張では試していない。declarativeNetRequest で header を書き換える経路も確かめていない（未確認）。
- 同じ user の他の process は何でも送れる。ADR-0007 の token も、これを守る相手にしていない。

## CORS と Local Network Access

- host permission があれば、extension の service worker と page は自分の origin の外の server と話せる。「A script executing in an extension service worker or foreground tab can talk to remote servers outside of its origin, as long as the extension requests host permissions.」https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- match pattern の port は既定で wildcard で、「Use http://localhost/*, or http://127.0.0.1/*… Match patterns match all ports unless an explicit port is specified.」https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns 。【実機】`http://127.0.0.1/*` と `http://monica.localhost/*` は 47951・19419・token の口の port のどれにも効いた。`http://*.localhost/*` は試していない（未確認）。
- Chromium は `chrome-extension:` の URL の address space を `kLoopback` にする（`DetermineAddressSpaceFromURL`）。https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/chrome_content_browser_client.cc 。LNA の checker は、client より公開側でない（local と loopback をまとめて見る）宛先への request を許可無しで通す。https://chromium.googlesource.com/chromium/src/+/main/services/network/local_network_access_checker.cc 。LNA の blog と仕様は拡張に触れていない。https://developer.chrome.com/blog/local-network-access ／ https://wicg.github.io/local-network-access/
- extension の service worker では LNA の不具合が 2 つあった。
  - crbug 435246545: extension が作った service worker の client の address space が設定されず `kUnknown` になっていた。141.0.7342.0 で直り、140.0.7339.14 にも入った。https://chromiumdash.appspot.com/fetch_commit?commit=8c54409eb37eab2752c23742bebc49d31f686085
  - crbug 456078996: DB に `kUnknown` で保存された古い登録の service worker から、LNA の request がすべて失敗していた。extension の service worker の address space を `kLoopback` に固定して直した。144.0.7512.0 で入り、142.0.7444.158 と 143.0.7499.24 にも入った。https://chromium-review.googlesource.com/c/chromium/src/+/7106704
- 【実機】`navigator.permissions.query` の `local-network-access`・`local-network`・`loopback-network` はどれも `prompt` のままで、fetch は許可を待たずに通った。同じ Brave の headless で `https://example.com` から fetch すると `loopback-network` が `denied` になって止まる（`docs/research/browser-loopback.md`）。host permission の無い `localhost` への GET も server まで届き、止めたのは CORS だった。
- Brave は 1.88.x で自前の localhost permission をやめ、Chromium の LNA に乗り換えた。https://github.com/brave/brave-browser/issues/51843 。brave-core に `DetermineAddressSpaceFromURL` の上書きは見つかっていない。【実機】Brave 1.97.56 でも CfT 153 と同じく止まらなかった。
- headed の Brave で prompt の bubble が出ないことは画面で見ていない（未確認）。上の checker の規則からは出ない見込み（推論）。

## 今の口に当てる

拡張の page から、`@orpc/client` 1.15.4 の `RPCLink` で POST した。

- 【実機】結果。

  | 口 | 呼び方 | 結果 | 止めたもの |
  | --- | --- | --- | --- |
  | notes の口（`127.0.0.1:19419`・`monica.localhost:19419`） | `note.daily.dates` | 403 `FORBIDDEN` | `Sec-Fetch-Site: none` が `same-origin` の照合で落ちた |
  | notes の口 | RPCLink の `headers` に `sec-fetch-site: same-origin` を書く | 403 | browser が header を捨て、`none` のまま届いた |
  | token の口（`127.0.0.1:<port>`） | token 無しで `workbench.layout.get` | 401 `UNAUTHORIZED` | bearer |
  | token の口 | `Authorization: Bearer <backend.json の token>` | 200（`{"runspaces":[]}`）。`workbench.changes` の event iterator も開いた | 無し |

- 【実機】Host の照合は通っている。curl で同じ Host と `Origin: chrome-extension://<id>` を付け、`Sec-Fetch-Site: none` なら 403、`same-origin` なら 200 だった（`apps/backend/src/notes-listener.ts:31-35`）。
- token の口の CORS（`apps/backend/src/main.ts:91-98`）は origin を tauri と dev の URL に絞る。【実機】拡張からは preflight が出ず、応答の ACAO も見られないので、この絞りは拡張を止めなかった。止めたのは bearer だけだった。
- 拡張は既定では手元の file を読めない。そのため、port と token を `backend.json` から取る今の CLI の形（ADR-0007）は、拡張では使えない（推論）。拡張の詳細で file の URL へのアクセスを許したときに、side panel から `file://` の `backend.json` を読めるかは試していない（未確認）。Native Messaging の host は普通の process なので file を読める（下の「Native Messaging」）。

## streaming

- 【実機】side panel・拡張の page・service worker から、RPCLink で event iterator を読めた（echo server の `tick` と Backend の `workbench.changes`）。client で 3 件読んで `break` すると、約 1 秒後に server の async generator の `finally` が走った。
- 【実機 Brave】拡張の page の button の click（CDP の入力）の中で `chrome.sidePanel.open({ windowId })` を呼ぶと side panel が開き、`panel.html` も同じ probe を走らせた。
- 【実機 Brave】side panel で素の SSE（fetch で読む）と oRPC の event iterator を 1 本ずつ張ったまま、`chrome.sidePanel.close({ windowId })` で閉じた。close が resolve してから 0.36 秒で Bun の `request.signal` が abort し、generator の `finally` も 1.2 秒後に走った（1 秒の sleep の後に signal を見る書き方のため）。拡張の page の tab を閉じたときも、閉じてすぐ abort した。
- side panel を閉じると、`ExtensionSidePanelCoordinator::OnViewDestroyed()` が `host_.reset()` で ExtensionViewHost を捨てる。tab や window を閉じたときも同じ。https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/extensions/extension_side_panel_coordinator.cc 。docs は close で document が壊れるとは書いていない。
- `sidePanel.close()` と `onOpened` は Chrome 141、`onClosed` は Chrome 142 から。https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- ユーザーが side panel の × で閉じた場合と、別の拡張の panel に切り替えた場合は確かめていない（未確認）。× は上の `OnViewDestroyed` と同じ経路を通る見込み（推論）。
- Backend の 2 つの口は hono から RPCHandler に `c.req.raw` を渡すので、echo server と同じ `Request` の signal を受ける（推論。Backend 側の切断は echo server で確かめた）。

### service worker

- 【実機 Brave】service worker で素の SSE と oRPC の event iterator を張り、毎秒 chunk を受けさせたまま拡張の page を閉じた。最後の拡張の event（`runtime.onMessage`）から 30.0 秒で service worker が止まり、server で両方の接続の abort が見えた（素の SSE は 30 件を送って 30038ms）。agent-browser の CDP は page に繋がっていて、service worker の DevTools は開いていない。
- docs の停止条件は「After 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer.」「When a single request, such as an event or API call, takes longer than 5 minutes to process.」「When a fetch() response takes more than 30 seconds to arrive.」。stream の受信が timer を延ばすかは書いていない。https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- 同じ頁によると、Chrome 116 から WebSocket の通信が寿命を延ばし、Chrome 114 から long-lived な port での message の送受信が timer を延ばす（port を開くだけでは延びない）。Chrome 105 から `connectNative()` の port も service worker を生かす。

## ID の固定

- 手順。秘密鍵は manifest に書かず、unpacked で読み込むのにも要らない。

  ```bash
  openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem
  openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A   # manifest の "key" に書く
  openssl rsa -in key.pem -pubout -outform DER | shasum -a 256 | head -c32 | tr 0-9a-f a-p   # ID
  ```

- 【実機】`docs/research/extension-loopback/extension/manifest.json` の `key` で、Brave 1.97.56 と CfT 153 のどちらでも ID は `ifolcncmkjoepcojhckpgnfecfmkmchb` になり、上の計算と一致した。秘密鍵は browser に渡していない。
- `ComputeExtensionID` は、`key` があれば base64 を解いた DER から、無ければ directory の path から ID を作る。後者のコメントは「useful for development mode, because it keeps the ID stable across restarts」。https://chromium.googlesource.com/chromium/src/+/main/extensions/common/extension.cc
- ID は SHA-256 の先頭 16 byte を 16 進にし、各桁を `'a' + 値` に写したもの。https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/id_util.cc
- `key` の docs は Developer Dashboard から公開鍵を写す手順だけを書き、openssl の手順は載せていない。https://developer.chrome.com/docs/extensions/reference/manifest/key
- 同じ `key` で directory を移したときに ID が変わらないことは試していない（ソースからは変わらない見込み、推論）。

## Native Messaging

- host manifest は `name`・`description`・`path`（macOS では絶対 path）・`type: "stdio"`・`allowed_origins` を持つ。`allowed_origins` は wildcard を書けず、`chrome-extension://<id>/` の形で末尾の `/` が要る（parser は URLPattern として読み、path が空なら拒む）。拡張は `nativeMessaging` permission が要り、呼べるのは拡張の page と service worker で、content script からは呼べない。https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging ／ https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/native_messaging_host_manifest.cc
- message の上限は host から 1 MB、host へ 64 MiB。`connectNative()` の host は port が壊れるまで生き、`sendNativeMessage()` は message ごとに host を起こす（同じ docs）。
- 読む場所は user の directory が先で、次に system の directory。https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context_posix.cc 。Chrome の macOS の場所は `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` と `/Library/Google/Chrome/NativeMessagingHosts/`。
- brave-core は Linux と macOS で、user と system の directory を Chrome の場所に差し替える。コメントは「Setup NativeMessagingHosts to point to the default Chrome locations because that's where native apps will create them」。macOS では `DIR_APP_DATA` の下の `Google/Chrome/NativeMessagingHosts` と `/Library/Google/Chrome/NativeMessagingHosts`。https://github.com/brave/brave-core/blob/15275d8ffffff35ba55284d70e8b7b2bd9c29a83/app/brave_main_delegate.cc#L141-L164
- 【実機 Brave】`CFFIXED_USER_HOME` と `HOME` を空の directory に向けて Brave を起こし、host 名を変えた manifest を 4 か所に置いて `sendNativeMessage` を呼んだ。応答したのは `Google/Chrome` の host だけで、ほかは `Specified native messaging host not found.` だった。

  | manifest を置いた場所 | Brave 1.97.56 | CfT 153 |
  | --- | --- | --- |
  | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` | 読んだ | 試していない |
  | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | 読まない | 試していない |
  | `~/Library/Application Support/Chromium/NativeMessagingHosts/` | 読まない | 試していない |
  | `<user-data-dir>/NativeMessagingHosts/` | 読まない | 読んだ |

- 【実機】host の第 1 引数は呼んだ拡張の origin（`chrome-extension://<id>/`）で、cwd は host の `path` の directory だった。env は browser の env を受け継ぐ。Dock から起こした Brave の PATH は launchd の短いものなので、`path` には bun を絶対 path で呼ぶ wrapper を書く（推論。Dock から起こした Brave では試していない）。
- system の directory（`/Library/Google/Chrome/NativeMessagingHosts/`）は root が要るので試していない（未確認）。
- Brave には Native Messaging の docs が無いという issue が開いている。https://github.com/brave/brave-browser/issues/56141

## 確かめていないことと手で確かめる手順

未確認のもの:

- headed の Brave で LNA の prompt が出ないこと。
- ユーザーが side panel の × で閉じたときと、別の panel に切り替えたときに接続が切れること。
- 他の拡張が `Origin: chrome-extension://<monica の拡張の id>` を作れること。declarativeNetRequest での書き換え。
- `http://*.localhost/*` の match pattern。
- system の directory の Native Messaging の host manifest。
- file の URL へのアクセスを許した拡張が `file://` の `backend.json` を読めるか。

手で確かめる手順（`docs/research/extension-loopback/` を使う）:

1. `bun install` の後、`bun docs/research/extension-loopback/build.ts` で `extension/rpc.js` を作る（`@orpc/client` を `apps/web` の依存から bundle する）。
2. `bun docs/research/extension-loopback/echo-server.ts 47951 > echo.jsonl` で echo server を立てる。`127.0.0.1` と `::1` の両方で bind し、届いた header・preflight・SSE の abort・oRPC の generator の `finally`・拡張からの報告を JSON 行で出す。
3. Backend にも当てるなら、`backend-headless` skill の手順で `MONICA_NOTES_PORT` を付けて Backend を起こす。
4. Brave の `brave://extensions` で developer mode を入れ、`extension/` を「Load unpacked」で読み込む。ID は `ifolcncmkjoepcojhckpgnfecfmkmchb` になる。agent-browser なら `--executable-path` に Brave、`--extension` に `extension/`、`--profile` に空の directory を渡す。
5. `chrome-extension://ifolcncmkjoepcojhckpgnfecfmkmchb/page.html?echo=47951&notes=<notes の口>&api=<token の口>&token=<token>` を開く。query は `chrome.storage.local` に残り、side panel と service worker も同じ値を使う。probe の結果は頁と echo server の `report` の行に出る。`hold=0` を付けなければ、頁は読み続ける stream を 2 本張る。
6. 頁の button で、side panel の open と close、service worker での probe と stream の保持、Native Messaging の呼び出しを試す。headed で開けば LNA の bubble と × での close を見られる。
7. Native Messaging は `native-host.ts` を bun の絶対 path で呼ぶ wrapper を作り、`allowed_origins` に `chrome-extension://ifolcncmkjoepcojhckpgnfecfmkmchb/` を書いた manifest を置く。host 名は `?native=<名前>,<名前>` で並べて呼べる。
