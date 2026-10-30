# iPhone 端末の実機受け入れ記録

2026-10-30 時点の #453・#460 の部分記録。受け入れは継続中であり、完了ではない。以下の「観測」は記載した条件での結果で、各受け入れ項目全体の達成を意味しない。未確認は失敗の断定ではない。追加試験後にこの記録を更新する。

## 環境と証跡

隔離した Mac の `MONICA_HOME`、実 iPhone、個人用 Tailnet を使用した。正式 iPhone build の source は `9d2b1c8`、integration は同一 tree の `11c0921a`。診断 copy の結果は正式 build と分ける。署名・操作の経過と生の証跡は実施環境の `signing/progress.md` と `460-*.json`、`460-phone-*.png` にある。以下はファイル名だけを示し、証跡のローカル保存を前提とした再確認用の参照である。

Xcode と Developer Mode を使い、Personal Team で署名した app の導入と起動を実機で確認した。当該 profile の期限は 2026-11-06 02:44:49 UTC。無料 Personal Team の provisioning は通常 7 日で期限切れになる。再署名・再導入は [iOS 開発手順](../../.claude/skills/ios-dev/SKILL.md) の「実 iPhone へ導入」を参照する。共有設定に Team ID を保存しない。

自動検証として TS 2314 件、native 17 件の成功を記録している。Rust 153 件は既存結果の再利用である。これらは実機試験ではない。詳細は `signing/progress.md` を参照する。

## 実機で観測したこと

| 項目 | 操作と観測 | 証跡 |
| --- | --- | --- |
| 接続と共有入力 | Mac で登録を承認し、正式 build の iPhone から既存 Terminal Session に入力した。`FINAL_OK` が同じ desktop Tab に一度現れた。 | `460-final-product-input.json`、`signing/progress.md` |
| 未表示 Tab の問い合わせ | iPhone で Mac の未表示 Tab を開き、実 PTY から新しい DA、DSR、OSC 10・11、kitty 問い合わせを発生させた。phone 接続中は各応答が一度で、実 PTY の bytes は Mac xterm の観測列と一致した。別の Backend 停止中の実行でも各一度だった。Mac の focus、非空 selection、選択 Tab と両 grid は変わらなかった。非ゼロの未読 fixture は使っていない。 | `460-query-live-result.json`、`460-query-backend-stopped-result.json`、`signing/progress.md` |
| IME・キー・コピー | 正式 build で変換確定と変換中の削除が送信されないことを利用者が確認し、明示送信した `IME_日本語` は一度現れた。実 TUI で補助キー8種類と Ctrl-C を確認した。複数回のキー入力は利用者の意図した反復だった。長押し選択・コピーから明示 paste した `COPY_OK` は一度現れた。絵文字は診断 copy での確認に限る。 | `460-formal-ime.json`、`460-tui-keys.json`、`460-after-copy-paste.json` |
| 表示と resize | 利用者は通常 buffer の縦横 pan、倍率、回転と keyboard 操作を確認した。Mac の Accessibility API で窓を 1100×720 から拡大すると、PTY は 96×39 から 116×45 になり、iPhone の100文字行は折り返しから非折り返しに変わった。外側の窓サイズは戻したが、rows はその後 33 となり、元の grid が復元したとは言えない。 | `460-mac-resize-result.json`、`signing/progress.md` |
| 復帰 | 診断 copy で lock 復帰と Wi-Fi・モバイル回線の切替後に各 marker が一度現れた。正式 build で利用者が Tailscale を off/on した後の `TAILNET_OK` も一度現れた。Tailscale の背景移行をまたぐ送達不明表示の維持は別途確認していない。 | `460-after-lock.json`、`460-after-network-switch.json`、`460-tailnet-reconnected.json` |
| 失効 | 実機の失効後、phone は失効表示と入力無効を示した。Mac 側では `detachPending` が false となり、local shell の入力は継続した。新しい QR で再登録し、接続できた。解除 ACK 不達の注入は行っていない。 | `460-revocation-ui.json`、`460-reregistered-ui.json`、`460-phone-revoked.png` |
| Backend と最小化 | Backend 停止中と再起動後に Mac の local 入力を確認した。phone に両 marker と入力可能表示が現れた。Mac 窓を Accessibility API で最小化した別試行では新規5問い合わせが各一度応答した。この試行では Mac xterm の追加 spy は使っていない。 | `460-backend-recovery-result.json`、`460-query-minimized-result.json` |
| renderer 停止 | Mac WebView に14秒の busy loop を注入した。bridge 自体は timeout したが、phone は renderer 待ちと入力無効を表示し、その後 ready に戻った。停止中の入力操作は試していない。 | `460-phone-renderer-frozen.png`、`460-phone-renderer-restored.png`、`460-renderer-responsive.json` |
| 送達不明 | Backend を Send **前**に停止した。利用者は送達不明を報告し、再開後に実 marker が一度実行された。Backend 再起動後も marker は一度のままで、送達不明と入力無効が維持された。受理後の ACK 消失を注入した試験ではない。 | `460-uncertain-after-resume.json`、`460-uncertain-restart.json`、`460-phone-uncertain-recovered.png` |
| 途中 paste | 148859 bytes の実機 paste で Backend を Send 前に停止した。180秒 watchdog が再開した後、実 raw PTY は先頭 65536 bytes を一度だけ受信し、残り 83323 bytes は届かなかった。Backend 再起動後も先頭分だけで、phone は確認済み 0 bytes、送達不明と入力無効を維持した。raw receiver は正常に停止した。最初の chunk の ACK 成功後に次の ACK を失う試験ではない。 | `460-paste-received.json`、`460-paste-restart.json`、`460-phone-paste-recovered.png` |
| Mac app 再起動 | 同一 source の Mac app を終了・再起動した。完全な Layout JSON、2つの Session ID、実 shell PID と ptyd PID が維持され、phone は再登録なしで新しい marker と ready を表示した。旧版から新版への更新や OS 再起動ではない。 | `460-desktop-restart-result.json`、`460-phone-desktop-restarted.png`、`signing/progress.md` |

## Mac の headless 更新 component 試験

隔離 Mac で、旧 `21f7bd4` と現行 `24f31c8` の実行時 checkout がともに tracked-clean であることを確認した。旧 Backend が作った実 daemon と shell、Terminal Session ID は現行 Backend への移行後も維持された。Layout は完全一致し、非空の `runspace`・`tab`・`terminal_session` 各1行の全値も前後で一致した。

現行製品の Rust `PtydClient` は旧 daemon に hello、replay なしの fresh attach、write を行い、旧 shell で設定した非 export 変数を使う barrier の実 output を受信して detach・close した。入力文に完全な marker は含まれず、echo だけでは成功しない。旧・現行 Backend、daemon、shell の4 process の不在を確認した後に probe は成功を記録した。

証跡は `460-upgrade-proof-v3-result.md`、`460-upgrade-proof-v3-review.md`、`probe.log`、`source-manifest.log`、`cleanup.log`。これは Mac の headless component 試験であり、実 iPhone、実 Shell app、private relay、GUI renderer を通る試験ではない。3 table の fixture 以外のデータや全 daemon spawn 試行は観測していない。

## 所有者が外した条件と残余リスク

所有者は個人用 Tailnet と Tailnet Lock を使い、既存の広い grants を変更しないことを承認した。指定 iPhone から指定 port だけに限定するネットワーク側の条件は今回の受け入れ対象外であり、ネットワーク側の許可外端末拒否は確認済みではない。Tailnet Lock が有効であることはローカルで観測したが、Lock は ACL や grants の代替ではない。他の参加済み端末が接続口に到達できるリスクが残る。

HTTPS、TLS pin、端末登録、資格、TCP source address 照合、失効による入力拒否と接続解除は引き続き必須である。実 TLS listener への無資格・誤資格の8要求は Mac client から 401 だった。これは phone からの試験でも、正しい資格を異なる source から使う試験でもない。証跡は `460-real-auth-refusals.json`。

所有者は Reduced Motion の実機確認のみを省略した。試験済みではない。VoiceOver、文字拡大、その他の確認は免除されていない。

## 未確認と残作業

- IME の取消、TUI の縦横移動と倍率、safe area・keyboard 遮蔽、VoiceOver の操作名、文字拡大。回転と keyboard 開閉による PTY resize 不在も独立した測定が必要。絵文字は診断 copy の実 iPhone で観測済みだが、正式 build では再確認していない。
- 非ゼロ未読 fixture での未表示 Tab 選択時の未読維持。
- 背景復帰と lock・回線切替をまたぐ送達不明や途中 paste の非再送。
- 未登録、失効資格、異なる接続元の app 側拒否の未観測条件を実 listener で確認すること。特に有効な資格と異なる TCP source の組み合わせ、失効解除 ACK 不達、identity 変更と期限切れは未確認。無資格・誤資格の8要求の 401 は上記のとおり観測済み。
- 遅い phone、renderer 停止中の入力拒否の実操作、Mac sleep と復帰。利用者が sleep 指示後に `SLEEP_OK` を報告したが、電源ログ 41063 行に Sleep/Wake event はなく、kernel の sleep/wake 時刻もゼロだった。実 OS sleep は未確認。
- 更新時のデータと稼働 PTY の維持、remote 導入時の daemon 非置換は、上記の headless component と3 table の fixture に限って観測した。実 Shell app、private relay、GUI renderer を通る更新経路や他のデータは未確認。同一 build の Mac app 再起動時の Layout・Session・PID の維持も上記で観測済みだが、更新の試験ではない。
- 試験終了後の所有する試験 process、専用 Simulator、資格、隔離 home の安全な片付け。現在は試験が継続中であり、最終片付けは未確認。

今回の証跡は最小化時の応答元を追加 spy で同定していない。また、上の Backend 停止試行は受理後の ACK 消失や、最初の paste chunk の ACK 成功後に次の ACK を失う場合を示さない。これらの注入や spy は追加の観測方法であり、その方法自体を実機受け入れの追加条件にはしない。

再実行の操作は [iOS 開発手順](../../.claude/skills/ios-dev/SKILL.md) と [desktop 開発手順](../../.claude/skills/desktop-dev/SKILL.md) を参照する。ただし今回のネットワーク条件は上記の所有者承認を優先し、policy を変更しない。履歴は保持範囲の末尾 replay に限られ、TUI の完全な復元や過去の未回答 query への再応答は保証しない。
