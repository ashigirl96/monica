---
status: accepted
---

# Chrome Extension は CRXJS で Vite の plugin として組み、ID は release と dev の 2 つの key で固定する

Chrome Extension（`apps/extension`、map #254）は Brave の side panel で動き、unpacked の読み込みだけで配る。組む道具の候補は WXT 0.21.4 と CRXJS（`@crxjs/vite-plugin` 3.0.0）で、どちらも root の tsconfig 1 つ・TS 7・catalog・`check:ts` の中で通り、side panel で state を保った HMR が効いた（#260）。CRXJS を採る。CRXJS は Vite の plugin 1 つなので、Chrome Extension も apps/web と apps/desktop と同じく `vite` と `vite build` で起き、dev server の port も `devInstance` の規則に乗る。bundler は Vite 1 つのまま保てる（ADR-0017）。依存は +21 package で、WXT の +111 の 5 分の 1。WXT が持つ entrypoint の規約、Firefox 向けの出力、zip、web-ext の runner は、Brave に unpacked で入れるだけの Chrome Extension にはほぼ要らない。

## Considered Options

- **WXT**: 依存が +111 package。生成型の `.wxt` を `postinstall` で作って root の tsconfig の include に足す必要があり、entrypoint を変えると作り直すまで tsc が古い型を読む。既定の auto-import は `browser` などを apps/web からも global に見せるので切る必要がある。bin は node の shebang で engines が `node >=22` だが、CI の ts job は setup-node を持たず、runner の Node の版は分からない。maintainer は 1 人で 0.x。API を `wxt/browser` から import して `chrome` の global を持たない点と、dev と build の出力の dir が分かれている点は CRXJS より良い。
- **Plasmo**: 保守が止まっている。

## Consequences

- `@types/chrome` の global の `chrome` は、tsconfig が 1 つなので apps/web と apps/desktop でも型が付く。oxlint の `no-restricted-globals` で、apps/extension と chat の ui（`packages/chat/src/ui`）の外の `chrome` を止める。chat の ui は Chrome Extension の side panel でだけ動き、Current Page を追うのとページを読むのに `chrome.*` を直に呼ぶ。workbench の ui が Shell の command を直に呼ぶのと同じ形で、apps/extension は組み立てるだけにする（ADR-0002）。
- manifest は `defineManifest` に手で書き、permission も自分で足す。`permissions` の typo は型で止まらない（3.0.0 の d.ts が参照する型が @types/chrome 0.3.4 に無く、`skipLibCheck` の下で任意の string が通る）。
- CRXJS は dev と build が同じ `build.outDir` に書くので、mode で dir を分ける。分けないと、`check:ts` の build が、dev で読み込んでいる Chrome Extension を production の中身に置き換える。
- dev の出力には dev server の port が焼き込まれ、dev server が別の port で起き直すと、Chrome Extension を reload するまで繋がらない。そこで port は `devInstance` が home から決め（既定の home は 19781、ほかは 19782〜19881）、`strictPort` で起こす。空いている別の port には移らない。
- dev の Chrome Extension は、`bun run extension` が Vite と一緒に起こす Brave で動かす。Brave は home ごとの user-data-dir（`$MONICA_HOME/dev-brave/`）で起こし、dev の出力を `--load-extension` で読み込ませる。新しい profile は開発者モードが off で、reload すると unpacked で読み込んだものが無効になるので、script が Brave 自身に開発者モードを書かせる。同じ profile で headless の Brave を一度起こし、`brave://extensions` で `chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })` を呼ぶ。`Default/Preferences` の file に書いても、Brave は `Secure Preferences` の MAC で守られたこの pref を既定に戻す（Brave 1.97）。`--disable-features=ExtensionDisableUnsupportedDeveloper` でも無効にならずに済むが、feature flag は予告なく消えうるので使わない。普段の Brave には release の Chrome Extension だけを入れる。
- Chrome Extension の ID は manifest の `key` で固定し、release と dev で別の `key` を持つ。`key` が無いと ID は読み込んだ dir の path から決まり、読み込む場所を移すと別の ID になって `chrome.storage` を失う。dev の ID はすべての worktree で同じだが、home ごとの profile に 1 つずつしか入らないのでぶつからない。dev を普段の Brave に読み込んでも、release を置き換えずに並ぶ（同じ ID のものは、後から読んだ方が前のものを置き換える）。Backend は ID を照合しない（ADR-0028）が、Native Messaging を足すときは host manifest の `allowed_origins` に固定の ID が要る。
- 秘密鍵は持たない。unpacked の読み込みには要らず、要るのは `.crx` に固めるときだけのため。
- release の Chrome Extension は `bun run build` が build し、`install-app` が `Monica.app/Contents/Resources/extension` に置く。ユーザーは一度だけそこを unpacked で読み込む。Brave は unpacked で読み込んだものを自分では読み直さないので、`install-app` の後は手で reload する。
- CI に setup-node は足さない。Chrome Extension の `vite build` は apps/web と同じ Node で動く。
- ブラウザを使うテストは `check:ts` と CI に入れない。CI の runner に Brave は無い。Chrome Extension の確かめは、desktop と notes の画面と同じく skill で行い、headless の Brave を agent-browser か CDP で操作する。
- 3.0.0 は GitHub の Release に無く、CHANGELOG にだけある。Vite 8 で開いたままの issue が 2 つある（bundled dev mode の crxjs/chrome-extension-tools#1218、service worker の top-level dynamic import の crxjs/chrome-extension-tools#1235）。今の形では出ていない。保守が止まったら WXT に移す。Chrome Extension の中身は素の Vite と `chrome.*` なので、entrypoint の dir に並べ直す作業になる。
