# ブラウザ拡張を monica の repo の中でビルドする（WXT と CRXJS）

wayfinder の map #254「ブラウザ拡張の side panel で、開いているページについて質問できるチャットを作る」のチケット #260「拡張のビルドを monica の repo の制約の中で動かす」で調べた事実。WXT と CRXJS の両方で side panel の空のページを組み、monica の `check:ts` 相当を通して比べた。どちらを選ぶかはここには書かない。

確かめた環境: macOS 26.6.2、Bun 1.4.2（isolated linker）、Node 22.23.3、TypeScript 7.0.2、oxlint 1.86.0（oxlint-tsgolint 7.0.2003）、oxfmt 0.71.0、Vite 8.3.2、@vitejs/plugin-react 6.1.1、tailwindcss と @tailwindcss/vite 4.3.3、React 19.3.0、WXT 0.21.4（@wxt-dev/browser 0.3.4）、@crxjs/vite-plugin 3.0.0、@types/chrome 0.3.4、Brave 1.97.56（Chromium 155.0.8059.40）。【実機】と書いたものは、branch `research/extension-build` の `apps/extension-wxt` と `apps/extension-crxjs` を、新しい空の user-data-dir で起こした Brave に `--load-extension` で読み込んで確かめた。

## 要点

| 問い | WXT 0.21.4 | CRXJS 3.0.0 |
|---|---|---|
| 型（tsconfig が 1 つ） | 【実機】通る。root の `include` に `wxt.config.ts` と `.wxt/wxt.d.ts` を足す。`.wxt/` は `wxt prepare` が作り、app の `postinstall` に書けば `bun install --frozen-lockfile` で作られる。`imports: false` なら `browser` などの global は出ない。`chrome` の global も無く、`wxt/browser` から import する。docs の `/// <reference path>` は oxlint の `triple-slash-reference` で止まる | 【実機】通る。root の `include` に `vite.config.ts` を足し、src に `/// <reference types="chrome" />` を書いて `@types/chrome` を読む。`chrome` は program 全体の global になり、apps/web と apps/desktop の file でも型が付く。`defineManifest` の `permissions` は @types/chrome 0.3.x に無い型を参照していて、`skipLibCheck: true` の下では typo が通る |
| dev（side panel の HMR と Brave） | 【実機】効く。HTML を `.output/chrome-mv3-dev` に書き、inline の preamble を dev server の module に置き換え、dev の manifest の CSP の `script-src` に `http://localhost:3000` を足す。side panel で React の state を保ったまま更新された | 【実機】効く。`dist` に loader を書き、service worker が `chrome-extension://<id>/` への fetch を Vite に中継する。inline の preamble は `@crx/inline-script/…` の module にまとめる。CSP は変えない。side panel で React の state を保ったまま更新された |
| build（出力、manifest の `key`、`check:ts`） | 【実機】`wxt build` が `.output/chrome-mv3/` に出す。`manifest: { key }` がそのまま入り、`side_panel.default_path` と `sidePanel` の permission は entrypoint から足される。`check:ts` には `bun run --cwd apps/extension-wxt build` を足す | 【実機】`vite build` が `dist/` に出す。dev と同じ dir を使う。`key` は `defineManifest` にそのまま書く。`sidePanel` の permission は自分で書く。`check:ts` には `bun run --cwd apps/extension-crxjs build` を足す |
| TypeScript 7 | 【実機】tsc 7.0.2 で通る。生成する tsconfig に TS 7 で外れた option は無い。WXT は `typescript` を実行時に import しない | 【実機】tsc 7.0.2 で通る。CRXJS は `typescript` を実行時に import しない。CRXJS の template の tsconfig は TS 7 で外れた `baseUrl` を使うが、monica はそれを使わない |

## 組んだ形

- 2 つの app は、React と Tailwind v4 の side panel 1 枚と、`sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` だけの background を持つ。side panel は `@monica/ui` の `cn` と `PlusIcon` を import する。
- catalog に足したのは `wxt ^0.21.4`、`@crxjs/vite-plugin ^3.0.0`、`@types/chrome ^0.3.4` の 3 つ。vite・@vitejs/plugin-react・@tailwindcss/vite・tailwindcss・react・@types/react は既存の catalog を `catalog:` で参照した。
- WXT には `@wxt-dev/module-react` を入れず、`vite: () => ({ plugins: [react(), tailwindcss()] })` で apps/web と同じ plugin を渡した。WXT の docs も module を使わずに Vite の plugin を足す形を書いている。https://wxt.dev/guide/essentials/frontend-frameworks.html
- root の `tsconfig.json` の `include` に `apps/extension-wxt/wxt.config.ts`、`apps/extension-wxt/.wxt/wxt.d.ts`、`apps/extension-crxjs/vite.config.ts` を足した。
- `.gitignore` に `.wxt/` と `.output/` を足した。CRXJS の `dist/` は既存の `dist/` で外れる。
- `.oxlintrc.json` に、apps/web と同じ制限（`bun:sqlite`、cli entry、他の apps、`@monica/*/server`・`schema`・drizzle の値の import）を `apps/extension-wxt/**` と `apps/extension-crxjs/**` に掛ける override を足した。【実機】両方の app で `@monica/note/server` の import が error になった。
- `check:ts` の末尾に `bun run --cwd apps/extension-wxt build && bun run --cwd apps/extension-crxjs build` を足した。【実機】node_modules と `.wxt` を全部消して `bun install --frozen-lockfile` から始め、`bun run check:brief check:ts` が通った（1582 tests と 4 つの build）。`@monica/ui` を足した最後の形でも通った。そのときの 1 回目は、machine の load average が 13 前後の中で bun test の 5 秒の timeout が 5 件出て落ち、流し直すと通った。拡張の file は bun test に入らない。
- manifest の `key` には、openssl で作った RSA 2048 の公開鍵の DER を base64 にして書いた。【実機】Brave が付けた ID は、両方の dev と build で、鍵の sha256 から計算した `fmehlpnnmbefjpgcefeifkaknjcgdglk` と一致した。

## 型

### WXT

- 【実機】`wxt prepare` は `.wxt/tsconfig.json`、`.wxt/wxt.d.ts`、`.wxt/types/{paths,i18n,globals,imports-module}.d.ts` を作る。`wxt.d.ts` は `/// <reference types="wxt/vite-builder-env" />`（中身は `vite/client` の参照）と、`types/*.d.ts` への `/// <reference path>` を並べたもの。https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/src/core/generate-wxt-dir.ts
- docs は、monorepo で `.wxt/tsconfig.json` を extends しないなら `/// <reference path="./.wxt/wxt.d.ts" />` を足すよう書いている。https://wxt.dev/guide/essentials/config/typescript.html
- 【実機】monica でこの 1 行を src に置くと、oxlint の `typescript(triple-slash-reference)` が error にする（既定で `path` の参照を禁じる）。root の tsconfig の `include` に `apps/extension-wxt/.wxt/wxt.d.ts` を書くと、tsc は通り lint にもかからない。`apps/desktop/src/vite-env.d.ts` の `/// <reference types="vite/client" />` は types の参照なので、この rule に当たらない。
- 【実機】`.wxt` が無くても、`include` の file が見つからないだけで tsc は何も言わない。生成型に頼るコードだけが落ちる。`browser.runtime.getURL('/sidepanel.html')` は、`.wxt` が無いと `Property 'getURL' does not exist` になり、あると entrypoint の path の union で `/nope.html` を弾く。
- 【実機】`apps/extension-wxt/package.json` の `"postinstall": "wxt prepare"` は、`bun install` と `bun install --frozen-lockfile` が workspace の lifecycle script として流し、`.wxt` を作った。`wxt build` も最初に `.wxt` を作り直す（消してから build すると作られた）。
- 推論: `check:ts` は tsc を build より先に流すので、install の後に entrypoint や `wxt.config.ts` を変えると、tsc は古い `.wxt` を読む。
- 【実機】`imports` を既定（auto-import が有効）にすると、`.wxt/types/imports.d.ts` が `declare global { const browser; const defineBackground; const storage; … }` を出し、apps/web の file から `browser`・`defineBackground`・`storage` が名前解決された。`imports: false` にすると `imports.d.ts` は作られず、apps/web からは `browser`・`defineBackground`・`chrome` のどれも `Cannot find name` になった。前に作られた `imports.d.ts` は消されずに残るが、`wxt.d.ts` から参照されなくなる。https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/src/builtin-modules/unimport.ts
- `browser` の型は `@wxt-dev/browser` が `@types/chrome` から生成する。生成のときに `declare namespace chrome` を `export namespace Browser` に置き換え、global の `chrome` を消している。README は「global の型の scope を汚さない」ためと書く。https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/browser/scripts/generate.ts ／ https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/browser/README.md
- 【実機】`.wxt/types/globals.d.ts` の `ImportMetaEnv` の拡張（`BROWSER`・`CHROME` など）は global なので apps/web からも見える。`import.meta.env.CHROME` は boolean に型が付いた。
- 【実機】`skipLibCheck: false` で流すと、`globals.d.ts` が bun-types の `ImportMetaEnv`（`string | undefined` の index signature）と `ImportMeta.env` に衝突して 7 件、`i18n.d.ts` が `I18n` namespace を見つけられずに 1 件の error を出す。monica は `skipLibCheck: true` なので出ない。
- unimport の Vite plugin は `imports: false` でも足される。workspace の package の source の `.ts` を変換するという報告がある（#2206、2026-04 に close、0.20.27 でも回避策が要ったというコメントあり）。https://github.com/wxt-dev/wxt/issues/2206
- 【実機】source の `.ts` を exports する `@monica/ui` を import して、build も dev も動いた。`packages/ui/src/icons.tsx` の編集は dev で HMR された。

### CRXJS

- CRXJS は型の生成物を作らない。`defineManifest` の型は CRXJS が持つ。d.ts は global の `chrome` namespace を `/// <reference>` なしで参照するので、`@types/chrome` は自分で入れる（CRXJS の devDependency でしかない）。https://github.com/crxjs/chrome-extension-tools/blob/d2894726d0e4ab6d3f285bb4d8f27c53dd632192/packages/vite-plugin/src/node/defineManifest.ts
- TS 6 から `types` の既定は `[]` で、列挙した package しか global を足さない。monica の root は `types: ["bun"]` なので、`@types/chrome` は自動では入らない。https://www.typescriptlang.org/tsconfig/#types
- 【実機】`apps/extension-crxjs/src/chrome-env.d.ts` に `/// <reference types="chrome" />` を書いた。oxlint の `triple-slash-reference` は、同じ module の import が無い types の参照を止めない。
- 【実機】その結果、apps/web と apps/desktop の file でも `chrome.runtime.id` が string として解決された。`@types/chrome` の `index.d.ts` は `declare namespace chrome` を持つ global の script なので、program に入れば全 file から見える。https://www.npmjs.com/package/@types/chrome
- 【実機】`defineManifest` は未知の key（`side_panel_typo`）を excess property として弾く。`permissions: ['sidePanell']` は通った。3.0.0 の d.ts は `chrome.runtime.ManifestPermissions` を参照するが、@types/chrome 0.3.4 にあるのは `ManifestPermission` で、`skipLibCheck: false` だと TS2724 が 2 件出る。maintainer は manifest の型が遅れることがあると書いている。https://github.com/crxjs/chrome-extension-tools/issues/1073
- 【実機】WXT の `permissions` も `(ManifestPermission | (string & Record<never, never>))[]` なので、typo は通る。補完のための型で、任意の文字列を受ける。

### 両方を同じ program に置いたとき

- 【実機】`skipLibCheck: false` で流すと、`@types/chrome` と `@wxt-dev/browser` がどちらも `HARFormatEntry` などを global に宣言していて、Duplicate identifier になる。`skipLibCheck: true` では出ない。

## dev

### WXT

- 【実機】`wxt`（dev）は `http://localhost:3000` で Vite を起こし、`.output/chrome-mv3-dev/` に manifest と HTML を書く。3000 が埋まっていると 3001 を使った。WXT は 3000〜3010 から空きを選び、`strictPort: true` で Vite を起こす。https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/src/core/resolve-config.ts
- 【実機】dev の manifest は production の manifest に次を足す。
  - `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval' http://localhost:3000; object-src 'self';`
  - permissions の `tabs`・`scripting`、host_permissions の `http://localhost/*`
  - command の `wxt:reload-extension`（Alt+R）
  - 出典: https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/src/core/utils/manifest.ts
- Chrome は unpacked の拡張に限り、`script-src` に localhost の source を書くことを許す。https://developer.chrome.com/docs/extensions/develop/migrate/improve-security
- 【実機】dev の HTML に inline script は無い。plugin-react の preamble（`injectIntoGlobalHook(window)` など）は `http://localhost:3000/@id/virtual:wxt-inline-script?<hash>` の module になり、`/@vite/client` と `main.tsx` も dev server の絶対 URL で読む。WXT の `devHtmlPrerender` は「Extension CSP blocks inline scripts」として、`script:not([src])` をすべて virtual module に置き換える。React に固有の処理ではないので、`@wxt-dev/module-react` が無くても効いた。https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/src/core/builders/vite/plugins/devHtmlPrerender.ts
- 【実機】headless の Brave で、tab で開いた `chrome-extension://<id>/sidepanel.html` と、`chrome.sidePanel.open()` で開いた side panel の両方を見た。side panel は CDP の `Runtime.evaluate` を `userGesture: true` で呼んで開いた。App.tsx を編集すると count を保ったまま見出しが変わり、新しい Tailwind の class（`text-red-600`）の CSS も届いた。console と page の error は 0 件。
- 【実機】`bun run dev` は `wxt` の bin を shebang どおり node で起こした。vite の bin も同じで、既存の apps の `vite build` も node で動いている。WXT の engines は `node >=22`・`bun >=1.2.0`。
- 【実機】web-ext は optional peer なので入れていない。WXT は手動の runner に倒れ、`Load ".output/chrome-mv3-dev" as an unpacked extension manually` と出した。Brave を自動で起こすなら `webExt.binaries` に Brave の path を書く（issue #1947）。https://github.com/wxt-dev/wxt/issues/1947 ／ https://wxt.dev/guide/essentials/config/browser-startup.html
- 0.21 の upgrade guide は `webExt.enabled: false` と書いているが、型と code が読むのは `webExt.disabled`。https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/docs/guide/resources/upgrading.md

### CRXJS

- 【実機】`vite`（dev）は `dist/` に manifest、`service-worker-loader.js`、loading page を書く。manifest の CSP は変えない。`web_accessible_resources` に、`<all_urls>` に対する `**/*` と `*` を足す。
- 【実機】`service-worker-loader.js` は `import 'http://localhost:5199/@vite/env'`、`@crx/client-worker`、`/src/background.ts` の 3 行の remote import。Brave でこの service worker は動き、`chrome.sidePanel.getPanelBehavior()` が `openPanelOnActionClick: true` を返した。
- 【実機】dist の `src/sidepanel/index.html` は「CRXJS DEV MODE」の loading page で、service worker が fetch を握った後に dev server の HTML に置き換わる。その HTML の script は `<script src="@crx/inline-script/src/sidepanel/index?t=…">` 1 本だけ。この module が preamble を流し、`/src/sidepanel/main.tsx` を dynamic import する。https://github.com/crxjs/chrome-extension-tools/blob/d2894726d0e4ab6d3f285bb4d8f27c53dd632192/packages/vite-plugin/src/node/plugin-htmlInlineScripts.ts ／ https://github.com/crxjs/chrome-extension-tools/blob/d2894726d0e4ab6d3f285bb4d8f27c53dd632192/packages/vite-plugin/src/client/es/loading-page-script.ts
- 【実機】page の script はすべて `chrome-extension://<id>/…` の URL で読まれた。service worker の fetch handler が自分の origin への request を `localhost:<port>` に中継し、extension の origin の response として返す。source のコメントは「Chromium は custom CSP を無視するので、extension の origin の response を作って CSP を回避する」と書く。https://github.com/crxjs/chrome-extension-tools/blob/d2894726d0e4ab6d3f285bb4d8f27c53dd632192/packages/vite-plugin/src/client/es/hmr-client-worker.ts
- 【実機】tab と side panel の両方で、App.tsx と Tailwind の class の編集が count を保ったまま反映された。`packages/ui` の編集も HMR された。console には `[vite] Direct websocket connection fallback` の info が出た。error は 0 件。
- 【実機】dev と build が同じ `dist/` を書く。dev の後に `vite build` すると、dist は loading page の無い production の中身に置き換わった。
- CRXJS は `chrome-extension://` と `moz-extension://` を Vite の `server.cors` に自動で足す（2.6.0 から）。https://github.com/crxjs/chrome-extension-tools/blob/d2894726d0e4ab6d3f285bb4d8f27c53dd632192/packages/vite-plugin/src/node/plugin-extensionCors.ts

### 両方

- 【実機】background を編集すると、どちらも拡張を reload した。WXT は `Reloaded extension`、CRXJS は `page reload src/background.ts` と出し、service worker が新しい target として起き直した。CRXJS では、tab で開いていた extension page が `chrome://newtab/` に変わった。WXT ではこれを見ていない。
- 【実機】新しい profile では開発者モードが off になっている。`--load-extension` で読んだ拡張は最初は動くが、reload の後に「ウェブストアで確認できないこの拡張機能を使用するには、開発者モードをオンにしてください」と出て無効になった。開発者モードを on にすると有効に戻り、その後の reload では有効のまま新しい service worker が起きた。WXT と CRXJS で同じだった。
- 同じ `key` の拡張は同じ ID になる。WXT の `.output/chrome-mv3-dev` と `.output/chrome-mv3` は、別の dir だが同じ ID を持つ。

## build

### WXT

- 【実機】`.output/chrome-mv3/` に `manifest.json`、`sidepanel.html`、`background.js`、`chunks/sidepanel-<hash>.js`、`assets/sidepanel-<hash>.css` が出た。HTML に inline script は無い。
- 【実機】manifest は `key`、`action`、`background.service_worker: "background.js"`、`side_panel.default_path: "sidepanel.html"`、`permissions: ["sidePanel"]`。side_panel と permission は `entrypoints/sidepanel/index.html` から足された。Firefox では `sidebar_action` を書く。https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/src/core/utils/manifest.ts ／ https://wxt.dev/guide/essentials/entrypoints.html
- 【実機】`version` を package.json にも `wxt.config.ts` にも書かないと、warning を出して `0.0.0` にする。
- `key` は専用の設定を持たず、`manifest: {…}` の他の field と同じく合成される。https://wxt.dev/guide/essentials/config/manifest.html
- 出力の dir は `outDir`（既定 `.output`）と `outDirTemplate`（既定 `{{browser}}-mv{{manifestVersion}}{{modeSuffix}}`）で決まる。`wxt zip` は build して zip を作る。https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/src/types.ts
- 【実機】`bun run --cwd apps/extension-wxt build` は 0.2〜1.2 秒。

### CRXJS

- 【実機】`dist/` に `manifest.json`、`service-worker-loader.js`（`import './assets/background.ts-<hash>.js';` の 1 行）、`src/sidepanel/index.html`、`assets/index.html-<hash>.js`、`assets/background.ts-<hash>.js`、`assets/index-<hash>.css` が出た。HTML に inline script は無い。
- 【実機】manifest は `defineManifest` に書いたものに、`background.service_worker` を `service-worker-loader.js` に置き換えたもの。`sidePanel` の permission は足さない。CRXJS の template も `permissions: ['sidePanel']` を自分で書いている。https://github.com/crxjs/create-crxjs/blob/main/templates/react-ts/manifest.config.ts
- 【実機】`dist/.vite/manifest.json` は残らない。CRXJS は build の間 `build.manifest` を立て、利用者が指定していなければ最後に消す。https://github.com/crxjs/chrome-extension-tools/blob/d2894726d0e4ab6d3f285bb4d8f27c53dd632192/packages/vite-plugin/src/node/plugin-webAccessibleResources.ts
- zip を作る機能は無く、docs は `vite-plugin-zip-pack` を使う。browser を起こす runner も無い。https://crxjs.dev/guide/packaging
- 【実機】`bun run --cwd apps/extension-crxjs build` は 0.1〜0.6 秒。

### key

- Chrome の docs は、`key` が開発中の unpacked の拡張の ID を保つと書き、鍵の取り方として Developer Dashboard の「View public key」だけを挙げる。Web Store を使わない場合の手順は書いていない。https://developer.chrome.com/docs/extensions/reference/manifest/key
- 【実機】openssl で作った公開鍵の DER を base64 にして書くと、ID はその sha256 の先頭 32 桁を `a`〜`p` に写した値になった。

## TypeScript 7

- 【実機】tsc 7.0.2 で、root の tsconfig が両方の app を含めて通った。oxlint の type-aware（tsgolint 7.0.2003）も通った。
- TS 7.0 は `baseUrl`、`moduleResolution: node10`、`target: es5`、`downlevelIteration`、`esModuleInterop: false` などを受け付けない。JS の API も持たない。https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- WXT が生成する `.wxt/tsconfig.json` は `baseUrl` を使わず、`paths` を `.wxt/` からの相対で書く。0.21 で `esModuleInterop` などを外し、`module: Preserve` と `verbatimModuleSyntax` に変えた。https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/docs/guide/resources/upgrading.md ／ https://github.com/wxt-dev/wxt/issues/2449
- 【実機】`tsc -p apps/extension-wxt/.wxt/tsconfig.json` は option についての error を出さなかった。出たのは `jsx` が無いことによる TSX の error だけ。
- 【実機】WXT と CRXJS の配布物は `typescript` を import しない（dist を grep した）。WXT の peer の `typescript >=5.4` は optional。
- CRXJS の template の `tsconfig.app.json` は `baseUrl: "."` を使っていて、TS 7 では通らない。monica は template の tsconfig を使わないので関係しない。https://github.com/crxjs/create-crxjs/blob/main/templates/react-ts/tsconfig.app.json
- TS 7 や tsgo についての issue は、どちらの repo にも見つからなかった。

## 依存

- 【実機】bun.lock の package の数は、main の 321 から、WXT を足して 432（+111）、CRXJS と @types/chrome を足して 453（+21）になった。
- 【実機】Vite は両方とも catalog の 8.3.2 を 1 つだけ使った。
- WXT 0.21.4 は `vite` を必須の peer（`^6.3.4 || ^7.0.0 || ^8.0.0-0`）にし、`typescript`・`web-ext`・`eslint` を optional の peer にする。dependencies に `@wxt-dev/browser`、`@wxt-dev/storage`、`unimport`、`linkedom`、`publish-browser-extension` などを持つ。https://www.npmjs.com/package/wxt
- CRXJS 3.0.0 の peer は `vite`（3〜8）だけで、dependencies に `rollup 2.80.0` と `rxjs 7.5.7` を固定の版で持つ。3.0.0 は ESM だけになった。GitHub の Release は 2.7.0 までで、3.0.0 は CHANGELOG にだけある。https://www.npmjs.com/package/@crxjs/vite-plugin ／ https://github.com/crxjs/chrome-extension-tools/blob/main/packages/vite-plugin/CHANGELOG.md
- Vite 8 の bundled dev mode について、CRXJS の 3.0.0 は content script の対応を CHANGELOG に書くが、同じ mode で落ちる open の issue（#1218）がある。MV3 の service worker の top-level の dynamic import が Vite 8 で落ちる issue（#1235）も open。どちらも今回の形には出なかった。https://github.com/crxjs/chrome-extension-tools/issues/1218 ／ https://github.com/crxjs/chrome-extension-tools/issues/1235

## 確かめていないこと

- 普段使いの Brave の profile に chrome://extensions から読み込む形。今回は新しい profile だけを使った。
- headed の Brave で action のクリックから side panel を開くことと、Brave の sidebar が一緒に出る件（brave-browser#51271）。side panel は CDP から `chrome.sidePanel.open()` で開き、headless で中身を見た。
- WXT の runner（web-ext）で Brave を自動で起こす形。
- CI（ubuntu-latest）での `check:ts`。手元の macOS で fresh install から流しただけで、runner の Node の版が WXT の engines（`node >=22`）を満たすかも見ていない。
- 複数の worktree で dev を同時に起こしたときの port と拡張の ID。WXT は 3000〜3010 から空きを選び、CRXJS は Vite の `server.port` に従う。同じ `key` の拡張は同じ ID になる。
- Vite 8 の bundled dev mode と content script。どちらも今回の範囲の外。
