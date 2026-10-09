---
status: accepted
---

# guard で止まった Bench は、Workbench で 2 度押す「Close anyway」から強制で close できる

Workbench で Bench の最後の Tab を閉じると、task の ui が `force` 無しで close を呼ぶ（ADR-0012）。worktree に uncommitted な変更か remote に無い commit があると guard が止め、理由は 8 秒で消える error の toast に 1 行出るだけで、Bench は Tab の無いまま「New shell in …」のボタンだけを出して残る。強制で閉じるには CLI の `monica task close --force` に移るしかなかった。そこで、guard で止まった Bench の画面に止めた理由を並べ、隣に「Close anyway」を出す。1 度目の押下でラベルを「Click again to discard changes」に変え、2 度目で `task.close({ ref, force: true })` を呼ぶ。`--force` は uncommitted な変更を戻せない形で消すので、押し損じでは消さないようにする。

## Considered Options

- **error の toast にボタンを付ける**: toast は 8 秒で消え、消えた後は理由も手段も残らない。`@monica/ui` の toast は操作を持たない。
- **sidebar の Bench にメニューを足す**: Bench には remove のメニューを出さない（ADR-0012）。止めた理由を出す場所も別に要る。
- **確認ダイアログ**: repo に確認ダイアログは無く、破壊的な操作の確認は 2 度押し（Ctrl+T → d。ADR-0023）に揃っている。
- **理由が remote に無い commit だけなら 1 度で閉じる**: reflog から戻せるが、理由ごとに押し方が変わる。理由を問わず 2 度押しにする。
- **止める理由を Backend に問い合わせる dry-run の procedure を足す**: 再起動の後も理由を出せるが、そのためだけに contract が増える。

## Consequences

- 止めた理由は、`CLOSE_REFUSED` を受けたときに task の ui が Bench ごとに memory に覚える。Backend の contract は変えない。app を再起動した後は理由が無く、「Close anyway」だけを出す。
- 覚えた理由は、その Bench で次に強制でない close を始めたときと close が通ったときに捨てる。Tab を開いてまた閉じれば、強制でない close が走り直して理由を取り直す。Tab が開いたことは workbench の外の task の ui から見えないので、Tab を開いた時点では捨てない。開いた Tab を外へ移して Bench を空にしたときは close が走らないので、前の理由が残る。
- 「Close anyway」は guard で止まった Bench にだけ出す。close の途中の Tab の無い Bench には出さない。
- 強制の意味は CLI の `--force` と同じで、ActiveRun も越える。強制でも断られたとき（準備中の `CONFLICT`、git の失敗の `PRECONDITION_FAILED`）は今までどおり error の toast に出す。
- workbench は task を知らないので（ADR-0005）、Tab の無い Bench の画面に出す中身は、apps/desktop が task の ui の component を slot ではめる。
