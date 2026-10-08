# side panel から開いているページの中身を取る

wayfinder の map #254「ブラウザ拡張の side panel で、開いているページについて質問できるチャットを作る」のチケット #258「side panel から開いているページの中身を取る」で調べた事実。何を model に渡すかは、チケット「model に渡すページの情報」で決める。

確かめた環境: macOS 26.6.2。ブラウザは Brave 1.97.56（Chromium 155.0.8059.40）と Chrome for Testing 154.0.8037.57。どちらも新しい空の user-data-dir で起動し、`--load-extension` で [`side-panel-page-content/`](side-panel-page-content/) の拡張（と、それを書き換えた変種）を読み込んだ。操作は puppeteer-core 24.39.0 から CDP（pipe）で行った。抽出は @mozilla/readability 0.6.0、defuddle 0.19.4、pdfjs-dist 6.4.299 で試した。Chromium のソースは main（2026-10-08）、Brave のソースは brave-core の master を読んだ。【実機】は、特に断りがなければ Brave と Chrome for Testing の両方で同じ結果だったことを表す。

## 要点

| 問い | 答え |
|---|---|
| 権限 | `activeTab` だけでは足りない。`openPanelOnActionClick: true` で開いた side panel には activeTab が付かず、side panel の中のクリックでも付かない。`action.onClicked` から `sidePanel.open()` を呼べばそのタブに付くが、別 origin への移動やタブの切り替えで読めなくなる。`host_permissions: ["<all_urls>"]` があれば、どのタブもいつでも読める。Brave も同じ【実機】 |
| 本文の抽出 | `executeScript` で `document.body.innerText` を返せば、見えている文字（nav や footer を含み、`display:none` を除く）が取れる。Readability や defuddle を使えば本文だけになる。SPA を描画前に読むと描画前の文字が返り、`status: "complete"` は描画の完了を意味しない。`allFrames: true` なら cross-site の iframe も読める。100MB の文字列も返った【実機】 |
| 選択範囲 | `getSelection().toString()` で取れ、textarea の中の選択も返る。iframe の中の選択はその frame で読む【実機】。context menu の `info.selectionText` は切り詰められず、`onClicked` で activeTab が付き、`sidePanel.open()` も呼べる（ソース）。context menu の経路を実機では確かめていない |
| 取れないページ | `chrome://`（`brave://` を含む）、Web Store、他の拡張のページ、自分の拡張のページ、top-level の `about:blank` と `data:`、Brave の `account.brave.com` など 3 origin。`view-source:` では `executeScript` が返らなかった。`file://` は unpacked の拡張なら既定で読める。組み込みの PDF viewer の DOM は空で、URL を fetch して pdf.js で読めば本文が取れる【実機】 |
| ページの変化 | side panel のページで `tabs.onActivated`・`tabs.onUpdated`・`webNavigation` を直接 listen できる。pushState と replaceState は `tabs.onUpdated`（`url` 付き）と `onHistoryStateUpdated`、hash の変更は `onReferenceFragmentUpdated` で届く。`tabs.query({ active: true, currentWindow: true })` は side panel を載せている window の active タブを返す【実機】 |

## 権限

- 【実機】side panel のページから `chrome.scripting.executeScript` で active タブを読んだ結果。

  | 場面 | activeTab のみ、`openPanelOnActionClick: true` | activeTab のみ、`action.onClicked` で `sidePanel.open()` | `host_permissions: ["<all_urls>"]` |
  | --- | --- | --- | --- |
  | action のクリックで開いた直後 | 失敗 | 読めた | 読めた |
  | side panel の中のボタンを押して読む | 失敗 | 読めた | 読めた |
  | 同じタブで同じ origin へ移動 | 失敗 | 読めた | 読めた |
  | 同じタブで別 origin へ移動 | 失敗 | 失敗 | 読めた |
  | 別のタブを active にする | 失敗 | 失敗 | 読めた |
  | 別のタブで action をもう一度クリック | panel が閉じた | 読めた（panel は開いたまま） | panel が閉じた |

  - 失敗したときの error は `Cannot access contents of the page. Extension manifest must request permission to access the respective host.` だった。読めないタブでは、`tabs.query` が返す `tab.url` と `tab.title` が `undefined` になった。
  - `openPanelOnActionClick: true` の拡張では、action のクリックで panel が開閉する。
- `ExtensionActionRunner::RunAction` は、side panel を開く action（`openPanelOnActionClick: true`）なら `GrantTabPermissions` より前に `kToggleSidePanel` を返す。コメントは理由を 2 つ挙げる。side panel の UI から開いたときにも付与していないこと、panel がタブの切り替えをまたいで残ることである。`openPanelOnActionClick: false` なら付与してから `action.onClicked` を配る。https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/extension_action_runner.cc
- `sidePanel.open()` 自身は activeTab を付与しない。user gesture と `tabId`・`windowId` の有無だけを検査する。https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/side_panel/side_panel_api.cc
- crbug。
  - 40916430「activeTab permission in SidePanel page behaves differently than in Popup page」は Won't Fix（Intended behavior）。https://issues.chromium.org/issues/40916430
  - 40904917「Investigate if tab permissions should be granted upon opening an extension's side panel entry」は Assigned（P3）。上の `RunAction` の TODO が指している。https://issues.chromium.org/issues/40904917
  - 336592430「activeTab permission does not work with setPanelBehavior openPanelOnActionClick: true」は New。https://issues.chromium.org/issues/336592430
- activeTab の付与と取り消し。
  - 付与のきっかけは action のクリック、context menu、keyboard shortcut（commands）、omnibox。`chrome://` などの制限されたページには付与されない。https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
  - 付与されるのは main frame の origin だけ（`ActiveTabPermissionGranter::GrantIfRequested`）。primary main frame で cross-document の遷移が commit されると、別 origin なら取り消す。same-document の遷移（pushState、hash の変更）では取り消さない。タブを閉じたときも取り消す。https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/permissions/active_tab_permission_granter.cc
  - 【実機】activeTab が付いている間は、side panel から付与された origin へ fetch すると CORS を受けずに読めた。別 origin への fetch は `Failed to fetch` になった。
- user gesture。
  - 【実機】service worker の `action.onClicked` で `await` を挟んでから `sidePanel.open()` を呼ぶと、`` `sidePanel.open()` may only be called in response to a user gesture. `` で拒まれた。context menu の `onClicked` も同じ形で配られる（ソース）ので、`open()` は handler の中で `await` より前に呼ぶ。
  - 【実機】タブで開いた拡張のページでは、ボタンのクリックから `await chrome.windows.getCurrent()` を挟んで `sidePanel.open()` を呼んでも開いた。
  - `sidePanel.open()` は Chrome 116 から。docs は、action のクリック、keyboard shortcut、context menu、拡張のページや content script での user gesture から呼べると書いている。https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Brave は Chromium の判定をそのまま使っている。brave-core に `extension_action_runner`・`permissions_data`・`script_executor`・`side_panel_service`・scripting への patch は見当たらない。

## 本文の抽出

- 【実機】`executeScript({ func })` が返した `document.body.innerText` には、`display:none` の文字が入らず、nav・aside・footer の文字が入った。
- 結果は structured clone ではなく、V8ValueConverter で JSON に近い形へ変換される。`undefined` と関数は落ち、Date は `{}` になり、深さの上限は 100。返り値が Promise なら settle を待つ。https://chromium.googlesource.com/chromium/src/+/main/content/renderer/v8_value_converter_impl.cc ／ https://developer.chrome.com/docs/extensions/reference/api/scripting
- `func` は文字列にして送られるので、外の変数を参照できない。引数は `args` で渡し、`base::JSONWriter` で直列化される。https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/api/scripting/scripting_api.cc

### 抽出の library

- 【実機 Chrome for Testing】ページで library を動かした結果（文字数）。Readability は `textContent`、defuddle は `markdown: true` の `content` を測った。

  | ページ | outerHTML | innerText | Readability | defuddle（Markdown） |
  | --- | --- | --- | --- | --- |
  | 手元の記事（nav・aside・footer 付き） | 3,730 | 3,268 | 3,160（3ms） | 3,178（14ms） |
  | ja.wikipedia.org「Google Chrome」 | 659,952 | 19,021 | 18,546（33ms） | 104,203（164ms） |
  | MDN「Window.getSelection」 | 89,560 | 2,008 | 2,112（9ms） | 3,908（30ms） |
  | developer.chrome.com の scripting | 256,137 | 12,989 | 12,384（17ms） | 12,854（66ms） |
  | news.ycombinator.com（一覧） | 34,656 | 4,085 | 3,653 | 6,480 |
  | GitHub の issue（brave-browser#51271） | 335,454 | 5,171 | 2,885 | 9,536 |

  - defuddle の Markdown はリンクの URL を含むので、リンクの多いページでは innerText より大きくなる（Wikipedia で 5 倍）。
  - Readability の `textContent` には元の HTML のタブと改行がそのまま残る。
  - `isProbablyReaderable` は Hacker News の一覧で false、それ以外で true を返した。
- 動かす場所は 2 通りあり、どちらも動いた【実機】。
  - ページの中: `executeScript({ files: ["libs.js"] })` で bundle を入れてから、`func` で呼ぶ。ISOLATED world で動くので、ページの CSP を受けない。
  - side panel の中: `func` で `document.documentElement.outerHTML` を返し、side panel の `DOMParser` で解析する。Readability の結果は全ページで同じだった。defuddle は MDN で 3,714 になり（ページの中では 3,908）、他は同じだった。defuddle はページの `getComputedStyle` や stylesheet を見るので、layout の無い DOMParser の document では判定が変わる（推論）。https://github.com/kepano/defuddle/blob/main/src/defuddle.ts
- Readability は渡された DOM を書き換えるので、README は `document.cloneNode(true)` を渡すよう勧めている。信頼できない入力には DOMPurify を勧めている。https://github.com/mozilla/readability
- defuddle の Markdown 出力は `defuddle/full` と `defuddle/node` にしか無い（core の `defuddle` には無い）。`parseAsync()` は、ページに本文が無いとき第三者の API（FxTwitter）へ fetch しうる。`useAsync: false` で止まる。https://github.com/kepano/defuddle
- 【実機】`defuddle/full` を含めて `bun build` した bundle を `files` で入れると、`Could not load file 'libs.js'. It isn't UTF-8 encoded.` で拒まれた。bundle に temml 由来の U+FFFF（非文字）が生のまま入っていた。Chromium は `base::IsStringUTF8` で検査し、この関数は非文字を拒む。U+FFFF を `￿` に書き換えると読み込めた。https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/scripting_utils.cc ／ https://chromium.googlesource.com/chromium/src/+/main/base/strings/string_util.h

### SPA と遅れて描かれるページ

- 【実機】1.5 秒後に描く SPA を読み込み直後に読むと、`loading...`（10 文字）が返った。描画後に読むと描いた文字が返り、pushState の後に読むと遷移先の文字が返った。
- 【実機】`tabs.onUpdated` の `status: "complete"` は描画より前に来て、描画で変わった title は後から別の `onUpdated` で来た。`complete` を合図に読むと、描画前の文字を拾うことがある。

### iframe（`allFrames`）

- 【実機】`allFrames: true` の結果には、top、same-origin の iframe、cross-site の iframe（OOPIF）、`srcdoc`、`sandbox` 付きの iframe が入った（`<all_urls>` のとき）。結果の順は top が先で、残りは frame の並びと一致しなかった。
- 【実機】activeTab だけのときは、cross-site の iframe が黙って結果から落ちた（same-origin、`srcdoc`、`sandbox` は入った）。
- 複数の frame のうち一部で失敗しても、失敗した frame は結果から黙って落ち、全体は reject されない。対象が 1 つの frame なら reject される。top frame に権限が無ければ、`allFrames: true` でも呼び出し全体がエラーになる。https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/scripting_utils.cc ／ https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/script_executor.cc

### 取れる文字数

- 【実機 Chrome for Testing】`<pre>` に N MB の ASCII を入れたページで `document.body.innerText` を返すと、50MB は 150ms、100MB は 580ms で全部返った。200MB はページの読み込み自体が 120 秒で終わらなかった。
- 結果専用の上限は無い。効くのは Mojo のメッセージの上限で、content は 128 MiB にしている（境界は確かめていない）。https://chromium.googlesource.com/chromium/src/+/main/content/app/initialize_mojo_core.cc

## 選択範囲

- 【実機】`getSelection().toString()` の結果。
  - 本文の段落を選ぶと、その文字列が返った。
  - textarea の中で選ぶと、選んだ部分（`TEXTAREA-TWO`）が返った。`selectionStart`・`selectionEnd` で切り出した値とも一致した。Selection API の仕様も、textarea と input の中の選択ならその部分を返すと定めている。https://w3c.github.io/selection-api/
  - cross-site の iframe の中で選ぶと、top の `getSelection()` は空で、その iframe に入れた script だけが選択を返した。
- context menu（https://developer.chrome.com/docs/extensions/reference/api/contextMenus ）。
  - `contexts: ["selection"]` の項目を押すと、`info.selectionText`・`frameId`・`frameUrl` が届く。
  - `selectionText` は切り詰められない。50 文字で切るのはメニューの title の `%s` だけ（`kMaxSelectionTextLength = 50`）。https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/menu_manager.cc ／ https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/context_menu_helpers.h
  - クリックで activeTab が付き、`onClicked` は user gesture 付きで配られる。そのため handler から `sidePanel.open()` を呼べる。docs の例も context menu から開いている。
  - 未確認: 実機での `selectionText` の中身（改行などの扱い）、context menu からの activeTab の付与、PDF viewer の中での選択。手順は「手で確かめる手順」に書いた。
- 拡張の `background.js` は、context menu の `onClicked` で `sidePanel.open()` を呼び、`selectionText` を `chrome.storage.session` に置く。side panel は開いたときに読み、変化も listen する。

## 取れないページ

- 【実機】`<all_urls>` を持つ拡張で、active タブを `executeScript` した結果。

  | ページ | 結果 | `tab.url` |
  | --- | --- | --- |
  | `chrome://version`・`chrome://newtab`・`chrome://extensions` | `Cannot access a chrome:// URL` | 見えない |
  | `brave://version`（Brave） | `chrome://version` として開き、同じ error | 見えない |
  | `chrome://settings`・`chrome://rewards`・`chrome://wallet`（Brave） | `Cannot access a chrome:// URL` | 見えない |
  | `about:blank`、`data:text/html,...`（top-level） | `Cannot access contents of the page. ...` | 見えない |
  | `view-source:http://...` | 10 秒待っても resolve も reject もしなかった | 見えない |
  | 自分の拡張のページ（`chrome-extension://<自分>/...`） | `Cannot access contents of the page. ...` | 見える |
  | 他の拡張のページ | `Cannot access a chrome-extension:// URL of different extension` | 見えない |
  | `chromewebstore.google.com`、`chrome.google.com/webstore` | `The extensions gallery cannot be scripted.` | 見える |
  | `https://account.brave.com/`（Brave） | `This site is protected and cannot be scripted.` | 見える |
  | `brave.com`、`search.brave.com`、`talk.brave.com` | 読めた | 見える |
  | `file:///.../article.html` | 読めた | 見える |

- 判定は `PermissionsData::IsRestrictedUrl` が行う。https://chromium.googlesource.com/chromium/src/+/main/extensions/common/permissions/permissions_data.cc
  - match pattern の scheme（http、https、file、ftp、chrome、chrome-extension、filesystem、ws、wss、data、uuid-in-package）以外の URL は拒む。例外は `about:blank` と `about:srcdoc`。https://chromium.googlesource.com/chromium/src/+/main/extensions/common/url_pattern.cc
  - Web Store は `extension_urls::IsWebstoreDomain` で判定し、`chrome.google.com` 全体と `chromewebstore.google.com` が対象になる。https://chromium.googlesource.com/chromium/src/+/main/chrome/common/extensions/chrome_extensions_client.cc
  - ExtensionSettings policy の `runtime_blocked_hosts` に入った host は `This page cannot be scripted due to an ExtensionsSettings policy.` で拒まれる。
- Brave。
  - `brave://` は表示だけの scheme で、内部では `chrome://` になる。https://github.com/brave/brave-core/blob/master/chromium_src/content/browser/renderer_host/navigation_entry_impl.cc
  - `BraveExtensionsClient::IsScriptableURL` が `skus::IsSafeOrigin` の 3 origin（`https://account.brave.com`、`https://account.bravesoftware.com`、`https://account.brave.software`）を拒む。`*.brave.com` 全体ではない。https://github.com/brave/brave-core/blob/master/common/extensions/brave_extensions_client.cc ／ https://github.com/brave/brave-core/blob/master/components/skus/common/skus_utils.h
- `file://`。
  - docs は、`file:///` の match pattern にはユーザーが手で許可する必要があると書く。https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
  - ただし unpacked の拡張は「ファイルの URL へのアクセスを許可する」が既定で on になる。`Manifest::ShouldAlwaysAllowFileAccess` のコメントは「Unpacked extensions start off with file access since they are a developer feature.」。https://chromium.googlesource.com/chromium/src/+/main/extensions/common/manifest.h ／ https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/unpacked_installer.cc
  - 【実機】`--load-extension` で読み込んだ拡張は、何も設定せずに `file://` のページを読めた。
  - activeTab は file access が off なら `file://` に付かない。https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/permissions/active_tab_permission_granter.cc
- `view-source:` で返らなかった理由は確かめていない。

### 組み込みの PDF viewer

- 【実機】PDF のタブ（手元の http。Chrome for Testing では `file://` と arXiv の PDF も）で main frame を読むと、`document.contentType` は `application/pdf`、`body.innerText` は空で、`outerHTML` は `pdf_embedder.css` を読む `<link>` と空の `<body>` だけだった。`allFrames: true` でも main frame しか返らなかった。CDP からは `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html` と PDF の URL の frame が別の target として見えた。
- 今の viewer は OOPIF 版で、Win・mac・Linux では M145 から既定で on。https://chromium.googlesource.com/chromium/src/+/main/pdf/pdf_features.cc ／ https://github.com/chromium/chromium/commit/30caec72327c
  - PDF の response は template の HTML に差し替えられ、viewer の iframe は closed shadow root の中に置かれる。https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/mime_handler/resources/oopif.html
  - `ScriptExecutor` は PDF 拡張の frame とその子孫を inject の対象から外す（crbug 333457293）。https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/script_executor.cc ／ https://issues.chromium.org/issues/333457293
- Brave は Chromium の PDF viewer をそのまま使い、`kPdfOopif` を上書きしていない。https://github.com/brave/brave-core/blob/master/patches/pdf-pdf_features.cc.patch
- 【実機】side panel から PDF の URL を fetch すると、CORS の header を返さない別 origin の server からでも本文の bytes が取れた。
- 【実機 Chrome for Testing】side panel で `fetch(tab.url)` して pdfjs-dist 6.4.299 で読むと、本文が取れた。
  - 手元の 2 ページの PDF は 3,428 文字（59ms）、arXiv 1706.03762（15 ページ）は 41,463 文字（321ms）。`file://` の PDF も、同じ方法で読めた。
  - 拡張のページは、`host_permissions` に書いた host へ CORS を受けずに fetch できる。https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
  - worker は CDN から読めない（MV3 の CSP は `script-src 'self'`）。`pdf.worker.min.mjs` を拡張に同梱し、`GlobalWorkerOptions.workerSrc` に `chrome.runtime.getURL("pdf.worker.min.mjs")` を渡した。https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy

## ページの変化

- side panel は拡張のページなので、すべての Chrome API を使える（sidePanel の docs）。【実機】side panel のページで直接 `addListener` した listener に、次の event が届いた。
  - タブの切り替え: `tabs.onActivated`（`tabId`、`windowId`）。
  - 同じタブでの通常の遷移: `tabs.onUpdated`（`status: "loading"` と `url`）→ `webNavigation.onCommitted` → `tabs.onUpdated`（`title`）→ `webNavigation.onCompleted` → `tabs.onUpdated`（`status: "complete"`）。
  - pushState と replaceState: `tabs.onUpdated`（`status: "loading"` と `url`）→ `webNavigation.onHistoryStateUpdated` → `tabs.onUpdated`（`status: "complete"`）。
  - hash の変更: `tabs.onUpdated`（`url`）→ `webNavigation.onReferenceFragmentUpdated`。
  - 別の window を開いてフォーカスを移す: `tabs.onActivated` と `windows.onFocusChanged`。
  - Chrome for Testing では、移動中に `changeInfo: { frozen: true }` と `{ frozen: false }` も来た。
- 【実機】`tabs` 権限も host permission も無いタブでは、`tabs.onUpdated` は届くが `changeInfo` から `url` と `title` が消え、title の変更は `{}` で届いた。`tab.url` も `undefined` だった。activeTab が付いたタブでは `title` と `tab.url` が入った。https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/tabs/tabs_event_router.cc
- 【実機】side panel から `tabs.query({ active: true, currentWindow: true })` を呼ぶと、別の window にフォーカスがあっても side panel を載せている window のタブが返った。`lastFocusedWindow: true` はフォーカスのある window のタブを返した。docs の定義は「The current window is the window that contains the code that is currently executing」。https://developer.chrome.com/docs/extensions/reference/api/windows
- 【実機】side panel で `tabs.getCurrent()` は `undefined` を返した。
- `webNavigation` には `"webNavigation"` 権限が要り、インストール時の警告は「Read your browsing history」になる（`"tabs"` も同じ）。https://developer.chrome.com/docs/extensions/reference/permissions-list
- `sidePanel.onOpened` は Chrome 141、`onClosed` は 142、`close()` は 141 から。`setOptions({ tabId, path })` で作るタブ専用の panel は、そのタブを離れると隠れ、戻ると出る。既定の panel はタブを切り替えても同じインスタンスのまま残る。https://developer.chrome.com/docs/extensions/reference/api/sidePanel

## 確かめ方

- action のクリックは CDP の `Extensions.triggerAction`（引数は拡張の id と `type: "tab"` の target の id）で起こした。この command は toolbar のクリックと同じ `ExtensionActionViewModel::ExecuteUserAction` を呼ぶ。https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/devtools/protocol/extensions_handler.cc ／ https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/extensions/extension_action_view_model.cc
- 【実機】puppeteer-core の `pipe: true` と `enableExtensions: true`（`--enable-unsafe-extension-debugging` が付く）で起動すると、browser target の session から `Extensions.triggerAction` と `Extensions.getExtensions` を呼べた。Brave でも同じだった。開いた side panel は CDP の target（`type: "page"`、URL は `chrome-extension://<id>/sidepanel.html`）として見え、`evaluate` で `executeScript` を呼べた。
- puppeteer の `evaluate` は user gesture 付きで評価する。そのため「gesture 無しの `sidePanel.open()` が拒まれる」ことは、この方法では確かめられない。
- activeTab だけの場合は、拡張の `manifest.json` から `host_permissions` を消した変種で試した。`action.onClicked` の場合は、さらに `background.js` を `setPanelBehavior({ openPanelOnActionClick: false })` と `action.onClicked` から `sidePanel.open({ windowId })` を呼ぶ形に変えた。

## 手で確かめる手順

自動では確かめていない項目の手順。Brave の `brave://extensions` で開発者モードを on にし、「パッケージ化されていない拡張機能を読み込む」で `docs/research/side-panel-page-content/` を選ぶ。

1. context menu から渡す経路（未確認）
   1. 適当な記事で文字を選び、右クリックから「r258: 選択範囲を side panel へ」を選ぶ。
   2. side panel が開き、「イベント」に `pendingSelection` と選んだ文字列が出ることを確かめる。改行を含む範囲や長い範囲も試す。
   3. `manifest.json` から `host_permissions` を消して拡張を再読み込みし、1 と同じ操作をする。そのあと「このページを読む」が成功すれば、context menu で activeTab が付いている。
2. keyboard shortcut（未確認、ソースからの推論では activeTab は付かない）: `Alt+Shift+Y`（`_execute_action`）で panel を開き、`host_permissions` を消した版で「このページを読む」が失敗することを確かめる。
3. `file://` の許可を off にしたとき（未確認）: 拡張の詳細で「ファイルの URL へのアクセスを許可する」を off にし、`file://` の HTML を開いて「このページを読む」が失敗することを確かめる。
4. toolbar の本物のクリック（CDP と同じ経路なので省略可）: puzzle のメニューから拡張を押し、表の 1 列目と同じ結果になることを確かめる。
