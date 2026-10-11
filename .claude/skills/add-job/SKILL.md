---
name: add-job
description: ユーザーの Job を登録する。「毎日〜したい」「定期的に〜を走らせたい」のように、予定で繰り返し走る処理を monica に足したいときに使う。
---

依頼を shell command の Job に落とし、`monica job add` で release の Backend（`~/.monica`）に登録して、1 回走らせて確かめる。Job の規則（名前・cron 式・cwd・timeout・process の env・結果の決まり方）は `docs/packages/job-ledger.md` の「ユーザーの Job」にあり、flag は `monica job add --help` にある。

この skill の `monica` は release の CLI を指す。`echo "${MONICA_HOME:-}"` が空か `$HOME/.monica` ならそのまま使う。それ以外（dev の Workbench の Tab は dev の home を渡し、PATH の `monica` も dev のものになる）では、`monica` を `env MONICA_HOME="$HOME/.monica" "$HOME/.local/bin/monica"` に置き換えて呼ぶ。dev の Backend に登録した Job は dev の desktop を閉じている間に走らない。

## 1. Job の形を決める

名前・schedule・cwd・timeout を依頼から決める。依頼に無いものは推奨で決め、4 で登録する前にまとめて見せる。

- schedule の時刻は、desktop が開いていて Mac が起きている時間に置く。Job は Backend が居る間だけ走り、予定の時刻に居なかった回とスリープで 60 秒を超えて遅れた回は飛ばして、後から追いつかない（ADR-0016）。「1 日 1 回」なら日中の時刻にする。
- 名前が `monica job list` の Job と重なるときは、置き換えてよいかをユーザーに確かめる（remove してから add する）。

## 2. script を書く

command が 1 行に収まらなければ、PATH の外の `~/.local/share/monica-jobs/<名前>.sh` に `#!/bin/sh` と `set -eu` で始まる script を置いて `chmod +x` し、command にはその絶対 path を渡す。

- script は stdin も TTY も無く、release の Backend の env と、Backend が login shell から取った PATH で、`/bin/sh -c` から走る。対話を待つ command には非対話の flag を付ける。
- monica は exit code だけで成否を決める。やるべきことを果たせなかった回は 0 以外で終わらせ、原因を最後の行に出す（`monica job show` の ERROR にその行が出る）。
- `claude -p` を呼ぶなら、`docs/packages/job-ledger.md` の「claude を呼ぶ Job の成否」の形で result 行を確かめる。その script は例と同じく `set -u` で始め、claude の exit code を自分で受ける。
- 外に変化を起こす Job（消す・送る・作る・書き換える）は、1 行で書けても script にし、command は script の絶対 path だけにする。script には `--dry-run` で対象とやることを出すだけの mode を持たせ、本番でも変える前に対象を 1 行ずつ log に出す。
- 消す Job は、戻せないもの（push していない commit、未 commit の変更）を持つ対象を残す。この checkout と `.claude/worktrees/` では別の session が同時に動いているので、使っている worktree も残す。

## 3. dry-run を Backend で走らせる

外に変化を起こす Job だけが通る。起こさない Job は 4 に進み、5 の `monica job run` を 1 回目にする。

dry-run も本番と同じ env・PATH・cwd・`/bin/sh -c` で走るよう、`<script の絶対 path> --dry-run` を別名の Job として release の Backend に登録し、予定では走らないよう pause してから起こす。

```bash
monica job add <名前>-dry-run --schedule '<cron 式>' --command '<script の絶対 path> --dry-run' --cwd <絶対 path>
monica job pause <名前>-dry-run
monica job run <名前>-dry-run
monica job show <名前>-dry-run
```

RESULT が `running` を抜けたら、結果によらず `monica job remove <名前>-dry-run` で外す。`succeeded` で、LOG に意図した対象とやることが出ていれば、それをユーザーに見せて了承をもらえば完了。それ以外は script を直して 3 をやり直す。

## 4. 登録する

5 で確かめ終えるまで予定では走らないよう、登録したらすぐ pause する。

```bash
monica job add <名前> --schedule '<cron 式>' --command '<command>' --cwd <絶対 path> --timeout <30m など>
monica job pause <名前>
```

`--cwd` と `--timeout` は既定（`$HOME`・1h）でよければ省く。`BAD_REQUEST` なら、エラーの文面と「ユーザーの Job」の規則を突き合わせて直す。

## 5. 確かめる

pause のままでも `run` で起こせる。

```bash
monica job run <名前>
monica job show <名前>
```

`show` の最新の RESULT が `running` の間は読み直す。`succeeded` になり、LOG の file を読んで、意図した処理が起きたと分かったら `monica job resume <名前>` して完了。`failed` か `timed_out` なら、LOG と ERROR から原因を探す。直すのが script の中身だけなら、直して（外に変化を起こす Job は 3 を通して）5 をやり直す。command・schedule・cwd・timeout を変えるときは、`monica job remove` してから 4 に戻る。

## 6. 報告する

名前、schedule と `show` の NEXT、script の path、止め方（`monica job pause <名前>` と `monica job remove <名前>`）を伝える。
