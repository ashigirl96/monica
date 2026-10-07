# Tauri 2 の macOS で通知のクリックと識別子を受け取る

Agent Session の待ちの通知をクリックしたら、その claude が居る Tab を前面に出したい。そのために、通知のクリックを Shell（Rust）で受け、通知に載せた terminalSessionId を取り出せるかを調べた。調べた版は tauri-plugin-notification 2.5.1 と 3.0.0-alpha.2（plugins-workspace の v2 `65ce65b`、v3 `7e44012`）、同 PR #3671 の head `494b96f`、notify-rust 4.18.2、mac-notification-sys 0.6.15、mac-usernotifications 0.3.1、tauri-plugin-notifications（Choochmeque）0.5.0-rc.14 と 0.4.6、user-notify 0.4.2、tauri 2.12.1、tao 0.37.1。2026-10-08 時点で、macOS 26.6.2。すべてソースと issue を読んで確かめたもので、実機で通知をクリックしての確認はしていない。

## tauri-plugin-notification（公式）の最新

- crates.io の最新は v2 系が 2.5.1（2026-10-01）、v3 系が 3.0.0-alpha.2（2026-09-30）。v2 branch の head `65ce65b` と v3 branch の head `7e44012` の `desktop.rs` は 2.5.1 と同じで、`show()` は notify-rust に渡して結果を捨てるだけ。desktop の command も `notify` / `request_permission` / `is_permission_granted` の 3 つのまま。
  - https://github.com/tauri-apps/plugins-workspace/blob/65ce65bdbb4390f73076c8182fbf06a52036f241/plugins/notification/src/desktop.rs#L203-L245
  - https://github.com/tauri-apps/plugins-workspace/blob/7e44012db3c1ef7896158484a7afc626b04c691a/plugins/notification/src/desktop.rs#L203-L245
  - https://github.com/tauri-apps/plugins-workspace/blob/65ce65bdbb4390f73076c8182fbf06a52036f241/plugins/notification/src/lib.rs#L246-L251
- CHANGELOG の 2.4.0〜2.5.1 と 3.0.0-alpha.0〜alpha.2 に desktop のクリックや action の項目は無い。3.0 の alpha は tauri 3 alpha への追従と MSRV の更新だけ。
  - https://github.com/tauri-apps/plugins-workspace/blob/65ce65bdbb4390f73076c8182fbf06a52036f241/plugins/notification/CHANGELOG.md#L3-L25
  - https://github.com/tauri-apps/plugins-workspace/blob/7e44012db3c1ef7896158484a7afc626b04c691a/plugins/notification/CHANGELOG.md#L3-L14
- 公式 docs は今も "The Actions API is only available on mobile platforms." と書く。
  - https://github.com/tauri-apps/tauri-docs/blob/86f23966da282a29c7ec27e18ce540be70988091/src/content/docs/plugin/notification.mdx#L155
- issue #2150（クリックイベント）は open のまま。最後の動きは 2026-01 で、自前で UN を叩く user-notify を勧めるコメントだった。#2134（2022 年の API 刷新の RFC）は UNUserNotificationCenter への移行を案に挙げたが、当時から "This likely won't change in the short term." とされ、実装は無い。plugins-workspace の issue と PR に `preview-macos-un` や mac-usernotifications を使う話は見つからなかった。推論: 公式 plugin が macOS で UN に移る予定は今のところ無い。
  - https://github.com/tauri-apps/plugins-workspace/issues/2150
  - https://github.com/tauri-apps/plugins-workspace/issues/2134

### open な PR #3671 "feat(notification): report actions on desktop"

- 2026-10-07 に外部の contributor が v2 branch 宛てに出した。review は required のままで、maintainer（FabianLars）のコメントが 1 件あるだけ。covector の予定では 2.6.0 として出る。#2150 と #1903 を閉じる。
  - https://github.com/tauri-apps/plugins-workspace/pull/3671
- desktop に Rust の `Notification::on_action(handler)` と JS の `onAction` を足す。本文のクリックは `actionId: "tap"`、action type のボタンはその action の id で届く。payload の `notification` は `show()` の時点の `NotificationData` を JSON にしたもので、`extra` も入るので、`builder().extra("terminalSessionId", …)` で載せた値を `performed.notification()?.extra()` で読める。
  - https://github.com/haexmas/plugins-workspace/blob/494b96f30826f3b882dbefa05d277260a02e0a29/plugins/notification/src/desktop.rs#L132-L138
  - https://github.com/haexmas/plugins-workspace/blob/494b96f30826f3b882dbefa05d277260a02e0a29/plugins/notification/src/desktop.rs#L222-L236
  - https://github.com/haexmas/plugins-workspace/blob/494b96f30826f3b882dbefa05d277260a02e0a29/plugins/notification/src/models.rs#L383-L386
- handler か listener がある間に出した通知だけを追う。macOS では通知ごとに専用の thread を立て、notify-rust 4.18 の `wait_for_response` でクリックまで block する。payload は thread が握っているだけなので、process が終われば消え、再起動後に通知センターからクリックしても何も届かない。
  - https://github.com/haexmas/plugins-workspace/blob/494b96f30826f3b882dbefa05d277260a02e0a29/plugins/notification/src/desktop.rs#L401-L417
  - https://github.com/haexmas/plugins-workspace/blob/494b96f30826f3b882dbefa05d277260a02e0a29/plugins/notification/src/desktop.rs#L501-L516
- macOS では action の無い通知の本文クリックは届かない。mac-notification-sys はボタン（`main_button` / `close_button`）か `wait_for_click` があるときだけ応答を待ち、notify-rust は `wait_for_click` を立てないので、action が無ければ `wait_for_response` はすぐ `Closed(Expired)` を返し、PR はそれを捨てる（次節）。PR の動作確認は 2 つの action を持つ通知で行っている。Choochmeque の plugin は同じ制約をコメントに書き、"Open" ボタンを足して回避している（後述）。
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/src/notification.rs#L303-L311
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/src/desktop.rs#L285-L307
- dev では今と同じく `set_application("com.apple.Terminal")` を呼ぶ。
  - https://github.com/haexmas/plugins-workspace/blob/494b96f30826f3b882dbefa05d277260a02e0a29/plugins/notification/src/desktop.rs#L450-L457

## notify-rust と mac-notification-sys

- notify-rust の最新は 4.18.2（2026-10-07）。macOS でクリックを受ける API（`NotificationHandle::wait_for_response` / `wait_for_action` / `on_close`）は 4.18.0（2026-06-16）で入った。既定の macOS backend は mac-notification-sys（NSUserNotificationCenter）。
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/CHANGELOG.md#L17-L30
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/src/macos/mod.rs#L1-L38
- この backend の `show()` は何も送らず handle を返す。handle を drop すると非同期で送り、`wait_for_response` を呼ぶと同期で送って応答まで block する。`Click` は `Default`、ボタンは `Action(id)`、応答なしは `Closed(Expired)` になる。docs comment は「main run loop が回っていること」を要件に書いている（Tauri では NSApp の run loop が回る）。
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/src/macos/nsusernotifications.rs#L73-L106
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/src/macos/nsusernotifications.rs#L142-L162
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/src/macos/nsusernotifications.rs#L252-L257
- notify-rust は action が 1 つなら `MainButton::SingleAction`、2 つ以上なら dropdown にするだけで、`wait_for_click` は立てない（コメントアウトされている）。mac-notification-sys は `needs_response()` が偽なら待たずに返る。だから notify-rust 経由で本文クリックを受けるには action を 1 つ以上付ける必要があり、通知にボタンが出る。
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/src/macos/nsusernotifications.rs#L32-L38
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/src/macos/nsusernotifications.rs#L195-L224
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/src/lib.rs#L84
- mac-notification-sys を直接使えば `Notification::wait_for_click(true)` でボタン無しの本文クリックを待てる（PR #70 で追加）。
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/src/notification.rs#L232-L243
  - https://github.com/h4llow3En/mac-notification-sys/pull/70
- 通知の identifier は送るたびの乱数 UUID で、`userInfo` は設定しない。delegate の `didActivateNotification:` は UUID で process 内の待ち表に照らして結果を返し、通知センターから消す。だから識別子は呼び手の closure が持つしかなく、process を跨いでは取り出せない。
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/src/lib.rs#L87-L102
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/objc/notify.m#L251-L293
- main thread 以外から待つと、その thread は condvar で眠り、main run loop に 0.5 秒ごとの timer を足して `deliveredNotifications` から消えたかを見る。クリックされるか、通知センターから消されるまで thread と timer が残る。0.6.12 までは待ちが CPU を 100% 使っていたが 0.6.13 で直った。推論: 触られない通知が通知センターに溜まるほど、待つ thread と main thread の poll が増える。
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/objc/notify.m#L210-L238
  - https://github.com/h4llow3En/mac-notification-sys/issues/86
- `set_application` は process に 1 回だけ効き、`NSBundle` の `bundleIdentifier` を swizzle して main bundle に偽の id を返させる。呼ばずに送ると `"use_default"` という名前の app を探し、見つからず Finder の id になる。
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/objc/notify.h#L26-L44
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/objc/notify.m#L17-L30
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/src/lib.rs#L119-L157
- 偽の id で出した通知のクリックがどこへ行くかは、一次資料が食い違う。mac-notification-sys の example は Safari の id を名乗った bundle の無い process でクリックの結果を受け取る前提で書かれている。terminal-notifier 2.0.0 の README は、`-sender` で送り主を偽ると通知センターはクリックでその app を起動し、送り主自身が受ける `-execute` / `-activate` とは併用できないと書く。推論: dev の process が生きていればクリックは delegate に届き、同時に Terminal.app が起動・前面化される可能性がある。未確認。
  - https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.15/examples/click.rs#L4-L13
  - https://github.com/julienXX/terminal-notifier/blob/2.0.0/README.markdown#L181-L190

### `preview-macos-un`（mac-usernotifications）の経路

- opt-in の feature で、macOS backend を mac-usernotifications 0.3.1（UNUserNotificationCenter）に替える。`Notification` の id が request identifier になり、`wait_for_response` は handle ごとの channel で応答を待つ。
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/Cargo.toml#L28
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/src/macos/unusernotifications.rs#L139-L152
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/src/macos/unusernotifications.rs#L248-L254
- delegate の `didReceive` は process 内の待ち表に無い request を "fire-and-forget" として捨てる。delegate は最初の送信などで起きる worker thread が設定するので、起動が終わった後になる。Apple は delegate を起動完了前に設定するよう求めているので、通知のクリックで起動されたときの応答は取りこぼす。
  - https://github.com/hoodie/mac-usernotifications/blob/v0.3.1/src/delegate.rs#L113-L131
  - https://github.com/hoodie/mac-usernotifications/blob/v0.3.1/src/worker.rs#L14-L33
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate
- bundle の有無は `NSBundle.mainBundle.bundleIdentifier` で確かめる。`set_application` は feature に関係なく re-export され、公式 plugin は dev で `set_application("com.apple.Terminal")` を呼ぶ。推論: 一度 swizzle された process ではこの確認が通ってしまい、bundle の無い dev では `currentNotificationCenter` で abort する。feature は統合されるので、Shell が付ければ plugin も UN 経路になる。
  - https://github.com/hoodie/mac-usernotifications/blob/v0.3.1/src/lib.rs#L236-L244
  - https://github.com/hoodie/notify-rust/blob/v4.18.2/src/lib.rs#L184-L193

## コミュニティの plugin

### tauri-plugin-notifications（Choochmeque）

- MIT。stable は 0.4.6（2026-05-04）、最新は 0.5.0-rc.14（2026-09-16）。main の最終 commit は 2026-10-04。tauri 2 向けで、macOS の backend を feature で選ぶ。既定の `notify-rust` feature は notify-rust 4.18（NSUserNotificationCenter）、`default-features = false` にすると swift-bridge で build する Swift の UNUserNotificationCenter 実装になる。
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/src/lib.rs#L305-L357
- どちらの backend でもクリックは JS の Channel にだけ届く。Rust 向けの handler API は無く、`listeners` module は private。Shell は通知を出せるが、クリックは受けられず、webview が `onNotificationClicked` で `{ id, data }` を受ける。
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/src/listeners.rs#L44-L85
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/guest-js/index.ts#L860-L883
- notify-rust backend（0.5.0-rc.14 にはあり、0.4.6 は click listener を拒む）: `show()` の時点で JS の click listener が有効なら "Open" の action を足して、blocking thread で `wait_for_response` を待つ。本文か "Open" のクリックで `notificationClicked` に `{ id, data: extra }` を送る。listener が有効になる前に出した通知は追わず、cold start の buffer も無いと docs comment に書いてある。dev では公式 plugin と同じく Terminal の名義で出す。
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/src/desktop.rs#L357-L374
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/src/desktop.rs#L517-L528
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/src/desktop.rs#L624-L666
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/src/desktop.rs#L708-L715
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.4.6/src/desktop.rs#L88-L92
- Swift backend: plugin の初期化で `UNUserNotificationCenter.current().delegate` を設定する。Tauri は plugin を `Builder::build` で初期化するので、起動完了より前になる（Tauri 本体の節）。`willPresent` は banner を返すので、前面でもバナーが出る。
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/macos/Sources/NotificationManager.swift#L12-L16
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/macos/Sources/NotificationHandler.swift#L34-L64
- Swift backend の `didReceive` は `notificationClicked` に `{ id, data }` を送る。`data` は `userInfo` の文字列の値だけで、listener がまだ無ければ 1 件だけ持っておき、`onNotificationClicked` が登録されたときに渡す（cold start に効く）。request identifier は数値の id の文字列。
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/macos/Sources/NotificationHandler.swift#L91-L147
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/macos/Sources/NotificationHandler.swift#L15-L22
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/macos/Sources/NotificationPlugin.swift#L152-L154
- `extra` を `userInfo` の top level に展開するのは 0.5.0-rc から。0.4.6 は `userInfo["__EXTRA__"]` に dictionary として入れ、クリック時は文字列の値しか拾わないので、`extra` はクリックに届かない。
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/macos/Sources/Notification.swift#L36-L47
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.4.6/macos/Sources/Notification.swift#L39
- Swift backend は .app の外では初期化でエラーを返す。plugin の初期化が失敗すると `Builder::build` が失敗するので、`tauri dev` ではアプリが起動時に panic する（#230 に実際の log がある）。同じ issue には Swift Concurrency の dylib が見つからず `MACOSX_DEPLOYMENT_TARGET=13.0` で回避した記録もある。未署名の .app では通知が出ず、署名すると直った報告がある（#215。どの identity かは書かれていない）。
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/src/macos.rs#L13-L41
  - https://github.com/Choochmeque/tauri-plugin-notifications/blob/v0.5.0-rc.14/src/macos.rs#L151-L161
  - https://github.com/Choochmeque/tauri-plugin-notifications/issues/230
  - https://github.com/Choochmeque/tauri-plugin-notifications/issues/215
- 未解決の問題として、Swift backend の `notificationClicked` は dismiss や入力付き action でも飛ぶ（#354 open、直す PR #366 も open）。rc.14 は Xcode 27 の環境で link に失敗し、直した #360 はまだ release に入っていない。
  - https://github.com/Choochmeque/tauri-plugin-notifications/issues/354
  - https://github.com/Choochmeque/tauri-plugin-notifications/pull/366
  - https://github.com/Choochmeque/tauri-plugin-notifications/issues/335

### その他

- origin-notifications-tauri 0.2.1 は公式 plugin を包むだけで、クリックは無い。devsoluxhq/tauri-plugin-notification は BeyPilot 用の公式 plugin の fork で、desktop の command は公式と同じ 3 つ。
  - https://crates.io/crates/origin-notifications-tauri
  - https://github.com/devsoluxhq/tauri-plugin-notification
- user-notify 0.4.2（Tauri plugin ではない crate。LGPL-3.0-or-later、release は 2026-01-23、repo の最終 commit は 2026-05-18）は `NSBundle.mainBundle.bundleIdentifier` が無いと mock になる。推論: 公式 plugin が先に `set_application` を呼んだ dev の process では mock に落ちず、UN に進んで abort しうる。
  - https://github.com/Simon-Laux/user-notify/blob/v0.4.2/src/lib.rs#L40-L49
- user-notify-reborn 0.1.0（2025-06-30、MIT OR Apache-2.0）は repository の URL が 404 になっている。usernotifications-rs 0.4.0 は UserNotifications framework の binding で、Tauri plugin ではない。crates.io と GitHub の検索で、これら以外に macOS desktop のクリックを扱う Tauri plugin は見つからなかった。

## Tauri 本体（tauri 2.12.1 / tao 0.37.1）

- `RunEvent` に通知の event は無い。macOS 固有は `Opened { urls }`（`application:openURLs:` と universal link）と `Reopen { has_visible_windows }`（`applicationShouldHandleReopen:hasVisibleWindows:`）で、どちらにも通知の識別子は載らない。
  - https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri/src/app.rs#L218-L298
  - https://github.com/tauri-apps/tao/blob/tao-v0.37.1/src/platform_impl/macos/app_delegate.rs#L205-L215
- tao の application delegate が実装する selector は 7 つで、通知に関わるものは無い。`applicationDidFinishLaunching:` は引数の NSNotification を捨てるので、その `userInfo` の `NSApplicationLaunchUserNotificationKey`（通知のクリックで起動されたときの NSUserNotification）は Tauri から読めない。Apple は、起動の原因になった NSUserNotification は center の delegate ではなくこの key で app delegate に渡ると書いている。tao、tauri、tauri-runtime-wry、wry のソースに `UserNotification` の文字列は無い。
  - https://github.com/tauri-apps/tao/blob/tao-v0.37.1/src/platform_impl/macos/app_delegate.rs#L57-L84
  - https://github.com/tauri-apps/tao/blob/tao-v0.37.1/src/platform_impl/macos/app_delegate.rs#L124-L128
  - https://developer.apple.com/documentation/appkit/nsapplication/launchusernotificationuserinfokey
  - https://developer.apple.com/documentation/foundation/nsusernotificationcenterdelegate/usernotificationcenter(_:didactivate:)
- 通知の center の delegate は app delegate とは別の object なので、Tauri の外で設定できる。plugin の初期化は `Builder::build` の中、`setup` は `applicationDidFinishLaunching:` の中の `RunEvent::Ready` で走る。どちらも起動完了前で、UN の delegate を Apple の求める時期に設定できる。推論: NSUserNotification の cold start は、`build` の前後で `NSApplicationDidFinishLaunchingNotification` の observer を足せば key を読める。
  - https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri/src/app.rs#L2607
  - https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri/src/app.rs#L1442-L1443
  - https://github.com/tauri-apps/tao/blob/tao-v0.37.1/src/platform_impl/macos/app_state.rs#L284-L307
  - https://github.com/tauri-apps/tauri/blob/tauri-runtime-wry-v2.12.1/crates/tauri-runtime-wry/src/lib.rs#L4119-L4120

## dev と release での振る舞い

release は /Applications に置き、Keychain の自己署名 identity で codesign した .app を想定する。どの候補も実機では確かめていない。

- 公式 plugin 2.5.1 / 3.0.0-alpha.2: release ではクリックで OS が tania を前面に出すだけで、識別子は来ない。dev は Terminal の名義で出る。
- PR #3671（未 merge）: release では `on_action` に `tap` と `extra` が届く（ソースからの推論）。ただし action を 1 つ以上持つ action type を付けた通知に限り、通知にボタンが出る。届くのは出した process が生きている間だけ。前面時にバナーが出ないのは今と同じ。dev は同じコードで Terminal の名義になり、クリックが dev の process に届くかと Terminal.app が前に出るかは未確認。使うには fork の commit を git 依存で `[patch.crates-io]` に入れることになる。
- notify-rust / mac-notification-sys を Shell で直接使う: Shell が通知を出す thread で `wait_for_click(true)`（mac-notification-sys）か action 付きの `wait_for_response`（notify-rust）を待ち、closure が持つ terminalSessionId を Tauri event で webview に渡す。dev と release の振る舞いは PR #3671 と同じ。どちらの crate もすでに `Cargo.lock` にあるので、直接の依存に足しても依存グラフに crate は増えない。`set_application` は process に 1 回なので、plugin と同じ id（dev は Terminal、release は identifier）を渡す。`preview-macos-un` は dev で abort し（推論）、release でも cold start を取りこぼす。
- Choochmeque の notify-rust backend: dev と release の振る舞いは PR #3671 と同じで、通知に "Open" ボタンが出る。届く先は webview だけで、通知を出す前に webview が `onNotificationClicked` を登録している必要がある。
- Choochmeque の Swift backend: release ではクリックが webview の `notificationClicked` に `{ id, data }` で届き、cold start でも 1 件は残り、前面でもバナーが出る。許可の要求が要る。自己署名の identity で UN の許可が通るかは未確認。dev（`tauri dev`）では起動時に panic するので使えない。Cargo は profile で feature を切り替えられないので、dev だけ notify-rust backend にするには `tauri dev --features …` のような切り替えが要る（推論）。

## 結論

Tauri の範囲で、Rust（Shell）が通知のクリックと識別子を受け取れる release 済みの手段は無い。公式 plugin は 2.5.1 も 3.0.0-alpha.2 も desktop のクリックを持たず、Tauri 本体にも通知の event や `NSApplicationLaunchUserNotificationKey` を渡す口は無い。使える手段は 3 つある。1 つ目は open な PR #3671 で、merge されれば `Notification::on_action` が `extra` 付きで Rust に届く。ただし macOS では action を付けた通知に限られ、届くのは process が生きている間だけである。2 つ目は Choochmeque の tauri-plugin-notifications 0.5.0-rc で、クリックは webview の `onNotificationClicked` に `{ id, data: extra }` で届くが、Rust には届かない。その Swift backend は cold start と前面時のバナーにも対応するが、bundle の無い `tauri dev` では起動できない。3 つ目は、依存グラフにすでにある mac-notification-sys を Shell から直接使う方法で、識別子を持つ thread で `wait_for_click(true)` を待てば、ボタン無しで本文のクリックを受けられる。tania の「Shell が受けて webview に Tauri event で渡す」形に合い、crate も増えないのは 3 つ目で、PR #3671 が merge されれば plugin の API に置き換えられる。3 つ目と PR #3671 は NSUserNotificationCenter の上にあるので、識別子は process の memory にしか無く再起動を越えられず、前面時のバナーも出ない。dev では Terminal を名乗るので、クリックが dev の process に届くかは実機で確かめる必要がある。欠けているのは、UNUserNotificationCenter で `userInfo` を載せ、起動完了前に delegate を置き、クリックを Rust に渡す release 済みの plugin である。Tauri 本体は plugin の初期化を起動完了前に走らせるので、そのために本体を変える必要は無い。
