---
name: ios-dev
description: iPhone app の build・Simulator 試験・Xcode 実機署名・QR 登録・端末閲覧・IME・補助キー・text paste・選択とコピー・表示解除・失効を行うときに使う。Mac の app の入れ替えとは区別する。
---

## 自動検証

1. macOS、Xcode、iOS 26.2 以降の Simulator runtime、Bun、repo の Rust toolchain を用意する。`xcodebuild -version` と `xcrun simctl list runtimes` で確認する。deployment target は 26.2。UI の実装・確認には `.agents/skills/apple-design/SKILL.md` を読む。
2. repo root で `bun install --frozen-lockfile`、`bun run check:ts`、`bun run check:ios` を実行する。iOS の React build だけなら `bun run --cwd apps/ios build`。native script は専用 Simulator と隔離 TLS fixture を作り、実 Rust Shell relay・既存 fake ptyd と実 WKWebView/xterm の native 試験、署名なしの iphoneos build を実行し、自分が作った Simulator・process・一時資格を終了時に片付ける。
3. 結果は `MONICA_IOS_LOG_DIR` に指定した directory、未指定なら script が表示する `/tmp` の directory で読む。`xcodebuild.log`、`Native.xcresult`、`iphoneos-build.log` を確認する。Simulator の app には Keychain 用の ad-hoc signature が必要だが、Apple account、有料契約、署名証明書、provisioning profile は使わない。実機へ入れたことを意味しない。
4. `project.yml` を変えたときは React を build し、`cd apps/ios && xcodegen generate` を実行して、生成 project も commit する。XcodeGen は project の変更時だけ必要。通常の CI/build はチェックインした project を使う。

## 実 iPhone へ導入

1. React を build して `apps/ios/Monica.xcodeproj` を Xcode で開く。scheme は `Monica`。Signing & Capabilities で自分の Personal Team と一意な Bundle Identifier を選ぶ。repo の共有設定に自分の Team ID を保存しない。
2. iPhone を Mac と接続して信頼し、設定の Privacy & Security から Developer Mode を有効にする。Xcode の destination にその iPhone を選び Run する。無料 Personal Team の provisioning は通常 7 日で期限切れになるので、期限後は同じ Team・Bundle Identifier で再署名して入れ直す。TestFlight と有料 Developer Program は不要。
3. この app は登録、既存 Workbench 一覧、選んだ Terminal Session の出力閲覧を提供する。同じ Mac renderer が利用可能な間だけ共有入力と補助キーを送れる。Tab を作る・閉じる操作、自動での端末再接続はない。

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

## キーボード・text paste・選択を確認する

1. 入力は Mac と共有される。隔離した Terminal Session で入力欄に日本語を変換し、確定、取消、削除、絵文字を試す。下書き中は送らず、「文字だけ送信」か「送信（改行）」で一度だけ送る。IME の確定 Enter では送信しないことを実キーボードで確認する。Mac renderer待ちでは入力欄と補助キーと paste が無効になる。
2. Ctrl を選び、`c` の1文字を入力して送る。Ctrl は改行を付けず送る。Esc、Tab、矢印、削除、Enter は下書きと別に直接送る。矢印は現在の xterm の DECCKM に従い、通常は CSI、application cursor mode では SS3 を送る。TUI の開始・終了後に上下左右を確かめる。押下色と「送信中（受理確認前）」を確認し、ACK 前の反応を受理と扱わない。「受理」は中継の受理だけを意味する。送達不明は出力を確認し、同じコマンドを自動で再送しない。
3. 自分の試験用 clipboard にテキストを置き、「貼り付け…」から全量と改行を確認して送る。clipboard の読取りだけでは送らず、取消も試す。UTF-8 256KiB超過では全量を拒否し、上限内は64KiB以下の chunk を順送する。途中の未送信・送達不明で残りが止まり、受理済み byte数が出ることを確認する。fileと画像は送れない。実機の貼り付け許可を拒否した場合も試す。ユーザーの clipboard を試験で上書きせず、自分の Simulator では元の内容を退避して戻す。
4. 「選択・コピー」で表示時点の buffer を text-only に切り替える。長押しで範囲を選び、OS のコピーか「選択範囲をコピー」を使う。未選択なら全体をコピーする。表示へ戻ると live 出力へ戻る。OSC 52 と file 操作は許さず、コピーは利用者の操作だけで行う。
5. 通常 buffer の末尾が見えることを確認し、履歴を縦に動かしている間は新しい出力で表示位置を奪われないことを見る。横移動と A＋・A−を試す。TUI でも表示の縦横移動を試す。端末表示だけは独自の1本指 pan が履歴と固定 grid の縦横移動を扱い、慣性はない。移動中の方向変更、上下左右の端、touchcancel、2本目の指での中断を確かめる。選択用 textarea・入力欄・操作領域は OS の gesture を使う。実指での追従・操作感は #460 で受け入れ判断し、Simulator の TouchEvent 成功で代用しない。phone の gesture を TUI の mouse入力や矢印へ送らない。TUI 自体を動かすときだけ補助キーを使う。回転、keyboard の開閉、Dynamic Type の変更では PTY の rows/cols が変わらず、Mac の resizeだけに追従することを確認する。
6. safe area と keyboard の上に接続状態、補助キー、入力、送達状態が見えることを確認する。大きい文字や狭い landscape では操作領域をスクロールして各操作へ到達する。VoiceOver で Ctrl、Esc、Tab、上下左右、削除、Enter、拡大、縮小、入力、出力選択の名前を読む。Dynamic Type、Reduce Motion、Reduce Transparency、Increase Contrast、light/dark を変え、読みやすさと即時 feedback を確認する。UI は不透明な system色と静的な押下色を使い、通信を animation 待ちにしない。
7. Mac の renderer停止・reload・Terminal Session置換で入力が止まることを確認する。6秒の検知までの受理は取消できない。途中で切れた paste は接続復帰でも再送しない。native の `testZZPhoneComposerSyntheticCompositionKeysTextClipboardAndFixedGrid` は実 WKWebView 上の synthetic composition、正確な補助キー byte、明示 clipboard、file URL拒否、実 xterm 上の TouchEvent による normal履歴とnormal/TUI縦横pan、後続の実 Create 到達後の Write/Resize不在、zoom前の基準数と固定grid、compact viewportを見る。synthetic eventと選択範囲APIは実IME・実タッチ・OSの長押しmenu・貼り付け許可の代わりではない。
8. `testZZZSimulatorSoftwareKeyboardKeepsWKWebViewAboveItWithoutPTYResize` は実 Simulator の software keyboard の表示・非表示通知、WKWebView の keyboard layout guide と PTY resize 不在を見る。実際の IME key入力ではなく focus による OS keyboard の確認である。既存 `testZBasicSharedInputIsAcceptedOnceAndMacParseStallDisablesIt` と read-only xterm 試験も残す。fixture の renderer ready は本物の Mac renderer を代替しない。Mac の hidden open と query応答は desktop-dev で別途確認する。自動byte境界は `remote-workbench.test.ts` と実認可relayの `remote-access.test.ts` で見る。実際に使った Simulator の `simctl ui <id> content_size`、`increase_contrast`、`appearance` の値と screenshot を記録する。

## 記録と片付け

自動 TS、native/Simulator、署名済み実機の結果を別々に記録する。実 iPhone がないときはカメラ、実機署名、tailnet 到達性、実操作、VoiceOver、背景・lock・実回線切替を未実施として #460 に残す。Simulator 成功で置き換えない。

試験後は Mac の remote を無効化し、自分の隔離 desktop を同 skill の手順で終了する。手で起こした Simulator だけを終了・削除する。ユーザーの app、別 session の Simulator、Tailscale 設定を片付けない。
