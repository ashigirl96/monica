# Workbench の UI 状態と sidebar と status dot

Workbench Ledger に載せない Workbench の画面の状態と、sidebar の Rail、Agent Session の状態と未読の見せ方。どれも `packages/workbench/src/ui` に置く。キーの割り当ては `apps/desktop/src/use-shortcuts.ts` と、jump モード（Ctrl+T の後）の `packages/workbench/src/ui/jump-mode.ts` にある。

## UI 状態

- webview の localStorage に置く（ADR-0014）。中身は active な Runspace とその active Tab、sidebar の開閉と幅（160〜360、既定 200）、UI zoom（0.8〜1.6、既定 1）、選んだ Tile（field は `tile`。値は小文字にした `owner/repo`、Repo の外は `outside`、active な Runspace の Tile に従うときは null）、畳んだセクション（`<Tile の key>:<bench|runspaces>` の一覧）。旧 Monica の `ui-state.json` から、Space、Work Board、window ごとの入れ子を除き、Tile とセクションを足した形。
- 端末の font size と、active でない Runspace の active Tab は保存しない（旧 Monica どおり）。
- 書き込みは 500ms の debounce。localStorage は同期で読めるので、旧 Monica の render 前の hydrate は要らない。
- 保存した id が `layout.get` に無ければ、先頭の Runspace と、その先頭の Tab に戻す（旧 Monica の `resolveWorkbenchActive`）。読めないか壊れていれば既定値で始める。
- 見たこと（未読）は UI 状態に置かず、Workbench Ledger に置く（ADR-0021、下の「未読」）。
- webview が持つ Backend の写し（layout、Terminal Session と Agent Session の一覧）は、`changes` の合図の後に読み直すまで古く、起動の直後は空。Tab を閉じるような取り消せない操作の条件は、その場で Backend に聞いて決める（Ctrl+T → d の確認。`docs/packages/workbench-ledger.md` の「Runspace と Tab」）。

## sidebar

左端に Tile（`GLOSSARY.md`）を縦に並べた Rail を置き、選んだ Tile の Runspace を右の一覧に出す。見た目は #191 の canvas の E3。

- Runspace の Repo（`GLOSSARY.md`）は、Bench なら slot `benchLabelOf` が返す Task の Repo、ほかは一番左の Tab の cwd（Tab が無ければ Runspace の cwd）を `repo.of` で引いたもの（`docs/packages/desktop.md`）。active な Tab で決めないのは、Tab を切り替えても行が別の Tile へ移らないようにするため。
- Tile は Repo ごとに 1 つ置き、Pinned を除いた Runspace の並びで最初に出てきた順に並べる。drag での並べ替えは無い。Tile の key は Repo 名を小文字にしたもので、Task の Repo（GitHub の nameWithOwner）と checkout の path の大小文字が違っても同じ Tile にまとめる。GitHub の Repo 名は大小文字を区別しないため。Repo の外の Tile（「その他」、folder の icon）は区切り線の下の一番下に置き、行が無くても出す。
- Tile の字は repo 名の頭文字、色は repo 名から 8 色の 1 つを決まって選ぶ。dot の緑・琥珀・赤・灰は使わない。
- 選んだ Tile の repo 名と owner は、sidebar の上端の WORKBENCH の表示の右に出す。Repo の外の Tile を選んでいるときは何も出さない。
- Tile を押すと、その Tile で最後に active だった Runspace を、その Runspace で active だった Tab ごと active にし（未読の Tab へは移らない）、選んだ Tile を active な Runspace に従わせる。「最後に active」は、この session で active にした順と、起動したときに戻した active な Runspace から決める。その Tile の Runspace をどれも active にしていなければ、Tile の Ledger の並びで先頭の Runspace を、Tile に Runspace が無ければ Tile だけを選び、active な Runspace は変えない。押すと端末まで替わるので、ほかの Tile の一覧を覗くだけのことはできない。Tile を押して Repo を移るのと、その Repo で最後に触っていた所へ戻るのを、1 つの操作で済ませるため。
- ⌘1〜⌘9 は上から 1〜9 番目の Repo の Tile を、⌘0 は Repo の外の Tile を押すのと同じことをする（Slack の workspace の切り替えにならう）。番号の Tile が無ければ何もしない。Tile の title に番号を出す。⌘ だけを 0.1 秒押し続けると、Repo の各 Tile の右上に repo 名を、9 番目までの Tile には番号も添えて出し（Repo の外の Tile には出さない）、⌘ を離すか、ほかのキー・click・窓の focus が外れると消す。⌘ を押したまま Rail を scroll しても、名前は付いていかない。
- cd や Tab の移動で一番左の Tab の Repo が替わり、Pinned でも Bench でもない Runspace が前にいた Repo と別の Repo に入ったら、webview がその Runspace を Workbench Ledger の並びの末尾へ動かす（`runspace.move`）。Repo の外で始まった Runspace が初めて Repo に入ったときも動かす。行は入った Tile の一番下に出て、Tile の無かった Repo の Tile は、ほかの Runspace のある Repo の Tile の下に足される。抜けた Tile は、その Runspace が Tile の並びを決めていた（Tile の先頭の行だった）なら、下がって ⌘ の番号が変わることがある。Repo が初めて引けて Tile が決まるとき（起動したときや Runspace を作ったとき）、Repo の外へ出たとき、外から前と同じ Repo へ戻ったときは、drag で並べた位置を崩さないよう動かさない。
- 一覧の上には、どの Tile を選んでも Pinned（pin された Tab を持つ Runspace）を出す。Pinned の行はどの Tile にも入らない。
- 選んだ Tile の中は、上から Bench・Runspaces のセクションに分け、行の無いセクションは出さない。セクションが 2 つ以上あるときだけ見出しを出し、見出しを押すと畳む。畳むと行を全部隠し、見出しに行の数と未読の Tab の数を出す。見出しの無いセクションは、前に畳んでいても行を出す。
- Runspace を active にする経路（行、Tile、jump hint、key で巡る、Runspace を作る、Tab が移る）が Pinned でない Runspace へ移すと、選んだ Tile はその Runspace の Tile に従う（UI 状態の `tile` を null にする）。Tile の key を書き込まないのは、Repo が `repo.of` を待って後から決まるので、決まる前の「Repo の外」に Tile を固定しないため。Pinned の Runspace へ移すときと、Tab を pin して active な Runspace が Pinned になるときは、そのとき見えていた Tile に留める。Runspace の無い Tile を押すと、その Tile に固定する。選んだ Tile が無くなっていれば active な Runspace の Tile を、それも無ければ先頭の Tile を出す。起動の直後に保存した Tile がまだ無くても、保存した値は消さない。
- Tile とセクションの見出しは、押しても端末から focus を外さない（mousedown の既定の動作を止める）。見出しと、active な Runspace の Tile や Runspace の無い Tile は表示する Tab を変えないので、押した後もそのまま Tab の claude に打てるようにするため。押した後に focus を戻す形にしないのは、一度 blur すると xterm が focus を知らせる mode（DECSET 1004）を立てた app に focus out と in を送るため。別の Runspace を開く Tile と行は、その Runspace を active にして端末に focus を戻す。
- Tile とセクションの見出しは、click ではなく mousedown で動く（行と Tab が pointerdown で動くのと同じく、押した時に動く）。WKWebView は trackpad の tap（tap-to-click）を up、down の順で届けるので、各 tap の up は 1 つ前の tap の down と組になり、click は 2 つの tap の位置の共通の祖先に飛んで、押した button には届かないため。click で動くのは、キーボード（Enter・Space）の click（`detail` が 0）だけにする。
- key で巡る（⌥J / ⌥K）のと jump hint は、画面に見えている行（Pinned と、選んだ Tile の開いたセクション）を上から順に扱い、畳んだセクションの行は飛ばす。active な行が見えていないとき（畳んだセクションにあるときや、Runspace の無い Tile を押してほかの Tile が出ているとき）は、下へは先頭の行から、上へは末尾の行から巡る。別の Repo の Tile へは Tile を押すか ⌘ の数字で移り、巡っても Tile をまたがない（Repo の Tile が 9 を超えると、10 番目からの Repo の Tile へはキーで移れない）。
- Runspace の並べ替え（drag と jump モードの ⇧J / ⇧K）は同じセクションの中に限る。Workbench Ledger の並びは 1 本なので、セクションをまたいで動かしても見た目の位置にならないため。key で下へ動かすときは、自分を下の行の位置へ動かさず、下の行を自分の位置へ動かす。Tile の順はセクションの先頭の行の位置で決まるので、間にある別の Repo の Runspace を越えると Tile の順が入れ替わるため。

### 行

- 1 行目は title、2 行目はその他の情報。title は `...` で切らず全文を折り返す（`overflow-wrap: anywhere` と `text-wrap: pretty`。WKWebView では `word-break: auto-phrase` が効かない）。title の横には未読の数だけを置き、行頭の icon は出さない。
- title は、Bench なら Issue の title、ほかは active な Tab の端末の title。Claude Code が頭に付ける spinner の記号（`·✢✳✶✻✽`）も、Agent が動いているかの印として落とさずに出す。端末の title が無いか path（`/`・`~`・`~/` で始まる）なら、active な Tab の cwd を等幅で出す。形は `repo.of` の `path` で、Repo の中なら checkout か worktree の top からの相対 path（top ならその directory の名前）、外なら home を `~` に畳んだ path。`repo.of` が答えるまでは cwd の末尾の 2 つを出す。
- 2 行目は行の種類ごとに次を並べ、並べるものが無ければ出さない（`N Tabs` も出さない）。Agent の状態は 2 行目の左に置く。1 行目に置くと、折り返す title が狭まるため。
  - 普通の Runspace の行（Pinned と Repo の外の行も含む）は、Tab の dot を色ごとに数えた数（下の「数」）、active な Tab が linked worktree にいるときの branch。Pinned の行は続けて Repo の Tile の色の四角と repo 名（Repo の外なら cwd）、Repo の外の Tile の行は続けて cwd（title が path なら出さない）。branch・四角と repo 名・cwd は数の後ろに置き、入りきらなければそちらを切る。branch を出すのは、Bench を使わずに作った worktree の branch を sidebar から読めるようにするため。数は手空きも数えるので、claude が居る間は branch が無くても 2 行目が消えず、turn が終わるたびに行の高さが変わらない。
  - Bench の行は、準備中・準備失敗なら枠で囲んだその文字、代表の Tab の dot、端末の title（path でないとき。1 行で切る）、`#<n>`。Pinned の行は `#<n>` の代わりに Repo の Tile の色の四角と `<repo>#<n>`。dot と端末の title は代表の Tab から取り、Agent Session のある Tab が無ければ dot を出さず、端末の title は active な Tab のもの。準備中の Bench には Tab がまだ無いので、枠と `#<n>` だけになる。
- Bench の代表の Tab は、Agent Session のある Tab から 質問・許可 > エラー > 動作中 > 手空き > 未観測 の順で 1 つ選び、同じ順位なら左の Tab を選ぶ。Task の表示状態の集約（手空き > 未観測 > 動作中）と順が違うのは、動いている claude を手空きで隠さないため。左を選ぶのは、Tab の並びと合わせて端末の title が飛び回らないようにするため。Task の表示状態は使わず、Bench の Runspace にある Tab から導く（ADR-0005）。

### 数

- 行の 1 行目の数は「未読」の節のとおり。
- 普通の Runspace の行の 2 行目の数は、その Runspace の Tab の dot を色ごとに数えたもの。動作中（緑）・質問と許可（琥珀）・エラー（赤）・手空き（灰）・未観測（灰の輪）の順に dot と数字の組で並べ、0 の色は出さない。語は付けず、hover の title に「動作中の Tab 2」の形で出し、行の `aria-label` にも同じ語を足す。1 つの Runspace に Tab と claude が複数あると、1 つの dot に畳んでも何が起きているか読めないため、畳まずに数える。
- Tile の角には、その Tile を押して出てくる行（Bench・Runspaces）の未読の Tab の数の和を出し、0 なら何も出さない。Pinned は常に見えているので数えない。Agent の状態の数や dot は出さない。
- 畳んだセクションの見出しには、その行の未読の Tab の数の和を出す。Agent の状態の数や dot は出さない。

## status dot

Tab の dot（label の左）は、その Tab の Terminal Session の live な Agent Session の状態を写す。材料は `agentSession.list`。

| Agent Session | dot |
|---|---|
| 動作中 | 緑の点滅 |
| 質問・許可 | 琥珀の点滅 |
| エラー | 赤 |
| 手空き | 灰 |
| 未観測 | 灰の輪（中抜き） |
| 終了、または Agent Session が無い | 出さない |

- hover の title は状態の語にし、質問と許可はそこで見分ける。
- 手空きは灰の塗りにし、未観測の灰の輪とは塗りで分ける。琥珀の薄い版では、行の数として質問・許可の琥珀の隣に並ぶと見分けにくいため。灰は Tile の色（上の「sidebar」）にも未読の印にも使わない。
- plan 承認の色は持たない。plan の承認は許可の一種で、ExitPlanMode は自動承認されて待ちにならない（#16）。
- Terminal Session の dot（label の右。exited / lost / failed）は旧 Monica のまま残す。
- sidebar の行も、2 行目に Tab の帯と同じ色と点滅の dot で Agent の状態を出す（上の「行」と「数」）。
- 状態と色の対応は Task の型を借りない。旧 Monica の `lib/status-config` は Task の `DisplayStatus` を借りていたが、workbench は task を import しない（ADR-0005）。

## 未読

`GLOSSARY.md` の未読を Tab の帯と sidebar に出す。未読かどうかは Backend が `agentSession.list` の `unread` で渡し（ADR-0021、`docs/packages/workbench-ledger.md` の「未読」）、webview は導かない。見た目は #190 の canvas の E3 の行と Tab の帯。

- Tab の帯は、未読の Tab の dot を白い輪で囲んで点滅を止め、label を白の太字にする。
- sidebar の行は、未読の Tab の数を title の右に白地に暗い字の丸で出し、title を白の太字にする。数を 2 行目に置かないのは、通知が来るたびに行が伸び縮みするため。見たうえでまだ待っている Tab は未読の数からは消えるが、2 行目の数と dot には残る。
- 未読の印は白にそろえる。dot の緑・琥珀・赤・灰と重ならないため。
- 行を押すと（jump hint の Ctrl も同じ）、その Runspace に未読の Tab があれば一番左のそれを開き、無ければ最後に見ていた Tab を開く。dev では通知を押しても Tab へ移れず、通知を見逃した後にも sidebar から来るので、行から 1 手で着くようにする。key で Runspace を巡るときは、今どおり最後に見ていた Tab を開く。
- 窓が前面にあり、表示している Tab（active な Runspace の active な Tab）の Agent Session が未読なら、webview は一覧で読んだその通知の `notifiedAt` を添えて `agentSession.markSeen` を呼ぶ。見た瞬間に既読にし、見ていた時間は問わない。Tab を切り替えるたびには呼ばない。
- 窓が前面かどうかは、Tauri の `getCurrentWindow()` の `onFocusChanged` の購読が張れてから `isFocused()` で読む（`core:default` の権限で足りる）。読む間に event が届いたら、読んだ値は捨てる。別の app が前面にあるときも、窓を最小化したときも event が届くことを実機で確かめた。前面でない間は、表示している Tab でも見たことにしない。前面に戻ったときに、表示している Tab を見たことにする。
- `agentSession.list` を読み直すたびに Agent Session は別の値になるので、表示している間に届いた次の通知も、読み直した時点で見たことにする。`markSeen` が重なっても、Backend は未読でない行に何も書かない。
- monica が前面にある間は通知のバナーが出ない（ADR-0013、ADR-0022）。active でない Runspace の通知には、行の数で気づく。

## 通知のクリック

release で通知を押すと、Shell がその通知の Terminal Session を webview に渡し（`docs/packages/notifications.md` の「クリック」）、webview はその Terminal Session を表示している Tab を選ぶ（ADR-0022）。

- webview は `notification-clicked` の listen を張ってから、Shell の `take_notification_click` command で持っている Terminal Session を取り出す。event を受けたときも同じ command で取り出す。通知で起こした monica では、webview が listen を張る前にクリックが届くため。
- 取り出すと Shell から消えるので、effect を片付けた後に届いた答えも捨てずに Tab を選ぶ（dev の StrictMode が effect を張り直しても取りこぼさない）。
- layout を読み直してから選ぶ。窓が隠れている間は webview の JS が止まり、その間に CLI などで開いた Tab が layout に載っていないため。Backend に繋がっていなければ（通知で起こした直後や Backend の再起動中）、繋がって次に読めた layout で選ぶ。再起動中も layout は前の値のまま残り、その間に開いた Tab が載っていないため。
- その Terminal Session を表示している Tab があれば、その Runspace と Tab を active にし、端末に focus を移す。その Runspace が Pinned（pin された Tab を持つ）でなければ、別の Tile を覗いていても、その Runspace の Tile に戻す。Pinned の Runspace はどの Tile を選んでも一覧の上に見えているので、そのとき見えていた Tile に留める。Bench は pin しても Tab を切り出さないので、押された Tab が pin されていなくても、同じ Runspace の別の Tab が pin されていれば留める。
- 表示している Tab が無ければ（Tab を閉じた、Terminal Session が終わった、pin の張り直しで Terminal Session が替わった）、何もしない。Tab を選べば、既読は上の「未読」の規則で書かれる。
