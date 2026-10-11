---
name: add-job
description: ユーザーの Job を登録する。「毎日〜したい」「定期的に〜を走らせたい」のように、予定で繰り返し走る処理を monica に足したいときに使う。
---

依頼を Job に落とし、release の Backend に登録して、1 回走らせて確かめる。Job の規則は `docs/packages/job-ledger.md` の「ユーザーの Job」にある。

この skill の `monica` は release の CLI を指す。`$MONICA_HOME` が空か `$HOME/.monica` でなければ（dev の Tab）、`env MONICA_HOME="$HOME/.monica" "$HOME/.local/bin/monica"` に置き換える。

**副作用のある Job**（消す・送る・作る・書き換える）は、本番の前に dry-run を通し、確かめ終えるまで予定では走らせない。

## 1. Job の形を決める

名前・cron 式・cwd・timeout を決め、依頼に無いものは推奨で埋めて、登録の前にまとめて見せる。

- 時刻は desktop が開いている日中に置く。Backend が居なかった回とスリープで遅れた回は飛ばされ、後から走らない。
- `<名前>` と `<名前>-dry-run` は、`monica job list` と `~/.local/share/monica-jobs/` に無いものにする。既にある Job の置き換えも新しい名前で作り、旧い Job は 5 の resume の前にユーザーに確かめて remove する。

## 2. script を書く

1 行に収まらない command と、副作用のある Job は、PATH の外の `~/.local/share/monica-jobs/<名前>.sh` に script を書き（`#!/bin/sh`・`set -eu`・`chmod +x`）、command はその絶対 path だけにする。

- stdin も TTY も無い。対話を待つ command には非対話の flag を付ける。
- 成否は exit code だけで決まる。果たせなかった回は 0 以外で終え、原因を最後の行に出す。`claude -p` を呼ぶなら job-ledger.md の「claude を呼ぶ Job の成否」の形にする（`set -u` で exit code を自分で受ける）。
- 副作用のある Job は `--dry-run` で対象を出すだけの mode を持ち、本番でも変える前に対象を log に出す。
- 消す Job は、push していない commit・未 commit の変更・別の session が使っている worktree を持つ対象を残す。

## 3. dry-run を走らせる

副作用のある Job だけが通る。本番と同じ env で走るよう、dry-run も Job として Backend に起こさせる。

```bash
monica job add <名前>-dry-run --schedule '<cron 式>' --command '<script の絶対 path> --dry-run' --cwd <cwd> --timeout <timeout> && monica job pause <名前>-dry-run
monica job run <名前>-dry-run
monica job show <名前>-dry-run
```

`add` が通らなければ 1 に戻る。RESULT が `running` を抜けるまで `show` を読み直し、LOG の file を読んでから `monica job remove <名前>-dry-run` する（remove は LOG も消す）。`succeeded` で LOG の対象が意図どおりなら、ユーザーに見せて了承をもらい 4 へ。それ以外は script を直して 3 をやり直す。

## 4. 登録する

```bash
monica job add <名前> --schedule '<cron 式>' --command '<command>' --cwd <cwd> --timeout <timeout> && monica job pause <名前>
```

## 5. 確かめる

pause のままでも `run` で起こせる。

```bash
monica job run <名前>
monica job show <名前>
```

`succeeded` になり、LOG で意図した処理が起きたと分かったら `monica job resume <名前>` して完了。失敗したら LOG と ERROR から直す。副作用のある Job は、途中まで済んだ変化をユーザーに見せてから走らせ直す。script だけを直すなら 3（副作用のある Job）か 5 に戻り、command・cron 式・cwd・timeout を変えるなら remove して 4 に戻る。

## 6. 報告する

名前、cron 式と `show` の NEXT、script の path、止め方（`monica job pause` と `monica job remove`）を伝える。
