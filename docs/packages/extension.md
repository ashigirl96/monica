# Chrome Extension（apps/extension）

`apps/extension`（`@monica/extension`）は、Brave に読み込む Chrome Extension を組み立てる。`@crxjs/vite-plugin`（CRXJS）を Vite の plugin として使い、apps/web と同じ `vite` と `vite build` で起こす（ADR-0029）。unpacked の読み込みだけで配り、Web Store・`.crx`・Brave 以外のブラウザには出さない。

## manifest と permission

- manifest は `apps/extension/vite.config.ts` の `defineManifest((env) => …)` に手で書く。permission も手で足す。CRXJS 3.0.0 の `permissions` の型は任意の string を通すので、typo は型で止まらない（ADR-0029）。
- `name` と `key` は `env.mode` で選ぶ。`production` は `Monica` と release の key、それ以外は `Monica (dev)` と dev の key。普段の Brave に dev を並べて読み込んでも、`brave://extensions` で見分けられる。key を出力の dir と同じ mode で選ぶので、dev の出力に release の key は入らない。
- `version` は `0.1.0` に固定する。unpacked でしか配らず、版を上げる運用を持たない。
- side panel は global にする。manifest の `side_panel.default_path` に `src/sidepanel/index.html` を書き、service worker（`src/background.ts`）が `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` を呼ぶ。toolbar の action を押すと、その window の side panel が開閉する。
- permission は `sidePanel`・`scripting`・`nativeMessaging`。`nativeMessaging` は、Backend の token の口の port と chat の token を Native Messaging の host から引く（下の「side panel」、ADR-0034）。unpacked で読み込むので、足しても警告は出ず、reload で無効にもならない。`scripting` は、質問を送った時に Current Page の top frame で `chrome.scripting.executeScript` を走らせ、HTML と選択範囲を読む（`docs/packages/chat.md` の「Page Snapshot」）。`activeTab`・`tabs`・`webNavigation` は足さない。`<all_urls>` の host permission で、どの Browser Tab にも注入できる。build の manifest は `web_accessible_resources` を持たない（CRXJS は dev の出力にだけ足す）。
- `host_permissions` は `["<all_urls>"]`。side panel が Current Page の url と title を読み（`docs/packages/chat.md` の「Current Page の追い方」）、Backend の token の口（loopback の port 0）を呼ぶ。
- 質問に添えるスクリーンショットの `chrome.tabs.captureVisibleTab` のために足す権限は無い。`activeTab` が無くても、`<all_urls>` の host permission だけで side panel から呼べる（`docs/packages/chat.md` の「スクリーンショット」）。`chrome://` などの host permission の外のページでは、`The 'activeTab' permission is not in effect…` で reject する。
- `content_security_policy.extension_pages` は `"script-src 'self'; object-src 'self'; img-src 'self' data:"`。答えに埋めた画像を読み込ませないため、`img-src` で外の画像を止める。CRXJS の dev は manifest の CSP を変えないので、dev も同じ CSP で動く。

## side panel

- `src/sidepanel/main.tsx` は globals.css を import してから、`@monica/chat/ui` の `viaNativeHost(host 名)` を渡した RPCLink を作って `client.chat` を `@monica/chat/ui` の `ChatApp` に渡すだけにする。画面と Current Page の追跡（`chrome.tabs`）は chat の ui が持つ（`docs/packages/chat.md` の「ui」）。RPC は side panel の page から呼び、service worker を経由しない（ADR-0028）。
- globals.css は fluid の token と Tailwind の theme を持ち、`@source` で `packages/chat/src/ui` を走査する。chat の ui の CSS より先に読ませ、Tailwind の layer の順を先に決める。
- side panel は RPC を呼ぶたびに `chrome.runtime.sendNativeMessage(<host 名>, {})` で Backend の token の口の port と chat の token を引き、`http://127.0.0.1:<port>/rpc` を `Authorization: Bearer <chat の token>` で呼ぶ（ADR-0034）。引いた値は覚えない。chrome の API に触る部分は chat の ui（`packages/chat/src/ui/native-host.ts`）が持ち、`docs/packages/chat.md` の「Backend の探し方」にある。
- host 名は `vite.config.ts` の `define` で `__MONICA_NATIVE_HOST__` に焼き込み、型は `src/sidepanel/native-host.d.ts` が宣言する。`vite build` は release の `com.ashigirl96.monica`、`vite`（dev）は `com.ashigirl96.monica_dev`（`scripts/native-host.ts` の `RELEASE_NATIVE_HOST`・`DEV_NATIVE_HOST`）を焼く。dev の host は dev の Brave の `MONICA_HOME` の Backend を返すので、dev の side panel は release の Backend を呼ばない。Vite の dev は `define` を `/@vite/env` で global に置くので、dev で焼いた値は `curl http://localhost:<Chrome Extension の port>/@vite/env` で見られる。
- host の manifest は、release は release の Shell が、dev は `bun run extension` が書く（`docs/packages/dev-loop.md`）。Brave は user-data-dir に依らず `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` だけを読むので、同じ実の HOME の Brave はどの profile でも同じ manifest を読む。
- `@fontsource-variable/inter` は globals.css が import するので apps/extension の依存にする。bun の isolated linker では、import する側の package.json に書く必要がある。

## ID と鍵

ID は manifest の `key`（公開鍵の DER の base64）で固定する。`key` が無いと ID は読み込んだ dir の path から決まり、読み込む場所を移すと `chrome.storage` を失う。

| | ID |
|---|---|
| release | `dnggfebiponjhdpjgmdfafaghpbkejop` |
| dev | `jhcphbonbcemkjkhofopmhbfphenihoj` |

- dev の ID はすべての worktree と home で同じ。home ごとの profile に 1 つずつしか入らないので、ぶつからない。
- 秘密鍵は持たない。unpacked の読み込みには要らず、要るのは `.crx` に固めるときだけ（ADR-0029）。鍵を作り直すときは、秘密鍵を file に書かずに公開鍵と ID だけを取る。

  ```bash
  KEY=$(openssl genrsa 2048 2>/dev/null | openssl rsa -pubout -outform DER 2>/dev/null | openssl base64 -A)
  printf %s "$KEY" | openssl base64 -d -A | shasum -a 256 | head -c32 | tr 0-9a-f a-p   # ID
  ```

## 出力の dir

CRXJS は dev も build も `build.outDir` に書く。dir を分けないと、`check:ts` の build が、dev で読み込んでいる Chrome Extension を production の中身に置き換える（ADR-0029）。

- build（`vite build`）は `apps/extension/dist/<mode>` に書く。`check:ts` と release が使うのは `dist/production`。
- dev（`vite`）は `$MONICA_HOME/dev-extension` に書く。dev の出力には Vite の port が焼き込まれるので、同じ checkout から別の home で起こした dev と分ける。
- dev の Vite は `dist/` の変更を見ない。`check:ts` の build が `dist/production` に書くたびに、dev の side panel が読み直されないようにするため。

## dev の読み込み方

`bun run extension`（`scripts/extension.ts`）が、Vite と Brave をまとめて起こす。手順と flag は `docs/packages/dev-loop.md` の「dev loop」にある。

- Vite は `devInstance` の Chrome Extension の port で `strictPort` で listen する（既定の home は 19781、ほかは 19782〜19881）。空いている別の port には移らない。dev の出力に port が焼き込まれ、別の port で起き直すと Chrome Extension を reload するまで繋がらないため。
- Brave は home ごとの user-data-dir（`$MONICA_HOME/dev-brave`）で起こし、dev の出力を `--load-extension` で読み込ませる。
- 新しい profile は開発者モードが off で、CRXJS が reload すると unpacked で読み込んだものが無効になる。そこで script が、同じ profile で headless の Brave を一度起こし、`brave://extensions` で `chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })` を呼ばせる。`Default/Preferences` に書いても、Brave は `Secure Preferences` の MAC で守られたこの pref を既定に戻す（Brave 1.97）。書けたかは `Default/Secure Preferences` の `extensions.ui.developer_mode` で見る。
- 普段の Brave には release の Chrome Extension だけを入れる。dev の出力は、同じ home の Vite が動いている間しか働かない。
- agent は `extension-dev` skill の手順で、headless の Brave の side panel を CDP で開いて読む。

## release の読み込み方

`bun run build` が `dist/production` を作り、`bun run install-app` がそれを `/Applications/Monica.app/Contents/Resources/extension` に写す（`docs/packages/dev-loop.md` の「release build と install」）。

- 普段の Brave の `brave://extensions` で開発者モードを on にし、「パッケージ化されていない拡張機能を読み込む」を押す。file の選択で ⌘⇧G を押し、`/Applications/Monica.app/Contents/Resources/extension` を選ぶ。`.app` は Finder では 1 つの file に見え、中に入れないため。読み込むのは一度だけで、ID は release の ID になる。
- side panel が Backend を見つけるには、release の desktop を一度起動し、Shell に host の manifest を書かせる（`docs/packages/dev-loop.md`）。それまでは host が見つからず、帯「monica の desktop が起動していません」が出る。
- Brave は unpacked で読み込んだものを自分では読み直さない。`install-app` で `.app` を入れ替えた後は、`brave://extensions` で reload を押す（ADR-0029）。reload を押す前の Brave がどう振る舞うか（古い中身のまま動くか、エラーを出すか）はまだ確かめていない。

## `chrome` の型と lint

- root の tsconfig は `types: ["bun"]` なので、`apps/extension/src/chrome-env.d.ts` の `/// <reference types="chrome" />` で `@types/chrome` を読む。tsconfig は 1 つなので、`chrome` の型は program の全 file から見える。
- `chrome` の global を使ってよいのは apps/extension と chat の ui（`packages/chat/src/ui`）だけ。`.oxlintrc.json` の root の `no-restricted-globals` が `chrome` を止め、この 2 つの override で `off` にする。`scripts/oxlint/chrome-global.test.ts` が、apps/web・apps/desktop・apps/backend・`packages/*/src` では止まり、この 2 つでは止まらないことを見る。`globalThis.chrome` と `window.chrome` は見ない。
- apps/extension はブラウザで動くので、apps/web と同じ並びの `no-restricted-imports` を持つ（`bun:sqlite`、cli entry、他の apps、`@monica/*/server`・`schema`・drizzle の値）。他の apps は `@monica/extension` を import しない。
