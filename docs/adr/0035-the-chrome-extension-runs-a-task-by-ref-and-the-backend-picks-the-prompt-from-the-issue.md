---
status: accepted
---

# Chrome Extension は ref だけを渡して Task を run し、prompt は Backend が Issue から決める

GitHub の Issues の一覧から Run を起こしたい。ADR-0034 は Chrome Extension に chat だけの token を渡し、task には 401 を返す。`task.run` は prompt を受け取って `claude '<prompt>'` を Bench の Tab に打つので、Chrome Extension の script がこれを呼べると shell に届く。そこで token の口のうち Chrome Extension の token で通る procedure に、task の 2 つを足す。ref 群を受け取り各 Issue の Run Button を返す `runButtons` と、ref 1 つと押した時に出ていた Run Button の状態を受け取り押下を行う `press` だけで、どちらも prompt を受け取らない。prompt は Backend が押下の時点で GitHub から Issue を引き直して決める。Chrome Extension の script ができるのは、決まった prompt で、run を断られない Issue を run することまでになる。

ボタンと prompt は Issue のラベル・sub-issue・Blocker で決める。

| Issue | prompt |
|---|---|
| `ready-for-agent` で open な子が無い | なし（ADR-0024 の `/tackle`） |
| `ready-for-agent` で open な子がある（spec） | `/implement-spec #<n>` |
| `needs-triage`、または state のラベルが無い | `/triage #<n>` |
| `wayfinder:map` | `/wayfinder <n>` |
| `wayfinder:*` の子 | `/wayfinder <map> <n>` |

新しい Run を起こす Issue のうち、closed な Issue、open な Blocker がある Issue、`ready-for-human`・`needs-info`、子が全部 closed の spec、親の無い `wayfinder:*` の子には、ボタンを出さない。live な Run を持つ spec の子には、新しい Run だけでなく resume のボタンも出さない。spec の Run が子を実装している間に子の Run を起こすと、resume でも同じ子に 2 つの agent が動くため。CLI の `run` も同じ規則で断る（ADR-0024）。

## Considered Options

- **全権の token を渡す**: ADR-0034 で採らなかった理由のまま。
- **Chrome Extension が prompt か prompt の種類を送る**: 種類の enum に絞っても、古い画面のボタンが今の Issue に合わない prompt を打つ。ラベルの解釈が DOM と Backend の 2 箇所に分かれる。
- **Native Messaging の host（CLI）が全権の token で `task.run` を代わりに呼ぶ**: token は Chrome Extension に出ないが、run の判断が CLI に散り、ボタンの状態を出す読み取りは別に要る。
- **Run Button の状態ごとに押下の procedure を分ける（`runFromButton`・`reopenFromButton`）**: 状態を足すたびに contract・Backend の口の一覧・Chrome Extension の relay と描画を揃えて直し、押した時に守ること（Issue の引き直し、node ID での引き当て、transaction の中の見直し）を procedure ごとに書き直すことになる。Reopen を足した #314 で、守ることの漏れが review で 3 度見つかった。
- **`press` が ref だけを受け取る**: 押した後に状態が変わると、Reopen を押したのに Run が起きて claude が動き出す。

## Consequences

- token の口の Chrome Extension の token は chat だけのものでなくなる。task の他の procedure と workbench・job には今までどおり 401 を返す。
- Track していない Issue は Sync の対象でないので、ボタンを決めるときは Track せずに GitHub から引く。run したときに ADR-0024 のとおり Track する。
- run は確認を挟まない。止めたいときは Tab を閉じ、Bench の最後の Tab で Task を close する（ADR-0012）。
- ボタンは Task の状態を映す。live な Run があれば押せず、終わった Run があれば resume になると示す。resume では ADR-0024 のとおり `/tackle` を送らない。この 2 つは open な Blocker より先に当てる。Blocker は新しい Run だけを止め、resume は止めない（ADR-0024）ので、CLI の `run` と同じ答えになる。
- closed な Task には reopen のボタンを出し、押すと Task を reopen するだけで Run は起こさない。
- `press` は押した時に Issue を引き直して判定をやり直し、受け取った状態と違えば何もせずに断る。状態は `Run`・`Resume`・`Reopen` のどれかで、prompt を受け取らないので shell に届かない。
- `press` は、押下を行っても断っても、その行に次に出す Run Button を `runButtons` の 1 行と同じ形で返し、Chrome Extension はそれで描き直す。error で返すのは Backend か GitHub に届かないときだけ。
- 古い Chrome Extension と開いたままのページの content script は、Chrome Extension とページを reload するまで消えた procedure を呼び、断られる。互換の口は残さない。
- 守らないもの: GitHub のページの script が Chrome Extension の差し込んだボタンを押すこと。content script は `isTrusted` のクリックだけを通すが、Issue のラベルを書ける人は prompt の種類を選べる。
