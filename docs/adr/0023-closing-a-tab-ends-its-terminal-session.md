---
status: accepted
---

# Tab を閉じるとその Terminal Session も終了し、Tab の無い Terminal Session を残さない

旧 Monica から引き継いだ Workbench は、tmux や zellij にならって UI の寿命と process の寿命を分けていた（monica-v1 #75）。Tab を閉じても Terminal Session は止めずに detached として残し、sidebar の Detached から Tab に開き直す（reattach）か kill するまで生かす。しかし monica の Tab は Ctrl-D か `exit` で閉じ、reattach は使っていない。Detached は、閉じた Tab の shell と claude が溜まる場所になっていた。そこで Ghostty と同じく、Tab を閉じる（Close Tab）とその Terminal Session も終了させる。Tab の無い live な Terminal Session は作らず、見つけたら終了させる。これで sidebar の Detached、reattach、Tab の無い Terminal Session の未読と Dock の数の扱いが要らなくなる。app の再起動を越えて shell を生かすこと（ADR-0007、ADR-0011）は変えない。#75 の主な動機はそちらで、Tab の寿命とは独立しているため。

## Considered Options

- **今のまま閉じたら detach し、Detached から reattach か kill する**: 誤って閉じた claude を救える。ただし誤って閉じやすい × は使っておらず、Tab の無い Terminal Session のために sidebar のセクション、Tile の振り分け、未読、Dock の数に分岐が残る。
- **閉じたら kill を既定にし、Tab のメニューの「Close (keep shell)」で detach を残す**: Detached の分岐がすべて残る。
- **Ghostty のように、閉じてから数秒は undo できる**: その数秒は Tab の無い Terminal Session があることになり、下の不変条件に例外が増える。
- **⌘Q でも Terminal Session を終了させる（Ghostty どおり）**: app の更新や crash を越えて claude が生き残る性質を失う。

## Consequences

- Close Tab の経路は、shell の終了（Ctrl-D、`exit`）と Ctrl+T → d の 2 つ。× と、Tab のメニューの Close と Terminate は持たない。
  - Ctrl+T → d は、live な Agent Session がある Tab ではもう一度 d を求める。d は c（新しい Tab）の隣のキーで、打ち損じで claude を消さないため。
  - pin された Tab は今までどおり閉じられない（ADR-0014）。
- `tab.close` は Tab の行を消し、その Terminal Session の Terminate を transaction の後に予約する（ADR-0015 の `removeRunspace` と同じ形）。webview が先に終了を頼む形にしないのは、呼び手を 1 つ忘れるだけで Tab の無い Terminal Session ができるため。`terminalSession.terminate` は持たない。
- 終了には今の ptyd の Terminate（shell に SIGHUP）を使う。
  - shell は session leader なので、前面の claude は shell とは別の process group にいても SIGHUP を受ける。zsh で、前面のジョブが shell の転送（`HUP` option）とカーネルの hangup の両方で終わることを確かめた。
  - claude は SessionEnd を送ってから終わり、会話は `claude --resume` で戻せる。
  - SIGKILL は足さない。SessionEnd の hook の持ち時間（1.5 秒から）を切らないため。
- reconcile は、ptyd にだけある live な Terminal Session を取り込まずに終了させ、Tab に指されていない live な行も終了させる（ADR-0011 の規則を置き換える）。後者は、Terminate を送る前に Backend が止まった場合（ADR-0015）を拾う。この版に上げた最初の起動で、それまで detached だった Terminal Session は終わる。
- Bench の最後の Tab を閉じたときの Task の close（ADR-0012）は、閉じた Tab の claude では ActiveRun の guard に当たらず、git の guard だけが止める。
- Tab より長生きする agent がいなくなるので、ADR-0008 の「Tab より長生きした agent は観測しない」がそのまま成り立つ。
- ptyd の protocol の detach は残す。これは接続ごとに出力の配信を止める op で、Tab の寿命とは別のもの。
