# Job

ユーザーは shell command を cron の予定で Job として登録し、今すぐ走らせることも、予定の時刻に走るのを待つこともでき、各回の結果と log を後から見られる。

## Sub-features

- `job-add`: 名前・予定・command・cwd で Job を登録する。
- `job-run`: 予定を変えずに今すぐ走らせる。
- `job-scheduled`: 予定の時刻に走る。
- `job-show`: 各回の結果（RESULT・EXIT・LOG）を新しい順に見る。
- `job-pause`: 一時停止すると予定で走らず、再開すると次の予定が出る。
- `job-remove`: Job を、その回の記録と log ごと消す。

## How to get to it (user POV)

- CLI の `monica job add|run|show|list|pause|resume|remove`。
- 登録を claude に頼むときは `add-job` skill を経る（最後は同じ CLI）。

## Driving it with headless の Backend と CLI

Preconditions:

- `doctor.sh <name>` が `OK`。
- `monica job list` に system の Job（`task.sync`・`task.setup-log-cleanup`・`task.worktree-sweep`・`note.image-cleanup`）だけがあり、`stamp` は無い。

- **登録する.** 2 分先の予定を作る。`T=$(date -v+2M '+%M %H')` から `S="$((10#${T% *})) $((10#${T#* })) * * *"`。`monica job add stamp --schedule "$S" --command "date +%s >> $E/stamp.txt; echo stamped" --cwd $E` を流す。exit 0 で `added stamp; it runs next at <今日の予定の時刻>` が出る。
- **今すぐ走らせる.** `monica job run stamp` を流す。exit 0 で `started stamp at …` が出て、`$E/stamp.txt` が 1 行になる。
- **予定の時刻を待つ.** Bash の `run_in_background` で `until [ "$(wc -l < $E/stamp.txt | tr -d ' ')" = 2 ]; do sleep 2; done` を走らせる。予定の分から 30 秒以内に 2 行になる。
- **結果を読む.** `monica job show stamp` を流す。下の表に 2 行あり、どちらも RESULT が `succeeded`、EXIT が `0`。上の表の NEXT は翌日の同じ時刻。
- **log を写す.** 消す前に、`job show` の LOG の file を `$E/` へ `cp` する。中身は `stamped`。
- **一時停止と再開.** `monica job pause stamp` の後の `job list` で STATE が `paused`、NEXT が `-`。`monica job resume stamp` で `resumed stamp; it runs next at …` が出る。
- **消す.** `monica job remove stamp` で `removed stamp with its Job Executions and logs` が出る。`job list` から消え、`$H/logs/jobs/stamp` も無くなる。
- **証拠.** 各 command・出力・exit code を `$E/job.transcript` に追記し、`stamp.txt` と写した log を添える。

## Gotchas

- cron は分の単位で、tick は 30 秒おき。1 分先の予定は登録が終わる前にその分が来ることがあるので、2 分先にする。
- Job の log は `$H/logs/jobs/` にあり、`job remove` と `cleanup.sh` の両方で消える。証拠にするなら先に `$E` へ写す。
- Job は Backend の env をそのまま受ける。`launch.sh` を通さずに Backend を起こすと、外側の `MONICA_HOME` や `CLAUDECODE` が command に届く。
- `--cwd` は絶対 path。相対 path は `BAD_REQUEST: the cwd … is not an absolute path` と exit 1 で断られる。
- Backend が居ない時刻の回は飛ばされ、後から追いかけて走らない。
