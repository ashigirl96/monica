# macOS の通知を app から取り下げる

通知をクリックしなくても、Tab を見て未読でなくなったらその通知を通知センターから消し、Mac の通知の数を未読の数（`GLOSSARY.md` の未読）に揃えられるかを調べた事実。調べた版は Cargo.lock の objc2 0.6.4、objc2-user-notifications 0.3.2、block2 0.6.2、tauri 2.12.1、tauri-runtime-wry 2.12.1、tao 0.37.1、tauri-plugin-notification 2.5.1、notify-rust 4.18.1、mac-notification-sys 0.6.15 と、Xcode の macOS 27.0 SDK の UserNotifications framework の header。repo は `0968898`。2026-10-08 時点で、macOS 26.6.2。

実機での試作はしていない。試作は scratchpad（`/private/tmp` の下）に限ったが、`/private/tmp` の下に置いた .app は許可の要求が `UNErrorDomain code=1` で失敗する（`docs/research/macos-notifications.md` の「objc2-user-notifications で試作して確かめたこと」）ので、通知を出すところまで進めない。以下は docs、header、forum、ソースから読んだ事実で、確かめていない主張には「推論」と付ける。取り下げを実装した後に release で確かめたことは、末尾の「release で確かめたこと」にある。forum の投稿は、Apple の社員（DTS Engineer などの印があるもの）とそれ以外を書き分ける。

## UNUserNotificationCenter で届いた通知を取り下げる

- 届いた通知を扱う method は 3 つで、どれも macOS 10.14 から使える。`getDeliveredNotificationsWithCompletionHandler:` は「app の届いた通知のうち、通知センターにまだあるもの」を返す。`removeDeliveredNotificationsWithIdentifiers:` は request identifier が一致する通知を通知センターから消す。`removeAllDeliveredNotifications` は app の届いた通知をすべて消し、まだ届いていない予約の request には触らない。
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/getdeliverednotifications(completionhandler:)
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/removedeliverednotifications(withidentifiers:)
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/removealldeliverednotifications()
- 3 つとも非同期。取り下げの 2 つは「すぐ返り、background thread で消す」と書かれ、終わりを知らせる completion handler を持たない。取得は「すぐ返り、結果が揃ったら background thread で block を呼ぶ」。通知センターに表示されていない identifier は無視される。
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/removedeliverednotifications(withidentifiers:) （"The method executes asynchronously, returning immediately and removing the specified notifications on a background thread." "This method ignores the identifiers of requests whose notifications are not currently displayed in Notification Center."）
- Apple の DTS は iOS の thread で「呼べば動くが、非同期なので、すぐ返っても実際に消えるまで時間がかかることがある」「通知センターは通知を持つ app とは別の process で非同期に動くので、遅れは想定内」と答えている。macOS について同じことを書いた Apple の記述は見つからなかった。
  - https://developer.apple.com/forums/thread/774856 （2025-02、DTS Engineer。"the removal of the notifications will be done in the background and may take some time."）
  - https://developer.apple.com/forums/thread/777763 （2025-03、DTS Engineer。"As the Notification Center is the process that handles this, and works separately and asynchronously from the app which owns the notifications, some delay in expected"）
- center は「どの thread からも同時に使ってよく、要求は system が受けた順に 1 つずつ処理する」。推論: 同じ process から `addNotificationRequest` の直後に同じ identifier の取り下げを出しても、追加が先に処理される。取り下げの直後に `getDelivered…` を呼んで、消した通知がもう返らないかは docs から読めない。
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenter

### 前面でないとき、表示中のバナー、再起動の後

- Apple の docs と header は、取り下げに app が前面であることを求めていない。前面でない app から呼べるかを書いた Apple の記述も、呼べないという報告も見つからなかった。
- 取り下げが表示中のバナーや、消すまで残る Persistent（旧 Alerts）の alert を画面から消すかは、Apple の docs にも forum にも記述が見つからなかった。docs は一貫して「通知センターから（from Notification Center）」消すと書く。
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/removedeliverednotifications(withidentifiers:)
- 対象は process ではなく「app の（your app's）通知」と書かれている。前回の起動で出した通知を、再起動した process が取得して消せるかを直接書いた Apple の記述は無い。第三者の実装は、取得できる前提で作られている。Chromium は起動時に `getDeliveredNotificationsWithCompletionHandler:` で表示中の通知を読み直し、「crash の後で再起動されても、表示中の通知を引き続き扱う。通知の許可が無くても（無くなっていても）動く」と comment に書く。Electron の `Notification.getHistory()`（macOS）は「app の再起動の後、前の session の通知に event handler を付け直すのに使う」と docs に書く。
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/removealldeliverednotifications()
  - https://github.com/chromium/chromium/blob/f54292584c85083e2374f2872faa583adec75346/chrome/services/mac_notifications/mac_notification_service_un.mm#L155-L160
  - https://github.com/electron/electron/blob/18f7d6cc5ca32920efebf38197cb6ca3ff1be121/docs/api/notification.md#L79-L90
- Chromium は、profile ごとに通知を閉じるとき、`getDelivered…` で取った通知を `userInfo` の値で絞り、その request identifier を `removeDeliveredNotificationsWithIdentifiers:` に渡している。
  - https://github.com/chromium/chromium/blob/f54292584c85083e2374f2872faa583adec75346/chrome/services/mac_notifications/mac_notification_service_un.mm#L430-L467
- Electron の docs は、署名の無い開発 build では通知が通知センターに届かず、`getHistory()` は空を返すと書く。
  - https://github.com/electron/electron/blob/18f7d6cc5ca32920efebf38197cb6ca3ff1be121/docs/api/notification.md#L87-L90

### 同じ identifier で出し直す

- 置き換わる。header は「同じ identifier の届いた通知があれば、新しい request で alert し、trigger の時に届いた通知を置き換える」と書き、`UNNotificationRequest` の docs は「もう一度 alert し、古い通知を新しい通知で置き換え、一覧の先頭に置く」と書く。置き換えても alert はし直す。
  - Xcode の MacOSX27.0.sdk の `UserNotifications.framework/Headers/UNUserNotificationCenter.h`（`addNotificationRequest:withCompletionHandler:` の comment）
  - https://developer.apple.com/documentation/usernotifications/unnotificationrequest/init(identifier:content:trigger:) （"If the identifier matches a previously delivered notification, the system alerts the user again, replaces the old notification with the new one, and places the new notification at the top of the list."）
- 置き換えを alert なしで行う公開 API は無い。Chromium は、再通知しない更新に `replaceContentForRequestWithIdentifier:replacementContent:completionHandler:` を `respondsToSelector:` で確かめて呼んでいる。この selector は SDK の header に無い。
  - https://github.com/chromium/chromium/blob/f54292584c85083e2374f2872faa583adec75346/chrome/services/mac_notifications/mac_notification_service_un.mm#L294-L319

### threadIdentifier

- `threadIdentifier` は「見た目でまとめたい通知に同じ文字列を付ける」もの。取り下げは request identifier で行い、thread でまとめて消す API は無い（header の center の method は、届いた通知の 3 つと予約の 2 つだけ）。thread ごとに消すには、`getDelivered…` で取って `threadIdentifier` で絞る（Electron の `Notification.removeGroup` は groupId を `threadIdentifier` に対応させ、「その groupId の届いた通知をすべて消す」と docs に書く）。
  - https://developer.apple.com/documentation/usernotifications/unmutablenotificationcontent/threadidentifier
  - https://github.com/electron/electron/blob/18f7d6cc5ca32920efebf38197cb6ca3ff1be121/docs/api/notification.md#L144-L161
- 通知のまとめ方はユーザーの設定 Notification grouping（Automatic / By Application / Off）で決まり、`threadIdentifier` を付けても Off ならまとまらない。まとめられた通知は stack に重なり、先頭の通知の Clear ボタンの上で Clear All を押すと stack ごと消える。
  - https://support.apple.com/guide/mac-help/change-notifications-settings-mh40583/15.0/mac/15.0
  - https://support.apple.com/guide/mac-help/mchl2fb1258f/26/mac/26

### 既知の不具合

- macOS の release notes（10.14〜27）に UserNotifications の項目は見つからなかった。
  - https://developer.apple.com/documentation/macos-release-notes
- macOS の取り下げそのものの不具合の報告は見つからなかった。近い報告は、Big Sur で `addNotificationRequest` がときどき `NSCocoaErrorDomain Code=4097`（usernotificationservice への接続）で失敗し、同じ時に他の通知のクリックも delegate に届かない、というもの（Apple の回答なし）。
  - https://developer.apple.com/forums/thread/725655
- iOS では、取り下げが iOS 17 で効かなくなった（744695）、iOS 16 で同じ title と body の通知も一緒に消える（721103）、critical alert は消せない（688879）という報告がある。どれも Apple の回答は無く、macOS で同じことが起きるかは分からない。
  - https://developer.apple.com/forums/thread/744695
  - https://developer.apple.com/forums/thread/721103
  - https://developer.apple.com/forums/thread/688879

## objc2-user-notifications 0.3.2 の binding

- `UNUserNotificationCenter` に `getDeliveredNotificationsWithCompletionHandler`、`removeDeliveredNotificationsWithIdentifiers`、`removeAllDeliveredNotifications`、`setBadgeCount_withCompletionHandler` がある。どれも `unsafe` の付かない `pub fn`。
  - https://docs.rs/crate/objc2-user-notifications/0.3.2/source/src/generated/UNUserNotificationCenter.rs#150-173
- 取得は `&block2::DynBlock<dyn Fn(NonNull<NSArray<UNNotification>>)>` を取る。取り下げは `&NSArray<NSString>` を取り、completion handler を取らない。取得には feature の `UNNotification` と `block2` が要り、badge には `block2` が要る。Shell の `Cargo.toml` はどちらもすでに有効にしている。
  - https://docs.rs/crate/objc2-user-notifications/0.3.2/source/src/generated/UNUserNotificationCenter.rs#150-173
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/apps/desktop/src-tauri/Cargo.toml#L34-L43
- class の定義に main thread の印（`MainThreadOnly`）は無く、どの thread からも呼べる。Shell はすでに、Backend の stdout を読む thread から `currentNotificationCenter` と `addNotificationRequest_withCompletionHandler` を呼んでいる。
  - https://docs.rs/crate/objc2-user-notifications/0.3.2/source/src/generated/UNUserNotificationCenter.rs#51-56
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/apps/desktop/src-tauri/src/backend.rs#L183-L198
- 取得の block は background thread で呼ばれうる（Apple）。block2 0.6.2 は「thread-safe な block はまだ表せない」と書き、binding の block 型にも `Send` の制約は無い。closure が捕まえる値を別の thread で触ってよいかは、compiler ではなく呼び手が守る。
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/getdeliverednotifications(completionhandler:)
  - https://docs.rs/block2/0.6.2/block2/index.html#thread-safety
- `CustomDismissAction` を付けた category を作る `categoryWithIdentifier_actions_intentIdentifiers_options` には、feature の `UNNotificationCategory` と `UNNotificationAction` が要る。今の Shell の `Cargo.toml` には無い。`UNNotificationDismissActionIdentifier` は `UNNotificationResponse` の extern static。
  - https://docs.rs/crate/objc2-user-notifications/0.3.2/source/src/generated/UNNotificationCategory.rs#102-110
  - https://docs.rs/crate/objc2-user-notifications/0.3.2/source/src/generated/UNNotificationResponse.rs#14-17

## ユーザーが通知を手で消したことを app が知れるか

- 知る手段は dismiss action だけ。category を `UNNotificationCategoryOptionCustomDismissAction` 付きで登録し、通知の `categoryIdentifier` にその category を指定したときに限り、delegate の `didReceive` に `actionIdentifier == UNNotificationDismissActionIdentifier` の応答が届く。それ以外に、通知が通知センターから消えたことを知らせる delegate の method は無い。
  - https://developer.apple.com/documentation/usernotifications/unnotificationcategoryoptions/customdismissaction
  - https://developer.apple.com/documentation/usernotifications/unnotificationdismissactionidentifier
- Apple は届く条件を「ユーザーが通知の画面を明示的に閉じたとき」とし、「通知を無視したときや、バナーを払いのけたときには届かない」と書く。例に挙がるのは watchOS の Dismiss ボタンと下へのスワイプだけで、macOS のどの操作（バナーの ×、通知センターの Clear、stack の Clear All、バナーが時間で消える）が「明示的に閉じる」に当たるかを書いた Apple の記述は見つからなかった。
  - https://developer.apple.com/documentation/usernotifications/unnotificationdismissactionidentifier （"Ignoring a notification or flicking away a notification banner doesn't trigger this action."）
- macOS（Big Sur と Catalina）の報告: 1 件の通知を × で消すと dismiss は届く。thread でまとめた stack を × から「Clear All」で消すと、delegate は stack の中の任意の 1 件についてしか呼ばれず、stack ごと消えたことは分からない（Apple の回答なし）。
  - https://developer.apple.com/forums/thread/692708 （2021-10）
- Chromium は category に `CustomDismissAction` を付けたうえで、通知が表示中だと思っている間は 10 分ごとに `getDelivered…` を読み、自分が覚えている通知との差から閉じられた通知を見つけている。Electron の docs は、macOS を含めて `close` の event は「閉じられたすべての場合に出るとは限らない」と書く。
  - https://github.com/chromium/chromium/blob/f54292584c85083e2374f2872faa583adec75346/chrome/services/mac_notifications/notification_category_manager.mm#L203
  - https://github.com/chromium/chromium/blob/f54292584c85083e2374f2872faa583adec75346/chrome/services/mac_notifications/mac_notification_service_un.h#L33-L34
  - https://github.com/chromium/chromium/blob/f54292584c85083e2374f2872faa583adec75346/chrome/services/mac_notifications/mac_notification_service_un.h#L86-L88
  - https://github.com/electron/electron/blob/18f7d6cc5ca32920efebf38197cb6ca3ff1be121/docs/api/notification.md#L248-L251
- Apple の docs は platform を分けずに、action を選ぶと system が app を起動して delegate を呼ぶと書く。推論: monica が動いていない間に dismiss action 付きの通知を消すと、monica が起動されうる。
  - https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types
- だから「通知センターの数 = 未読の数」は片方向にしか保てない。未読でなくなった通知を app が消すことはできるが、ユーザーが通知センターで消した通知は、dismiss が届く操作の分しか app に分からず、stack の Clear All などでは分からない。届いたとしても、GLOSSARY の「見た」は窓が前面で Tab を表示したことなので、通知を消したことは今の定義では既読にならない。

## 数がずれるほかの場面

- 許可が無い、または app の通知がオフ: `addNotificationRequest` は `UNErrorCodeNotificationsNotAllowed` で失敗し、通知は通知センターに入らない。monica はその前に `notified_at` を書いているので、未読はあり、通知は無い（下の「monica に当てはめた事実」）。
  - https://developer.apple.com/documentation/usernotifications/unerror/code/notificationsnotallowed
- 許可があっても画面に出るとは限らない。`alertSetting` の docs は「許可は alert が常に画面に出ることを保証しない」と書く。通知センターに載るかは `notificationCenterSetting`（「app の通知が通知センターに出るか」）で決まり、載らない設定のときに `getDelivered…` が何を返すかは見つからなかった。
  - https://developer.apple.com/documentation/usernotifications/unnotificationsettings/alertsetting
  - https://developer.apple.com/documentation/usernotifications/unnotificationsettings/notificationcentersetting
  - https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications （"The system still displays alerts in Notification Center if your UNNotificationSettings instance's notificationCenterSetting property is set to enabled."）
- 目立たない形の配信: provisional の許可や「Deliver Immediately（quietly）」では、通知はバナーも音も出さず、通知センターの履歴にだけ入る。monica は provisional を求めていない。macOS 26 の通知の Mute は「表示せず、音も鳴らさない」もので、通知センターに残るかは User Guide に書かれていない。
  - https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications
  - https://support.apple.com/guide/mac-help/mh40609/26/mac/26
- 集中モード（おやすみモード）: macOS 10.14 の User Guide は「通知は見えず聞こえないが、通知センターに集められ、後で見られる」と書く。macOS 26 の User Guide には、Focus で止めた通知の行き先の記述が無い。Focus で止めた通知が `getDelivered…` に入るかを書いた Apple の記述は見つからなかった。推論: Focus の間も通知センターの数は増え、取り下げも効く。
  - https://support.apple.com/guide/mac-help/mh40609/10.14/mac
- 古い通知: macOS 12 の User Guide は「Show in Notification Centre: 最近の通知を並べる。7 日より古い通知は出ない」と書く。macOS 26 の User Guide に同じ記述は無い。推論: 7 日以上待たせた未読は、通知センターから見えなくなる。
  - https://support.apple.com/en-au/guide/mac-help/mh40583/12.0
- 件数の上限: UserNotifications の届いた通知について、app ごとの上限を書いた Apple の記述は見つからなかった。deprecated の NSUserNotificationCenter の docs は「ユーザーが画面で実際に見る通知の数は、この配列の大きさより少ないことがある」と書く。
  - https://developer.apple.com/documentation/foundation/nsusernotificationcenter/deliverednotifications
- 位置で発火した通知は `getDelivered…` に出ないが、消すことはできる（header）。monica は trigger を付けずに出すので当たらない。
  - Xcode の MacOSX27.0.sdk の `UNUserNotificationCenter.h`（"Notifications triggered by location cannot be retrieved, but can be removed."）

## dev の経路（tauri-plugin-notification → notify-rust → mac-notification-sys）

dev の Shell は .app の外で動き、通知を tauri-plugin-notification で Terminal.app の名義で出す（`docs/packages/notifications.md`）。この経路では、出した通知を app から取り下げられない。

- tauri-plugin-notification 2.5.1 の desktop の Rust API は `builder().show()`・`request_permission`・`permission_state` だけで、`remove_active`・`remove_all_active`・`active`・`cancel` は mobile にしか無い。desktop の command も `notify`・`request_permission`・`is_permission_granted` の 3 つ。
  - https://github.com/tauri-apps/plugins-workspace/blob/d4835d0e947179bac24a383212792d74be3ebe4f/plugins/notification/src/desktop.rs#L26-L100
  - https://github.com/tauri-apps/plugins-workspace/blob/d4835d0e947179bac24a383212792d74be3ebe4f/plugins/notification/src/mobile.rs#L111-L160
  - https://github.com/tauri-apps/plugins-workspace/blob/d4835d0e947179bac24a383212792d74be3ebe4f/plugins/notification/src/lib.rs#L247-L251
- notify-rust 4.18.1 の既定の macOS backend（NSUserNotificationCenter）の `NotificationHandle` は `wait_for_action`・`wait_for_response`・`on_close` だけを持ち、`close` は無い。`close` が `removeDeliveredNotificationsWithIdentifiers` を呼ぶのは opt-in の `preview-macos-un` の backend で、bundle の無い dev では使えない（`docs/research/tauri-notification-click.md`）。
  - https://github.com/hoodie/notify-rust/blob/785d8366baab6d973b474d684f2d7e48a0ad51e0/src/macos/nsusernotifications.rs#L14-L113
- mac-notification-sys 0.6.15 の公開 API は `send_notification`・`set_application`・`get_bundle_identifier(_or_default)` と `Notification` の builder だけで、届いた通知を消す関数は無い。中では、クリックか alert の dismiss を delegate が受けたときにだけ `removeDeliveredNotification:` を呼ぶ。
  - https://github.com/h4llow3En/mac-notification-sys/blob/deb559683962d314a7693478476bf8d052efa84e/src/lib.rs#L23-L157
  - https://github.com/h4llow3En/mac-notification-sys/blob/deb559683962d314a7693478476bf8d052efa84e/objc/notify.m#L251-L301

## 「Mac の通知数」はどこに出る数か

- 通知センターの一覧: `getDelivered…` が返すのは、app の届いた通知のうち通知センターにまだあるもの。同じ app の通知は設定に従って stack にまとまり、先頭の通知を押すと広がる。stack や一覧の件数を数字で出すという記述は、macOS 26 の User Guide に無い。
  - https://support.apple.com/guide/mac-help/mchl2fb1258f/26/mac/26
- Dock の icon の badge: User Guide は「Badge application icon: app が Dock の icon に通知の数を出すのを許す」と書くが、数を決めるのは app。Apple の社員は（iOS の thread で）「badge の数の設定・増減・消去は自動ではない」「`setBadgeCount` は badge の数だけを変え、通知センターの通知は消さない。消すには `removeAllDeliveredNotifications` か `removeDeliveredNotifications(withIdentifiers:)` を使う」と答えている。通知を取り下げても badge は変わらず、badge を変えても通知は消えない。
  - https://support.apple.com/guide/mac-help/mh40583/26/mac/26
  - https://developer.apple.com/forums/thread/746885 （2024-02、Engineer）
  - https://developer.apple.com/forums/thread/756459 （2024-06、Engineer）
- monica の Dock の数は、Backend の数を tauri の `set_badge_count` で出している。tauri-runtime-wry 2.12.1 は macOS で数を文字列にして window の `set_badge_label` を呼び、tao 0.37.1 は `NSApp.dockTile` の `setBadgeLabel:` を呼ぶ。UserNotifications framework は通らない。
  - https://github.com/tauri-apps/tauri/blob/30da1fd6e17de6107ecc850c95dfb16b5729f2dd/crates/tauri-runtime-wry/src/lib.rs#L3511-L3518
  - https://github.com/tauri-apps/tao/blob/37b7e8bc90a050e93be988df636f322c3ef147b6/src/platform_impl/macos/window.rs#L1553-L1555
  - https://github.com/tauri-apps/tao/blob/37b7e8bc90a050e93be988df636f322c3ef147b6/src/platform_impl/macos/badge.rs#L5-L13
  - https://developer.apple.com/documentation/appkit/nsdocktile
- UserNotifications 側の badge は 2 つある。通知の `badge`（届いたときに icon に付ける数。0 で消し、nil は変えない。badge の許可が無いと無視される）と、center の `setBadgeCount:withCompletionHandler:`（macOS 13 から）。後者が badge の許可を要るか、NSDockTile の badge とどう関わるかを書いた Apple の記述は見つからなかった。
  - https://developer.apple.com/documentation/usernotifications/unmutablenotificationcontent/badge
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/setbadgecount(_:withcompletionhandler:)
- 第三者の報告が 2 件ある。UserNotifications に許可を求めた app が `.badge` を含めていないと、System Settings の Notifications にその app の「Badge application icon」の項目が無く、`NSDockTile.badgeLabel` が黙って捨てられる。`.badge` を足して求め直すと、すでに許可済みの app ではダイアログなしで項目が現れ（初めは off）、on にすると badge が出た（cmux、macOS 27.0。spaces、macOS 15.6）。Apple の docs には無い。
  - https://github.com/manaflow-ai/cmux/pull/14242
  - https://github.com/yogesh-dhande/spaces/issues/769
- monica の release の Shell は許可を `Alert` だけで求めているが、#215 の後の release で、Dock の icon に未読の数が出ることを 2026-10-08 に画面で確かめた。上の報告と条件の何が違うかは調べていない。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/apps/desktop/src-tauri/src/notification.rs#L51-L67

## monica に当てはめた事実

### 未読でなくなる瞬間を知っているのは Backend

- 未読は `agent_session` の `notified_at` があり `seen_at` が空のこと。未読でなくなるのは、webview の `markSeen` が `seen_at` を書くとき、Agent Session が状態に入り直して（待ちが解ける、許可の新しい待ちに入る）両方が空になるとき、Terminal Session が終わって Agent Session が終了になるとき。どれも Backend の Workbench Ledger が行を書く。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/docs/packages/workbench-ledger.md#L108-L119
- 「見た」は窓が前面のときにしか起きないので、`markSeen` による取り下げは monica が前面の間に起きる。待ちが解ける、Terminal Session が終わる、は monica が背面でも起きる（推論）。monica が前面の間に出た通知は、`willPresent` が list だけを返すのでバナーにならず通知センターにだけ入る。表示中の Tab の通知なら、webview がすぐ `markSeen` を呼ぶ。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/docs/packages/workbench-ui-state.md#L77-L78
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/apps/desktop/src-tauri/src/notification.rs#L134-L143
- `notified_at` は `recordHook` の transaction の中で書かれ、通知は commit の後に stdout の行として出る。Shell が通知を出せなかったとき（許可が無い、投稿の失敗）も `notified_at` は残り、Shell の失敗は stderr に出るだけ。今でも、未読があるのに通知センターに通知が無いことがある。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/packages/workbench/src/agent-session.ts#L79-L89
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/apps/desktop/src-tauri/src/notification.rs#L97-L108
- 同じ Agent Session に通知は何度も出る（turn ごとの手空き、許可を求めるたび）。未読は Agent Session ごとに 1 つまでだが、通知センターの通知は出した数だけ積もる。今は取り下げないので、通知センターの monica の通知の数は、出した通知のうちユーザーが消していない数になる。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/docs/packages/notifications.md#L5-L22
- 未読は Backend の再起動をまたいで残る。desktop を閉じている間は Backend も Shell も居ないので、その間に通知センターから消えた通知も、終わった Terminal Session も、次の起動まで突き合わせられない（推論）。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/docs/packages/workbench-ledger.md#L118

### Shell に今届いているもの

- Backend から Shell への行は `notify { title, body, terminalSessionId }` と `badge { count }` だけで、どの Agent Session が未読でなくなったかを運ぶ行は無い。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/apps/desktop/src-tauri/src/announcement.rs#L9-L36
- `badge` は数だけを運び、Workbench Ledger は前に渡した数と違うときだけ渡す。同じ数え直しの中で 1 つが既読になり別の 1 つが未読になると、行は出ない。数え直しは `agent_session` の行（`session_id` と `terminal_session_id` を持つ）を読んでから数だけを残している。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/packages/workbench/src/unread.ts#L12-L50
- Shell は request identifier を通知ごとの `NSUUID` で作って覚えず、`userInfo` の `terminalSessionId` に notify の行の値を載せる。推論: identifier を覚えていなくても、Chromium と同じく `getDelivered…` で取った通知を `userInfo` の `terminalSessionId` で絞れば、取り下げる相手を選べる。再起動の前に出した通知も同じように選べる。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/apps/desktop/src-tauri/src/notification.rs#L77-L101
- 終了でない Agent Session は 1 つの Terminal Session に 1 つまで（部分 unique index）。Agent Session の居場所は受け付けた hook の Terminal Session に合わせて動く。notify の行の `terminalSessionId` は、通知を出した時点の居場所。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/packages/workbench/src/schema.ts#L74-L77
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/docs/packages/workbench-ledger.md#L103-L104

### request identifier の選び方で変わること

Apple の規則は、同じ identifier の届いた通知があれば置き換え、もう一度 alert して一覧の先頭に置く（上の「同じ identifier で出し直す」）。

- 通知ごとの UUID（今）: 出すたびに通知が増える。取り下げるには、Shell が identifier を覚えておくか、`getDelivered…` で `userInfo` から探す。覚えた identifier は process の memory にしか無いので、再起動の前に出した通知は後者でしか探せない（推論）。ある Terminal Session の通知を全部消せば、過去の turn の通知もまとめて消える。
- Terminal Session の id: 同じ Tab の通知は 1 つに置き換わり、通知センターの数は Terminal Session の数を超えない。取り下げは `removeDeliveredNotificationsWithIdentifiers` に id を渡すだけで、`getDelivered…` を待たない。notify の行にすでにある値なので、行は変わらない。Agent Session が別の Terminal Session に移ると、古い通知は古い id のまま残る。同じ Tab で claude を起動し直すと、前の Agent Session の通知も同じ id で置き換わる。
- Agent Session の id: GLOSSARY の「1 つの Agent Session の未読は 1 つ」と、通知センターの 1 件が揃う。notify の行に Agent Session の id は無いので、行に足す必要がある。クリックで Tab を選ぶには、今どおり `userInfo` の `terminalSessionId` が要る。
- どの identifier でも、置き換えるたびに alert し直す。今の notify は新しい待ちのたびに出すので、置き換えのためにバナーが増えることは無い（推論）。
- GLOSSARY の通知は「待ちが解けても取り下げない」と書き、ADR-0022 は「待ちが解けたら取り下げる、同じ Tab の古い通知を置き換える、を後から足せる。この ADR では足さない」と書いている。
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/GLOSSARY.md#L96-L101
  - https://github.com/ashigirl96/monica/blob/0968898c9373257cea58baacd25338697f9f035c/docs/adr/0022-a-notification-click-shows-its-tab.md#L25

## 結論

release では、Tab を見たら通知を消せる。`removeDeliveredNotificationsWithIdentifiers:` と `getDeliveredNotificationsWithCompletionHandler:` は macOS 10.14 からあり、objc2-user-notifications 0.3.2 の binding を Shell が今の feature のまま呼べる。前面であることは求められず、再起動の前に出した通知も `userInfo` の `terminalSessionId` で探して消せる（Chromium と Electron がその前提で動いている。monica では推論）。取り下げは非同期で終わりが分からず、表示中のバナーや Persistent の alert まで消えるかは一次資料に無いので、実機で確かめる必要がある。未読でなくなる瞬間を知るのは Backend だけで、今の Shell への行には取り下げる相手が載っていない。identifier を Agent Session か Terminal Session の id にすれば、同じ相手の通知は 1 件に置き換わる。ただし「Mac の通知数 = 未読数」は片方向にしか保てない。ユーザーが通知センターで消したことは、dismiss action が届く操作（1 件の × など）でしか分からず、stack の Clear All では 1 件分しか届かないという報告がある。許可が無いとき、通知センターに出さない設定のとき、古い通知が見えなくなったとき（macOS 12 の User Guide は 7 日）も数はずれる。dev（Terminal 名義の tauri-plugin-notification）には取り下げの手段が無い。Dock の badge の数はすでに未読の数で、release でも出ている。

## release で確かめたこと

2026-10-08、macOS 26.6.2。#233 の branch（`f75edf9` の上）を `bun run build` と `bun run install-app` で入れた release で、claude の代わりに hook の CLI で待ちを作って確かめた。request identifier は Terminal Session の id で、Backend から届いた最初の未読の集合では、届いた通知を `userInfo` の `terminalSessionId` で選んで取り下げる（`docs/packages/notifications.md` の「取り下げ」）。#233 で Backend から Shell への `badge { count }` の行は、Terminal Session の id の集合を運ぶ `unread { terminalSessionIds }` の行に替わった。

- 表示中のバナーは、取り下げると画面から消えた。monica を背面にして手空きの通知を出し、バナーが出ている間（出してから約 3 秒後）に待ちを解いて取り下げると、その 1.2 秒後の screenshot にバナーは無かった。先に届いて同じ時に表示していた別の app のバナーは残っていたので、時間切れで消えたのではない。消えるまでの時間は測っていない。通知の形を Persistent にした alert は確かめていない。
- 前面でない app からの取り下げは効いた。上のバナーは monica が背面の間に消えた。
- 前回の起動で出した通知を、再起動した process が `getDeliveredNotificationsWithCompletionHandler:` で読んで消せた。#233 より前の版が UUID の identifier で出した通知も、新しい版の起動で `userInfo` の `terminalSessionId` から選んで消えた。monica を終了している間に Tab の shell を終わらせると、起動し直した後にその Tab の通知だけが消え、未読の Tab の通知は残り、押すとその Tab に移った。
- 同じ identifier で 2 回出すと（許可を続けて求めた）、通知センターのその Tab の通知は 1 件だった。
- 通知センターで通知を手で消しても、monica の未読と Dock の数は残った。
- 通知センターの中身は `~/Library/Group Containers/group.com.apple.usernoted/db2/db` の `record` table にあり、読み取り専用で開けた。ただし、このときは通知を出してから数分のあいだ DB にも WAL にも書き込みが無く、取り下げの直後の状態を確かめるのには使えなかった。
