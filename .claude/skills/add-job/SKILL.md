---
name: add-job
description: ユーザーの Job を登録する。「毎日〜したい」「定期的に〜を走らせたい」のように、予定で繰り返し走る処理を monica に足したいときに使う。
---

依頼を shell command の Job に落とし、`monica job add` で release の Backend（`~/.monica`）に登録して、1 回走らせて確かめる。Job の規則（名前・cron 式・cwd・timeout・process の env・結果の決まり方）は `docs/packages/job-ledger.md` の「ユーザーの Job」にあり、flag は `monica job add --help` にある。

## 1. Job の形を決める

名前・schedule・cwd・timeout を依頼から決める。依頼に無いものは推奨で決め、4 で登録する前にまとめて見せる。

- schedule の時刻は、desktop が開いていて Mac が起きている時間に置く。Job は Backend が居る間だけ走り、予定の時刻に居なかった回とスリープで 60 秒を超えて遅れた回は飛ばして、後から追いつかない（ADR-0016）。「1 日 1 回」なら日中の時刻にする。
- 名前が `monica job list` の Job と重なるときは、置き換えてよいかをユーザーに確かめる（remove してから add する）。

## 2. script を書く

command が 1 行に収まらなければ、`~/.local/bin/<名前>` に `#!/bin/sh` と `set -eu` で始まる script を置いて `chmod +x` し、command にはその絶対 path を渡す。

- script は stdin も TTY も無く、login shell の PATH で走る。対話を待つ command には非対話の flag を付ける。
- monica は exit code だけで成否を決める。やるべきことを果たせなかった回は 0 以外で終わらせ、原因を最後の行に出す（`monica job show` の ERROR にその行が出る）。
- `claude -p` を呼ぶなら、`docs/packages/job-ledger.md` の「claude を呼ぶ Job の成否」の形で result 行を確かめる。
- 消す Job（branch・worktree・file）は、`--dry-run` で消す対象を出すだけの mode を持たせ、消す前に対象を 1 行ずつ log に出す。戻せないもの（push していない commit、未 commit の変更）を持つ対象は残す。この checkout と `.claude/worktrees/` では別の session が同時に動いているので、使っている worktree も残す。

## 3. 手で走らせる

script を Job と同じ cwd で直に走らせる。消す Job は `--dry-run` で走らせ、出た対象をユーザーに見せて了承をもらう。exit 0 で、出力が意図した対象と結果を示していれば完了。

## 4. 登録する

```bash
monica job add <名前> --schedule '<cron 式>' --command '<command>' --cwd <絶対 path> --timeout <30m など>
```

`--cwd` と `--timeout` は既定（`$HOME`・1h）でよければ省く。`BAD_REQUEST` なら、エラーの文面と「ユーザーの Job」の規則を突き合わせて直す。

## 5. 確かめる

```bash
monica job run <名前>
monica job show <名前>
```

`show` の最新の RESULT が `running` の間は読み直す。`succeeded` になり、LOG の file を読んで、意図した処理が起きたと分かれば完了。`failed` か `timed_out` なら、LOG と ERROR から直して 2 に戻る。command か schedule を直すときは `monica job remove` してから 4 をやり直す。

## 6. 報告する

名前、schedule と `show` の NEXT、script の path、止め方（`monica job pause <名前>` と `monica job remove <名前>`）を伝える。
