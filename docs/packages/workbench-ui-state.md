# Workbench の UI 状態と status dot

Workbench Ledger に載せない Workbench の画面の状態と、Agent Session の状態と未読の見せ方。どれも `packages/workbench/src/ui` に置く。

## UI 状態

- webview の localStorage に置く（ADR-0014）。中身は active な Runspace とその active Tab、sidebar の開閉と幅（160〜360、既定 200）、UI zoom（0.8〜1.6、既定 1）。monica の `ui-state.json` から、Space、Work Board、window ごとの入れ子を除いた形。
- 端末の font size と、active でない Runspace の active Tab は保存しない（monica どおり）。
- 書き込みは 500ms の debounce。localStorage は同期で読めるので、monica の render 前の hydrate は要らない。
- 保存した id が `layout.get` に無ければ、先頭の Runspace と、その先頭の Tab に戻す（monica の `resolveWorkbenchActive`）。読めないか壊れていれば既定値で始める。
- 見たこと（未読）は UI 状態に置かず、Workbench Ledger に置く（ADR-0021、下の「未読」）。

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
- sidebar の行（Pinned・Runspaces・Detached）には Agent の状態の dot を出さない。Agent の状態は Tab の帯の dot で見る。1 つの Runspace に Tab と claude が複数あると、行の dot を 1 つに畳んでも何が起きているか読めないため。行には未読を出す（下の「未読」）。
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
