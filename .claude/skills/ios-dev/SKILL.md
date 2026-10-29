---
name: ios-dev
description: iPhone app の build・Simulator 試験・Xcode 実機署名・QR 登録・端末閲覧・基本入力・表示解除・失効を行うときに使う。Mac の app の入れ替えとは区別する。
---

## 自動検証

1. macOS、Xcode、iOS 26.2 以降の Simulator runtime、Bun、repo の Rust toolchain を用意する。`xcodebuild -version` と `xcrun simctl list runtimes` で確認する。deployment target は 26.2。UI の実装・確認には `.agents/skills/apple-design/SKILL.md` を読む。
2. repo root で `bun install --frozen-lockfile`、`bun run check:ts`、`bun run check:ios` を実行する。iOS の React build だけなら `bun run --cwd apps/ios build`。native script は専用 Simulator と隔離 TLS fixture を作り、実 Rust Shell relay・既存 fake ptyd と実 WKWebView/xterm の native 試験、署名なしの iphoneos build を実行し、自分が作った Simulator・process・一時資格を終了時に片付ける。
3. 結果は `MONICA_IOS_LOG_DIR` に指定した directory、未指定なら script が表示する `/tmp` の directory で読む。`xcodebuild.log`、`Native.xcresult`、`iphoneos-build.log` を確認する。Simulator の app には Keychain 用の ad-hoc signature が必要だが、Apple account、有料契約、署名証明書、provisioning profile は使わない。実機へ入れたことを意味しない。
4. `project.yml` を変えたときは React を build し、`cd apps/ios && xcodegen generate` を実行して、生成 project も commit する。XcodeGen は project の変更時だけ必要。通常の CI/build はチェックインした project を使う。

## 実 iPhone へ導入

1. React を build して `apps/ios/Monica.xcodeproj` を Xcode で開く。scheme は `Monica`。Signing & Capabilities で自分の Personal Team と一意な Bundle Identifier を選ぶ。repo の共有設定に自分の Team ID を保存しない。
2. iPhone を Mac と接続して信頼し、設定の Privacy & Security から Developer Mode を有効にする。Xcode の destination にその iPhone を選び Run する。無料 Personal Team の provisioning は通常 7 日で期限切れになるので、期限後は同じ Team・Bundle Identifier で再署名して入れ直す。TestFlight と有料 Developer Program は不要。
3. この app は登録、既存 Workbench 一覧、選んだ Terminal Session の出力閲覧を提供する。同じ Mac renderer が利用可能な間だけ基本入力を送れる。Tab を作る・閉じる操作、自動での端末再接続はない。

## Mac と登録

1. `.claude/skills/desktop-dev/SKILL.md` の手順で隔離 `MONICA_HOME` の Mac desktop を起こす。ユーザーの稼働 home と PTY は使わない。iPhone と Mac で Tailscale に接続する。
2. tailnet 管理者に、特定 iPhone から特定 Mac の設定 port（既定 19443）だけを許す grants と、重なる広い許可がないことを確認してもらう。ユーザーの policy を勝手に変更しない。Serve・Funnel・ルーター公開を使わない。
3. Mac の Remote access で Mac の Tailscale address と port を有効化し、短命の QR を作る。iPhone の「Macの登録QRを読み取る」からカメラを許可して読む。Simulator には実カメラがない。QR と秘密を screenshot・ログへ残さない。
4. Mac に出た端末名と実 TCP source を tailnet の iPhone と照合して承認する。iPhone の承認待ち・拒否・期限切れを区別して確認する。秘密は native が申請前に device-only、unlock 時のみ利用できる Keychain へ保存する。JS・localStorage・URL へコピーしない。
5. Mac と同じ Runspace、Tab、Terminal Session、Agent Session の一覧と状態が出ること、Mac での変更が反映されることを確認する。iPhone の Tab 選択は Mac の選択と未読を変えない。空一覧から作業を作らない。
6. Mac で端末を失効し、iPhone の一覧購読が閉じて承認必要になることを確認する。無効化でも接続が閉じる。identity の変更・期限切れでは証明書検証を緩めず、Mac の identity 更新後に新しい QR で明示的に再登録する。port・source address が変わったときも grants と登録を更新する。
7. 再接続は「再接続」から行える。一覧の一時的な通信失敗は共通コードが上限付きで retry する。失効・identity 変更・非互換では自動 retry しない。背景・lock では native が接続を閉じる。実回線切替と復帰の確認結果は Simulator と分ける。

## 端末の閲覧と表示解除

1. 一覧から Tab を選ぶ。保持された末尾と live 出力が読め、Mac の選択・focus・未読が変わらないことを確認する。画面の renderer待ち・共有入力と履歴・TUI 復元の制限を読む。xterm は Mac の固定 grid を表示し、横方向は表示領域をスクロールする。
2. Mac で resize し、iPhone の grid が適用済み rows/cols へ追従することを確認する。iPhone の回転で PTY を resize しない。xterm の自動応答と terminal 出力による clipboard/file 操作は送らない。
3. 「一覧へ戻る · 表示解除」と別 Tab の選択を試す。表示の接続だけを閉じ、Mac の shell は続く。背景移行・lock・切断でも同じ。復帰後は一覧から明示的に選び直す。未確認の解除は完了と扱わず、Mac の「拒否済み・解除待ち」も確認する。
4. 自動 native 試験の `testPhoneXtermShowsReplayAndLiveWithoutRepliesClipboardOrResizeAndBackDetaches` は実 WKWebView の replay/live、DA/DSR/OSC/kitty 応答拒否、OSC 52、固定 grid、Tab 切替、戻る、native suspend、描画 ACK 停止時の専用接続解除を見る。`Native.xcresult` の xterm screenshot で文字が実際に描画されていることも確認する。CSP は xterm が生成する inline style を許すが、外部 script、navigation、frame、network と任意 bridge operation は拒否したまま。

## 基本入力と送達状態

1. Mac と共有する入力であり、同時操作は混ざる。Mac renderer待ちの間は入力欄と送信が無効であることを確認する。利用可能になったら短い文字を入力して「送信（改行）」を押し、Mac と iPhone の同じ Terminal Session に結果が出ることを見る。押下直後は送信中を表示する。入力中の次の送信は受け付けず、offline queue は持たない。
2. 「受理」は中継が受け取ったという意味で、実行成功とは扱わない。未送信は renderer・接続状態と decode後64KiBの上限を確認する。送達不明では自動再送せず、出力で二重実行を避ける。送達不明の view は入力を止め、必要なら一覧から明示的に選び直す。失効前に受理した入力は失効開始後に届く場合があり、取り消せない。
3. Mac の renderer停止・reload・Terminal Session置換で入力が止まることを見る。6秒の検知までに受理した入力は取消できない。iPhone が自動応答担当になることはない。完全な IME、paste分割、補助キー、touch操作の完成確認は後続の実機試験と分ける。
4. native の `testZBasicSharedInputIsAcceptedOnceAndMacParseStallDisablesIt` は実 Simulator のフォーム、限定 bridge、WSS、実 relay、fake ptyd の byte一致と入力拒否を確認する。`testPhoneXtermShowsReplayAndLiveWithoutRepliesClipboardOrResizeAndBackDetaches` も残し、live/replay query、clipboard、size、背景・表示解除を確認する。前者の fixture ready は本物の Mac renderer の代わりではない。Mac の非表示 open と応答は desktop-dev の実行で別途確認する。

## 記録と片付け

自動 TS、native/Simulator、署名済み実機の結果を別々に記録する。実 iPhone がないときはカメラ、実機署名、tailnet 到達性、実操作、VoiceOver、背景・lock・実回線切替を未実施として #460 に残す。Simulator 成功で置き換えない。

試験後は Mac の remote を無効化し、自分の隔離 desktop を同 skill の手順で終了する。手で起こした Simulator だけを終了・削除する。ユーザーの app、別 session の Simulator、Tailscale 設定を片付けない。
