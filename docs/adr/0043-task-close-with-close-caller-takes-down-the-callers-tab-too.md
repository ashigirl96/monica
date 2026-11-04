---
status: accepted
---

# Task の close は、`--close-caller` で頼まれたら呼び手の Tab も消す

ADR-0012 は、close を頼んだ agent 自身に SIGHUP を送らないため、close が呼び手の Terminal Session を `spare` に渡し、呼び手の Tab を普通の Runspace に残すと決めた。そのため、判断を終えた agent が自分で Task を締めくくっても、呼び手の Tab は私が手で閉じるまで残る。そこで close に `--close-caller` を足し、付けて呼ばれたら呼び手を `spare` に入れない。呼び手の Tab は Bench のほかの Tab と同じく消え、Runspace も残らない。付けない close は ADR-0012 のまま。

呼び手の shell が close の途中で終わることは無い。worktree の捨て場への rename と branch の削除は transaction の前に済み、その間は呼び手の shell が生きている。Terminate は commit の後に workbench が送る（ADR-0015）。worktree の中身は system の Job が後で消す（ADR-0042）。呼び手の claude は close の応答を受け取る前に終わりうるが、Tab ごと消えるので読む者がいない。agent は close を最後の操作にする。

## Considered Options

- **呼び手の Agent Session の `Stop` を待ってから、Backend が Tab を閉じる**: 応答と最後の報告を受け取らせてから閉じられるが、消えた Tab の中身を読む者はいない。ほかの plugin の `Stop` hook を待つ猶予と、`Stop` hook が turn を続けさせたときの見分けが要り、Backend が閉じる予定を覚える仕組みが増える。
- **旧 Monica の close hold（agent か shell が終わるまで Tab を残す）**: Tab の claude は turn を終えても終わらず、task run は shell に `claude\r` を打って起こすので shell も残る。閉じる時が来ない。
- **option を付けず、agent が呼んだ close では常に消す**: close の後も同じ agent に話しかけ続ける使い方ができなくなる。

## Consequences

- `--close-caller` は、呼び手の Tab が Bench の中にあるときだけ効く。Bench の外の Tab から呼ぶか、Tab の外から呼ぶと、close は呼び手に触らない。
- 強制でない close の間に Task の Run になった Tab は、`--close-caller` を付けても今どおり残す。
- ActiveRun guard は今どおり呼び手自身の Run を除く。その Run は Terminate で終わる。
