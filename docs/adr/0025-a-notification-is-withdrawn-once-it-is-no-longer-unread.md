---
status: accepted
---

# release の通知を未読に揃え、未読でなくなったら通知センターから取り下げる

ADR-0022 で release の Shell は UNUserNotificationCenter で通知を出すようになったが、出した通知は取り下げず（ADR-0013）、request identifier を通知ごとに変えるので、待ちのたびに通知センターに 1 件ずつ積もる。Tab を見た後も待ちが解けた後も残り、どれがまだ見ていない待ちかを通知センターでは見分けられない。そこで release では、request identifier を Terminal Session の id にして同じ Terminal Session の通知を新しい通知で置き換え、その Agent Session が未読でなくなったら（見た、待ちが解けた、終了した）通知センターから取り下げる。終了でない Agent Session は 1 つの Terminal Session に 1 つまでなので、通知センターの monica の通知は未読の Agent Session と 1 対 1 になる。揃えるのは未読から通知への片方向で、通知センターで通知を消しても見たことにはしない（`docs/research/macos-notification-removal.md`）。

## Considered Options

- **見た時だけ取り下げる**: 見ないまま待ちが解けた Agent Session（claude が終わった、Tab を閉じた）の通知が残り、通知が未読より多くなる。
- **request identifier を通知ごとに変えたまま、未読でなくなったらその Terminal Session の通知をすべて取り下げる**: 同じ待ちの間にも通知は何度も出る（許可は求められるたびに出す）ので、未読の間は通知が未読より多い。
- **request identifier を Agent Session の id にする**: 未読と同じ単位になるが、終了でない Agent Session は Terminal Session に 1 つまでなので数は変わらない。notify の行に Agent Session の id を足すことになり、クリックにはどのみち Terminal Session の id が要る。
- **通知センターで消した通知を見たことにする**（category の CustomDismissAction）: 届くのは 1 件を × で消した時で、stack を Clear All で消すと 1 件分しか届かないという報告がある。両方向に揃えようとしても揃わず、Tab を見ていないのに見たことになる場合が混ざる。
- **dev でも取り下げる**: dev は .app の外で tauri-plugin-notification（NSUserNotificationCenter、Terminal.app の名義）で出し、この経路には届いた通知を取り下げる口が無い。dev を .app に包む案は ADR-0022 が退けた。

## Consequences

- 同じ Terminal Session の通知を置き換えると、system はもう一度 alert し、一覧の先頭に置く。notify は新しい待ちのたびに出すので、alert の回数は今と変わらない。
- 未読でなくなる瞬間を知っているのは Backend だけなので、Backend が未読の Agent Session の居る Terminal Session の id の集合を Shell に渡し、Shell が通知センターをそれに合わせる。出来事ではなく集合を渡すのは、Backend の再起動や desktop を閉じていた間をまたいでも、次に渡した集合で揃うため。
  - 集合は Dock の数と同じ数え直しから出す。
  - Shell は前の集合から抜けた id の通知を取り下げる。
  - Backend とつながって最初の集合では、通知センターの通知を読み、`userInfo` の `terminalSessionId` が集合に無いものを取り下げる。前の起動で出した通知と、この ADR より前の identifier で出た通知はこれで消える。
- Backend が居ない間、Shell は通知を取り下げない。Dock の数と違い、残った通知はクリックで Tab に移れるため。respawn した Backend の最初の集合で揃う。
- 取り下げは非同期で、終わりを知る手段が無い。表示中のバナーや Persistent の alert まで消えるかは確かめていない。
- 通知が未読より少ない場合は残る。通知センターで手で消した、通知の許可が無い、通知センターに出さない設定にした、投稿に失敗した、古い通知が見えなくなった、のどれでも、sidebar と Dock の数には未読が残る。
- ADR-0013 の「出した通知は取り下げない」を、release ではこの ADR が置き換える。dev は今までどおり取り下げない。
