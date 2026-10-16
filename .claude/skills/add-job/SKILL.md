---
name: add-job
description: ユーザーの Job を登録する。「毎日〜したい」「定期的に〜を走らせたい」のように、予定で繰り返し走る処理を monica に足したいときに使う。登録した Job が failed・timed_out になったときも使う。
---

依頼を Job に落とし、release の Backend に登録して、1 回走らせて確かめる。add の引数の形は `monica job add --help` に、予定・成否・env の決まりは ADR-0016 にある。登録済みの Job が failed・timed_out になった依頼は、[DEBUG.md](DEBUG.md) から始める。

この skill の `monica` は release の CLI を指す。`$MONICA_HOME` が空か `$HOME/.monica` でなければ（dev の Tab）、`env MONICA_HOME="$HOME/.monica" "$HOME/.local/bin/monica"` に置き換える。

**副作用のある Job**（消す・送る・作る・書き換える・push する）は、確かめ終えるまで予定では走らせない。

## 1. Job の形を決める

Job の種類は 2 つある。

- **claude の Job**: claude に skill や slash command を走らせる。command は `claude -p` の 1 行にし、script は書かない（下の「claude の Job」）。処理の中身は呼ぶ skill が持つ。
- **shell の Job**: command か script を走らせる。

次の 5 つは推奨で埋めない。依頼に無いものは、AskUserQuestion で候補を 2〜3 個（推奨を先頭）並べて聞く。1 回に 4 問までなので、呼ぶ skill は種類が決まってから聞く。

- Job の名前: `list`・`pause`・`remove` でユーザーが打つ語になる。
- 走る時刻（cron 式）
- cwd
- 種類: claude の Job か shell の Job か。
- claude の Job が呼ぶ skill か slash command

timeout と、claude の Job の `--allowedTools` は推奨で埋める。登録の前に、すべてをまとめて見せる。- 時刻は desktop が開いている時間に置く。Backend が居なかった回とスリープで遅れた回は飛ばされ、後から走らない。
- cwd は Job が扱う repo の root にする。claude の skill と slash command は cwd の `.claude/` から読まれる。
- `<名前>` と `<名前>-dry-run` は、`monica job list` に無いものにする。既にある Job の置き換えも新しい名前で作り、旧い Job は 5 の resume の前にユーザーに確かめて remove する。

### claude の Job

```bash
monica job add <名前> --schedule '<cron 式>' --cwd <repo の root> --timeout <timeout> \
  --command "claude -p '/<skill>' --output-format json --allowedTools <tool …>"
```

- PATH の先頭の `claude` は monica の wrapper だが、Tab の外では hook を付けずに本物を exec する。`claude` のまま呼ぶ。Agent Session にはならず、結果は LOG の result 行でしか見えない。
- stdin が無いので、許可を求めた tool は拒否される。呼ぶ skill を読み、使う tool を `--allowedTools` に並べる。cwd の外の dir（scratchpad など）を触る skill には `--add-dir` も付ける。
- `--output-format json` で、LOG に result 行（`is_error`・`permission_denials`・`session_id`）が残る。`session_id` で Tab から `claude --resume` できる。
- tool を拒否された回も claude は exit 0 で終わり、`succeeded` になる。成否は 5 で LOG の result 行から読む。予定の回の失敗も `failed` で知りたいとユーザーが望んだときだけ、shell の Job として「claude を呼ぶ script」を書く。

## 2. script を書く

shell の Job で、1 行に収まらない command か副作用のある Job だけが通る。claude の Job は 4 へ。

cwd の repo の中の、git が無視する dir に script を置く。repo に慣習が無ければ `.local/bin/<名前>` にし、無視されていなければ `.local/` を `.git/info/exclude` に足す。別の session が checkout の branch を切り替えても、無視された file は消えない。

- 1 行目に shebang（`#!/bin/sh` か `#!/usr/bin/env bash`）を書き、`set -eu` を置いて `chmod +x` する。command はその絶対 path と引数だけにし、interpreter を前に付けない。
- stdin も TTY も無い。対話を待つ command には非対話の flag を付ける。
- 成否は exit code だけで決まる。果たせなかった回は 0 以外で終え、原因を最後の行に出す（`show` の ERROR に出る）。
- 副作用のある Job は `--dry-run` で対象を出すだけの mode を持ち、本番でも変える前に対象を log に出す。
- 消す Job は、push していない commit・未 commit の変更・別の session が使っている worktree を持つ対象を残す。

### claude を呼ぶ script

1 の最後の場合だけ書く。script が result 行を確かめ、何もできていなければ 0 以外で終わる（`set -u` で exit code を自分で受ける）。

```sh
#!/bin/sh
set -u
result=$(claude -p '/<skill>' --output-format json --allowedTools <tool …>)
status=$?
echo "$result"
[ "$status" -eq 0 ] || exit "$status"
if echo "$result" | jq -e '.is_error or (.permission_denials | length > 0)' > /dev/null; then
  echo "<名前>: $(echo "$result" | jq -r '.result')" >&2
  exit 1
fi
```

## 3. dry-run を走らせる

副作用のある shell の Job だけが通る。本番と同じ env で走るよう、dry-run も Job として Backend に起こさせる。

```bash
monica job add <名前>-dry-run --schedule '<cron 式>' --command '<script の絶対 path> --dry-run' --cwd <cwd> --timeout <timeout> && monica job pause <名前>-dry-run
monica job run <名前>-dry-run
monica job show <名前>-dry-run
```

`add` が通らなければ 1 に戻る。RESULT が `running` を抜けるまで `show` を読み直し、LOG の file を読んでから `monica job remove <名前>-dry-run` する（remove は LOG も消す）。`succeeded` で LOG の対象が意図どおりなら、ユーザーに見せて了承をもらい 4 へ。それ以外は [DEBUG.md](DEBUG.md) で原因を絞り、script を直して 3 をやり直す。

## 4. 登録する

```bash
monica job add <名前> --schedule '<cron 式>' --command '<command>' --cwd <cwd> --timeout <timeout> && monica job pause <名前>
```

## 5. 確かめる

pause のままでも `run` で起こせる。副作用のある claude の Job は dry-run が無く、この run が本番になるので、走らせる前に何が起きるかを伝えて了承をもらう。

```bash
monica job run <名前>
monica job show <名前>
```

`succeeded` になり、LOG で意図した処理が起きたと分かったら `monica job resume <名前>` して完了。claude の Job は、result 行の `is_error` が false で `permission_denials` が空なことと、skill の成果（push された commit など）で確かめる。それ以外は [DEBUG.md](DEBUG.md) で原因を絞る。副作用のある Job は、途中まで済んだ変化をユーザーに見せてから走らせ直す。script だけを直すなら 3（副作用のある shell の Job）か 5 に戻り、command・cron 式・cwd・timeout を変えるなら remove して 4 に戻る。

## 6. 報告する

名前、cron 式と `show` の NEXT、command（script があればその path）、止め方（`monica job pause` と `monica job remove`）を伝える。
