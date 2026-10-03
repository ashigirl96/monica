# Tauri 2 + Bun sidecar から macOS 通知を出す

「通知の所有と本文」（#23）のために調べた事実。結論は ADR-0013。調べた版は tauri-plugin-notification 2.5.1、notify-rust 4.18.1、mac-notification-sys 0.6.15、tauri 2.12.1、wry 0.57.0、terminal-notifier 3.1.0。macOS 26.6.2 で確かめた。

## tauri-plugin-notification（macOS desktop）

- desktop の実装は notify-rust → mac-notification-sys → NSUserNotificationCenter（macOS 11 で deprecated）。JS の `sendNotification` も Rust の `app.notification().builder()...show()` も同じ `NotificationBuilder::show` に行き着く。
  - https://github.com/tauri-apps/plugins-workspace/blob/notification-v2.5.1/plugins/notification/src/desktop.rs
- `show()` は background task に投げてすぐ返り、結果を `let _ =` で捨てる。失敗は呼び手に届かない。
- desktop で効くのは title / body / sound だけ（sound は 2.3.1 から）。`id`・`group`・`actionTypeId`・`extra`・`schedule` は無視され、icon も macOS では効かない。
- `requestPermission` / `isPermissionGranted` は desktop では常に Granted で、許可のダイアログを出さない。
- desktop の command は `notify` / `request_permission` / `is_permission_granted` の 3 つだけ。`cancel`・`removeActive`・`registerActionTypes`・`onAction` は mobile にしか無い。
  - https://github.com/tauri-apps/plugins-workspace/issues/1898
  - https://v2.tauri.app/plugin/notification/ （"The Actions API is only available on mobile platforms."）
- クリックは受け取れない。"Click events aren't implemented yet."（2022 年から open）。OS の既定でアプリが前面に来るだけ。
  - https://github.com/tauri-apps/plugins-workspace/issues/2150
- 出した通知は取り下げられない。mac-notification-sys の公開 API に、届いた通知を消す関数が無い。
- アプリが最前面の間はバナーが出ない。NSUserNotificationCenter は前面のアプリの通知を抑えることがあり、delegate の `shouldPresentNotification:` で上書きできるが、mac-notification-sys はそれを実装せず delegate を占有する。最小化や窓を閉じた状態でもアプリが active ならバナーは出ず、hide した時だけ出る。
  - https://developer.apple.com/documentation/foundation/nsusernotificationcenter
  - https://github.com/h4llow3En/mac-notification-sys/issues/95

## dev と release

- `tauri::is_dev()` は `!cfg!(feature = "custom-protocol")` で、`tauri dev` では true。plugin は dev なら `set_application("com.apple.Terminal")`、release なら app の identifier を使う。dev の通知は Terminal.app の名前とアイコンで出て、Terminal.app の通知の許可に従う。
  - https://github.com/tauri-apps/plugins-workspace/issues/2143
- LaunchServices が知らない identifier では release でも Terminal 名義になる（`--no-bundle` の生バイナリなど。推論）。

## Bun の sidecar から直接出す場合

- `osascript -e 'display notification ...'`: パラメータは title・subtitle・sound name だけ。Script Editor の名義で出て、クリックすると Script Editor が開く。取り下げもクリックの受け取りも無い。
  - https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html
- terminal-notifier 3.x: UserNotifications framework を使い、`-group` で置き換え、`-remove` で取り下げ、`-open` / `-activate` でクリック時の動作を指定できる。名義は terminal-notifier 自身の .app で、他のアプリの名義で出す `-sender` は 3.0.0 で消えた。
  - https://github.com/julienXX/terminal-notifier/blob/3.1.0/README.markdown
- UNUserNotificationCenter は bundle の無いプロセスでは `bundleProxyForCurrentProcess is nil` で落ちる。.app の `Contents/MacOS` に置いた 2 本目の実行ファイルでは `Bundle.main` が親の .app を指し、`getNotificationSettings` は落ちずに返った（許可の要求、投稿、クリックの届き先は未確認）。
  - https://developer.apple.com/forums/thread/724249

## UNUserNotificationCenter に移るなら

- notify-rust の opt-in feature `preview-macos-un` は UN 経路（mac-usernotifications）に切り替える。`close()` が `removeDeliveredNotificationsWithIdentifiers` を呼ぶ。bundle か許可が無いと panic する。Cargo の feature は統合されるので、付けると plugin も UN 経路になり dev では動かなくなる（推論）。
- mac-usernotifications 0.3.1 の delegate は willPresent で `.banner | .sound` を返すので、前面でもバナーが出る。
- user-notify 0.4.2（Delta Chat 由来）は id 指定の削除、表示中の通知の取得、thread id、ボタンと返信のアクション、user_info を持つ。
- Apple の UN では、willPresent を実装しないと前面時は表示されず、didReceive を実装しないとクリックに応答できない。delegate はアプリの起動完了前に設定する。
  - https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:willpresent:withcompletionhandler:)

## 窓が見えないときの WKWebView

- WebKit は、window が無い・view が hidden・`!window.isVisible`（最小化や hide）・occlusion で完全に覆われている（別 Space を含む）のどれかで不可視と判定する。
  - https://github.com/WebKit/WebKit/blob/046a5a8d15c6af2ef00ea4b591316eebe6540561/Source/WebKit/UIProcess/mac/PageClientImplMac.mm#L207-L230
- 不可視のページの DOM timer は既定で間引かれる。`WKPreferences.inactiveSchedulingPolicy`（macOS 14+）は既定で suspend で、JS の実行と layout が止まる。
  - https://developer.apple.com/documentation/webkit/wkpreferences/inactiveschedulingpolicy-swift.property
- Tauri 2.3 の window config `backgroundThrottling`（`disabled` / `suspend` / `throttle`）がこれを設定する（macOS 14+ のみ）。`disabled` でも timer は約 2 秒に間引かれるという報告がある。
  - https://github.com/tauri-apps/tauri/issues/5250#issuecomment-2569380578
- EventSource に絞った一次資料は無い。WebContent プロセスが suspend されれば `onmessage` も動かない（推論）。

## 窓を閉じたとき

- 既定では、最後の window が破棄されると `RunEvent::ExitRequested` を経てプロセスが終わる（macOS でも分岐が無い）。`prevent_exit()` すれば Rust と sidecar だけが残る。Dock のクリックは `RunEvent::Reopen`。
