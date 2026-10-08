---
status: accepted
---

# ブラウザ拡張は notes の口を token 無しで呼び、`Sec-Fetch-Site: none` で見分ける

ブラウザ拡張（`apps/extension`、map #254）の side panel のチャットは Backend を呼ぶ。拡張は `backend.json` を読めないので、ADR-0007 の token の口はそのままでは使えない。そこで ADR-0017 の notes の口を拡張にも開き、GET 以外の request で `Sec-Fetch-Site: same-origin`（apps/web）に加えて、`Sec-Fetch-Site: none` と `Sec-Fetch-Mode: cors` の組（拡張）を通す。拡張が host_permissions に書いた loopback の host へ送る request は、side panel・拡張の page・service worker のどれからでもこの組になり、web ページの fetch はこの組を作れない（#259）。守らないのは、loopback か `<all_urls>` の host permission を持つ他の拡張と、同じ Mac の他のユーザーと process（ADR-0017）。他の拡張は `none` を作れ、Origin も偽れる見込みだが、その拡張はログインしたままの claude.ai や GitHub のページをすでに読めるので、チャットと note を呼べるようになっても失うものは小さい。ADR-0017 の「token の無い口に、shell や command に届く procedure を載せない」は変えない。workbench・task・job は載せず、チャットの agent に持たせる tool も、token の無い口から起こしてよいものに限る。notes の口にはチャットの router も載るので、呼び名を「ブラウザの口」に改める。

## Considered Options

- **Native Messaging で token を渡す**: 拡張が native host（CLI の binary を `chrome-extension://` の引数で起こしたもの）から `backend.json` の port と token を受け取り、token の口を bearer で呼ぶ。ブラウザが host manifest の `allowed_origins` で monica の拡張の ID だけに host を許すので、他の拡張は token を得られず、workbench・task・job も呼べる。代わりに host manifest を `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` に置く手順（Brave はここしか読まない）、dev の home ごとの host 名とそれを焼いた dev の拡張、Backend の再起動で token が変わったときの問い合わせ直しが要る。増える守りは他の拡張に対してだけで、その相手はすでにページを読める。この形はブラウザの口と両立するので、拡張から Run を起こしたくなったときに足す。
- **拡張専用の 3 つ目の口**: 照合はブラウザの口と同じで、port が 1 つ増えるだけ。
- **`file://` で `backend.json` を読む**: 拡張の設定で file URL への access をユーザーが手で許し、拡張が home の path を知る必要がある。読めるかも確かめていない。
- **Origin の拡張 ID を照合する**: 拡張の page と service worker は `Origin` を書き換えられた（#259）。他の拡張も偽れる見込みで守りにならず、dev と release の ID の一覧を持つ手間だけが残る。

## Consequences

- `none` は `Sec-Fetch-Mode: cors` と組のときだけ通す。user が起こす navigation にも `none` が付くので、mode が `navigate` の POST を外すため。
- 拡張は `http://127.0.0.1:<port>` を呼ぶ。port を書かない `http://127.0.0.1/*` の match pattern は全 port に効く（#259）。`*.localhost` の pattern は確かめていない。
- release の拡張は 19380 を呼ぶ。dev の拡張は、apps/web の Vite と同じく `devInstance(MONICA_HOME || ~/.monica-dev)` の port を build 時に焼き、release の 19380 には倒さない。
- 回答は oRPC の event iterator で流す。1 回の質問への応答の stream で、回答が終われば閉じ、client は payload の文字をそのまま描く。contract の規約 5 の change stream（「変わった」の合図を流し、購読側が読み直す）とは別の種類になる。
- RPC は side panel の page から呼び、service worker を経由しない。service worker は stream を受けていても、最後の拡張の event から 30 秒で止まる（#259）。
- side panel を閉じると、約 0.4 秒で handler の `signal` が abort する（#259）。そのとき agent の turn を止めるかは、agent の動かし方で決める。
- side panel ごとに張り続ける購読は持たず、stream は回答の間だけ開く。窓ごとの side panel が張り続けると、ADR-0017 の 6 本の上限で詰まるため。
