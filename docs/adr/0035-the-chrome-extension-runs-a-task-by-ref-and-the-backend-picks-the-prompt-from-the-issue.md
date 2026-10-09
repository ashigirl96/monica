---
status: accepted
---

# Chrome Extension は ref だけを渡して Task を run し、prompt は Backend が Issue から決める

GitHub の Issues の一覧から Run を起こしたい。ADR-0034 は Chrome Extension に chat だけの token を渡し、task には 401 を返す。`task.run` は prompt を受け取って `claude '<prompt>'` を Bench の Tab に打つので、Chrome Extension の script がこれを呼べると shell に届く。そこで token の口のうち Chrome Extension の token で通る procedure に、task の 2 つを足す。ref 群を受け取り各 Issue の Run ボタンを返すものと、ref 1 つを受け取り run するものだけで、どちらも prompt を受け取らない。prompt は Backend が run の時点で GitHub から Issue を引き直して決める。Chrome Extension の script ができるのは、決まった prompt で、run を断られない Issue を run することまでになる。

ボタンと prompt は Issue のラベル・sub-issue・Blocker で決める。

| Issue | prompt |
|---|---|
| `ready-for-agent` で open な子が無い | なし（ADR-0024 の `/tackle`） |
| `ready-for-agent` で open な子がある（spec） | `/implement-spec #<n>` |
| `needs-triage`、または state のラベルが無い | `/triage #<n>` |
| `wayfinder:map` | `/wayfinder <n>` |
| `wayfinder:*` の子 | `/wayfinder <map> <n>` |

open な Blocker がある Issue、`ready-for-human`・`needs-info`、子が全部 closed の spec、親の無い `wayfinder:*` の子、live な Run を持つ spec の子には、ボタンを出さない。

## Considered Options

- **全権の token を渡す**: ADR-0034 で採らなかった理由のまま。
- **Chrome Extension が prompt か prompt の種類を送る**: 種類の enum に絞っても、古い画面のボタンが今の Issue に合わない prompt を打つ。ラベルの解釈が DOM と Backend の 2 箇所に分かれる。
- **Native Messaging の host（CLI）が全権の token で `task.run` を代わりに呼ぶ**: token は Chrome Extension に出ないが、run の判断が CLI に散り、ボタンの状態を出す読み取りは別に要る。

## Consequences

- token の口の Chrome Extension の token は chat だけのものでなくなる。task の他の procedure と workbench・job には今までどおり 401 を返す。
- Track していない Issue は Sync の対象でないので、ボタンを決めるときは Track せずに GitHub から引く。run したときに ADR-0024 のとおり Track する。
- run は確認を挟まない。止めたいときは Tab を閉じ、Bench の最後の Tab で Task を close する（ADR-0012）。
- ボタンは Task の状態を映す。live な Run があれば押せず、終わった Run があれば resume になると示す。resume では ADR-0024 のとおり `/tackle` を送らない。
- closed な Task には reopen のボタンを出し、押すと Task を reopen するだけで Run は起こさない。そのため Chrome Extension の token で通る task の procedure に `reopenFromButton` を足す。run と同じく押した時に Issue を引き直して判定をやり直し、ref だけを受け取り prompt を受け取らないので、shell に届かない。
- 守らないもの: GitHub のページの script が Chrome Extension の差し込んだボタンを押すこと。content script は `isTrusted` のクリックだけを通すが、Issue のラベルを書ける人は prompt の種類を選べる。
