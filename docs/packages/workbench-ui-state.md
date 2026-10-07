# Workbench の UI 状態と sidebar と status dot

Workbench Ledger に載せない Workbench の画面の状態と、sidebar の Repo のレール、Agent Session の状態と未読の見せ方。どれも `packages/workbench/src/ui` に置く。

## UI 状態

- webview の localStorage に置く（ADR-0014）。中身は active な Runspace とその active Tab、sidebar の開閉と幅（160〜360、既定 200）、UI zoom（0.8〜1.6、既定 1）、選んだ札（`owner/repo`、Repo の外は `outside`、active な Runspace の札に従うときは null）、畳んだセクション（`<札>:<bench|runspaces|detached>` の一覧）。monica の `ui-state.json` から、Space、Work Board、window ごとの入れ子を除き、札とセクションを足した形。
- 端末の font size と、active でない Runspace の active Tab は保存しない（monica どおり）。
- 書き込みは 500ms の debounce。localStorage は同期で読めるので、monica の render 前の hydrate は要らない。
- 保存した id が `layout.get` に無ければ、先頭の Runspace と、その先頭の Tab に戻す（monica の `resolveWorkbenchActive`）。読めないか壊れていれば既定値で始める。
- 見たこと（未読）は UI 状態に置かず、Workbench Ledger に置く（ADR-0021、下の「未読」）。

## sidebar

左端に Repo の札を縦に並べたレールを置き、選んだ札の Runspace を右の一覧に出す。見た目は #191 の canvas の E3。

- Runspace の Repo（`GLOSSARY.md`）は、Bench なら slot `benchLabelOf` が返す Task の Repo、ほかは一番左の Tab の cwd（Tab が無ければ Runspace の cwd）を `repo.of` で引いたもの（`docs/packages/desktop.md`）。active な Tab で決めないのは、Tab を切り替えても行が別の札へ移らないようにするため。Detached の Terminal Session は、その行の cwd（Tab が閉じる前に最後に知らせた cwd。`docs/packages/workbench-ledger.md` の `tab.cwd`）で引く。
- 札は Repo ごとに 1 つ置き、Pinned を除いた Runspace の並び、続いて Detached の並びで最初に出てきた順に並べる。drag での並べ替えは無い。札の key は Repo 名を小文字にしたもので、Task の Repo（GitHub の nameWithOwner）と checkout の path の大小文字が違っても同じ札にまとめる。GitHub の Repo 名は大小文字を区別しないため。Repo の外の札（「その他」、folder の icon）は区切り線の下の一番下に置き、行が無くても出す。
- 札の字は repo 名の頭文字、色は repo 名から 8 色の 1 つを決まって選ぶ。dot の緑・琥珀・赤は使わない。
- 一覧の上には、どの札を選んでも Pinned（pin された Tab を持つ Runspace）を出す。Pinned の行はどの札にも入らない。
- 選んだ札の中は、上から Bench・Runspaces・Detached のセクションに分け、行の無いセクションは出さない。セクションが 2 つ以上あるときだけ見出しを出し、見出しを押すと畳む。畳むと行を全部隠し、見出しに行の数と未読の Tab の数を出す。見出しの無いセクションは、前に畳んでいても行を出す。
- Runspace を active にする経路（行、jump hint、key で巡る、Runspace を作る、Tab が移る）が Pinned でない Runspace へ移すと、選んだ札はその Runspace の札に従う（UI 状態の札を null にする）。札の key を書き込まないのは、Repo が `repo.of` を待って後から決まるので、決まる前の「Repo の外」に札を固定しないため。Pinned の Runspace へ移すときと、Tab を pin して active な Runspace が Pinned になるときは、そのとき見えていた札に留める。札を押すとその札に固定し、active な Runspace は変えない。選んだ札が無くなっていれば active な Runspace の札を、それも無ければ先頭の札を出す。起動の直後に保存した札がまだ無くても、保存した値は消さない。
- key で巡る（⌃↑↓）順は、Pinned、続いて札の順にそれぞれの Bench と Runspaces の行で、畳んだセクションの行は飛ばす。active な行が畳んだセクションにあるときは、下へは先頭の行から、上へは末尾の行から巡る。jump hint は画面に見えている行（Pinned と、選んだ札の開いたセクション）に上から振る。
- Runspace の並べ替え（drag と ⌃⇧↑↓）は同じセクションの中に限る。Workbench Ledger の並びは 1 本なので、セクションをまたいで動かしても見た目の位置にならないため。key で下へ動かすときは、自分を下の行の位置へ動かさず、下の行を自分の位置へ動かす。札の順はセクションの先頭の行の位置で決まるので、間にある別の Repo の Runspace を越えると札の順が入れ替わるため。

### 行

- 1 行目は title、2 行目はその他の情報。title は `...` で切らず全文を折り返す（`overflow-wrap: anywhere` と `text-wrap: pretty`。WKWebView では `word-break: auto-phrase` が効かない）。title の横には未読の数だけを置き、行頭の icon は出さない。
- title は、Bench なら Issue の title、ほかは active な Tab の端末の title。Claude Code が頭に付ける spinner の記号（`·✢✳✶✻✽`）は落とす。端末の title が無いか path（`/`・`~`・`~/` で始まる）なら、active な Tab の cwd を等幅で出す。形は `repo.of` の `path` で、Repo の中なら checkout か worktree の top からの相対 path（top ならその directory の名前）、外なら home を `~` に畳んだ path。`repo.of` が答えるまでは cwd の末尾の 2 つを出す。
- 2 行目は、Bench が準備中・準備失敗の枠付きの札と、端末の title（path でないとき。1 行で切る）と `#<n>`。Repo の外の札の行は cwd（title が path なら出さない）。Pinned は Repo の色札と repo 名（Bench は `<repo>#<n>` と端末の title）で、Repo の外なら cwd。普通の Runspace の行は、active な Tab が linked worktree にいるときの branch だけを出し、ほかは 2 行目を出さない（`N Tabs` も出さない）。Bench を使わずに作った worktree の branch を sidebar から読めるようにするため。
- Detached の行は cwd（形は title の path と同じ）とその Terminal Session の id を出し、hover で Reattach と Kill を行の右に重ねて出す。sidebar は狭いので、button に path の幅を取らせないため。

### 数

- 行の数は「未読」の節のとおり。
- 札の角には、その札を押して出てくる行（Bench・Runspaces・Detached）の未読の Tab の数の和を出し、0 なら何も出さない。Pinned は常に見えているので数えない。待ちの理由ごとの数や手空きの印は出さない。
- 畳んだセクションの見出しには、その行の未読の Tab の数の和を出す。

## status dot

Tab の dot（label の左）は、その Tab の Terminal Session の live な Agent Session の状態を写す。材料は `agentSession.list`。

| Agent Session | dot |
|---|---|
| 動作中 | 緑の点滅 |
| 質問・許可 | 琥珀の点滅 |
| エラー | 赤 |
| 手空き | 薄い琥珀 |
| 未観測 | 灰の輪（中抜き） |
| 終了、または Agent Session が無い | 出さない |

- hover の title は状態の語にし、質問と許可はそこで見分ける。
- plan 承認の色は持たない。plan の承認は許可の一種で、ExitPlanMode は自動承認されて待ちにならない（#16）。
- Terminal Session の dot（label の右。exited / lost / failed）は monica のまま残す。
- sidebar の行には Agent の状態の dot を出さない。Agent の状態は Tab の帯の dot で見る。1 つの Runspace に Tab と claude が複数あると、行の dot を 1 つに畳んでも何が起きているか読めないため。行には未読を出す（下の「未読」）。
- 状態と色の対応は Task の型を借りない。monica の `lib/status-config` は Task の `DisplayStatus` を借りていたが、workbench は task を import しない（ADR-0005）。

## 未読

`GLOSSARY.md` の未読を Tab の帯と sidebar に出す。未読かどうかは Backend が `agentSession.list` の `unread` で渡し（ADR-0021、`docs/packages/workbench-ledger.md` の「未読」）、webview は導かない。見た目は #190 の canvas の E3 の行と Tab の帯。

- Tab の帯は、未読の Tab の dot を白い輪で囲んで点滅を止め、label を白の太字にする。
- sidebar の行は、未読の Tab の数を title の右に白地に暗い字の丸で出し、title を白の太字にする。Detached の行は、その Terminal Session の Agent Session が未読なら 1 を出す。数を 2 行目に置かないのは、通知が来るたびに行が伸び縮みするため。見たうえでまだ待っている Tab は sidebar に出さない。
- 未読の印は白にそろえる。dot の緑・琥珀・赤と重ならないため。
- 行を押すと（jump hint の Ctrl も同じ）、その Runspace に未読の Tab があれば一番左のそれを開き、無ければ最後に見ていた Tab を開く。通知を click しても tania が前面に出るだけで Tab へは移れない（ADR-0013）ので、行から 1 手で着くようにする。key で Runspace を巡るときは、今どおり最後に見ていた Tab を開く。
- 窓が前面にあり、表示している Tab（active な Runspace の active な Tab）の Agent Session が未読なら、webview は一覧で読んだその通知の `notifiedAt` を添えて `agentSession.markSeen` を呼ぶ。見た瞬間に既読にし、見ていた時間は問わない。Tab を切り替えるたびには呼ばない。
- 窓が前面かどうかは、Tauri の `getCurrentWindow()` の `onFocusChanged` の購読が張れてから `isFocused()` で読む（`core:default` の権限で足りる）。読む間に event が届いたら、読んだ値は捨てる。別の app が前面にあるときも、窓を最小化したときも event が届くことを実機で確かめた。前面でない間は、表示している Tab でも見たことにしない。前面に戻ったときに、表示している Tab を見たことにする。
- `agentSession.list` を読み直すたびに Agent Session は別の値になるので、表示している間に届いた次の通知も、読み直した時点で見たことにする。`markSeen` が重なっても、Backend は未読でない行に何も書かない。
- tania が前面にある間は通知のバナーが出ない（ADR-0013）。active でない Runspace の通知には、行の数で気づく。
