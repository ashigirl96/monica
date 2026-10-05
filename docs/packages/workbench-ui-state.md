# Workbench の UI 状態と status dot

帳簿に載せない Workbench の画面の状態と、Agent Session の状態の見せ方。どちらも `packages/workbench/src/ui` に置く。

## UI 状態

- webview の localStorage に置く（ADR-0014）。中身は active な Runspace とその active Tab、sidebar の開閉と幅（160〜360、既定 200）、UI zoom（0.8〜1.6、既定 1）。monica の `ui-state.json` から、Space、Work Board、window ごとの入れ子を除いた形。
- 端末の font size と、active でない Runspace の active Tab は保存しない（monica どおり）。
- 書き込みは 500ms の debounce。localStorage は同期で読めるので、monica の render 前の hydrate は要らない。
- 保存した id が `layout.get` に無ければ、先頭の Runspace と、その先頭の Tab に戻す（monica の `resolveWorkbenchActive`）。読めないか壊れていれば既定値で始める。

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
- 見たかどうか（既読）は持たない。
- Terminal Session の dot（label の右。exited / lost / failed）は monica のまま残す。
- sidebar の Runspace の行には、その Runspace の Tab の Agent Session から 1 つを選んで出す。優先順は 質問・許可 > エラー > 手空き > 未観測 > 動作中。Bench も同じ規則で、Task の表示状態は使わない（Bench のラベルの語は task の slot が出す）。Detached グループの行にも Tab と同じ dot を出す。
- 状態と色の対応は Task の型を借りない。monica の `lib/status-config` は Task の `DisplayStatus` を借りていたが、workbench は task を import しない（ADR-0005）。
- tania が前面にある間は通知のバナーが出ないので、この dot が代わりになる（ADR-0013）。active でない Runspace の待ちは、Runspace の行の dot で気づく。
