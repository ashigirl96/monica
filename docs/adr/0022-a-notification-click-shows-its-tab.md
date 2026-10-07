---
status: accepted
---

# 通知のクリックでその Tab を表示する。release の Shell は UNUserNotificationCenter で通知を出す

ADR-0013 は tauri-plugin-notification で通知を出し、クリックは OS の既定どおり tania を前面に出すだけにした。v1 の基準は「待ちに気づく」だったが、気づいた後に sidebar で Runspace → Tab の順に探す手間が残る。そこで、通知をクリックしたら、その通知を出した Agent Session が居た Tab を表示する。Tauri の範囲には、通知のクリックと識別子を Rust で受け取る release 済みの手段が無い（`docs/research/tauri-notification-click.md`）。そのため、.app の中で動く release の Shell は、objc2-user-notifications で UNUserNotificationCenter を直接使う。通知の `userInfo` に Terminal Session の id を載せ、center の delegate の `didReceive` で受け取り、webview に渡す。webview はその Terminal Session を表示している Tab を選ぶ。.app の外で動く dev の Shell は今までどおり plugin で出し、クリックしても Tab に移らない。

## Considered Options

- **公式 plugin の PR #3671（desktop の action）を待つ**: merge されれば Rust の `on_action` に `extra` 付きで届く。ただし macOS では action を付けた通知に限られ、通知にボタンが出る。届くのも通知を出した process が生きている間だけである。
- **mac-notification-sys の `wait_for_click` を Shell から直接呼ぶ**: 依存は増えず、今の NSUserNotificationCenter の経路のまま本文のクリックを受けられる。しかし識別子は process の memory にしか無く、再起動した後に通知センターの古い通知を押しても Tab に移れない。押されずに通知センターに残った通知の数だけ、thread と main run loop の 0.5 秒おきの確認が積もる。手空きは turn のたびに出るので、すぐ数十件になる。
- **Choochmeque の tauri-plugin-notifications**: クリックは webview にしか届かず、Rust には届かない。窓が隠れている間は webview の JS が止まる（ADR-0013）。UNUserNotificationCenter を使う Swift の backend は、.app の外の `tauri dev` で起動時に panic する。
- **user-notify**: UNUserNotificationCenter を包んだ crate だが、LGPL-3.0 で、通知の identifier を自分で決められず、manager を手放すと panic する。
- **dev も .app に包んで UNUserNotificationCenter で出す**: dev でもクリックが効くが、dev loop に手が入り、home ごとの dev の instance がそれぞれ通知の許可を求める。

## Consequences

- Backend が stdout に書く notify の行に、通知を出した Agent Session の `terminalSessionId` を足す。Shell はそれを通知の `userInfo` に載せる。
- 識別子は Tab ではなく Terminal Session の id にする。Tab を別の Runspace へ移しても変わらず、通知を出す時点で Agent Session の行が持っているため。claude が終わって shell だけが残った Tab にも移れる。クリックした時にその Terminal Session を表示する Tab が無ければ（Tab を閉じた、Terminal Session が終わった、pin の張り直しで Terminal Session が替わった）、Tab は選ばず、OS が tania を前面に出すだけになる。
- delegate は Tauri の `setup` で置く。`setup` は `applicationDidFinishLaunching:` の中で同期的に走り、Apple が求める「起動完了の前」に間に合う。tania が起動していない間に通知センターの通知を押して起こした場合も、クリックは `didReceive` に届く。ptyd は tania より長生きする（ADR-0011）ので、同じ Tab に移れることがある。webview が listen を張る前に届いたクリックは Shell が持っておき、webview が後から訊く。
- .app の外の process で `currentNotificationCenter` を呼ぶと、catch できない例外で abort する。Shell は main bundle が .app かどうかで経路を分け、.app の外では UNUserNotificationCenter に触らない。
- release は初回の起動で通知の許可を求める。Keychain の自己署名 identity で codesign した .app で許可が通り、クリックで `userInfo` が届くことを確かめた。release は通知を出すのに plugin を使わない。
- tania が前面の間は、今までどおりバナーを出さず通知センターにだけ入れる（`willPresent` で list だけを返す）。前面では sidebar の未読と status dot が代わりになる。
- 通知の request identifier は Shell が決められるので、待ちが解けたら取り下げる、同じ Tab の古い通知を置き換える、を後から足せる。この ADR では足さない。
- ADR-0013 のうち、クリックは tania を前面に出すだけで Tab には移らない、という帰結をこの ADR が置き換える。判定と本文を workbench が持ち、Shell は渡された行を出すだけ、という分担は変えない。
