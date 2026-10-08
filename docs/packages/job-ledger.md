# Job Ledger

`packages/job` の contract と、Job Execution の記録と起こし方の規則。決定の理由は ADR-0016 にある。Job には、Backend が渡す system の Job（`task.sync` など）と、ユーザーが `monica job add` で登録して shell command を走らせる Job がある。

## contract（root は `job`）

```
list    → { jobs: { name, schedule, state, last: { startedAt, result } | null, nextAt }[] }  cli
show    { name } → { name, schedule, state, nextAt, shell: { command, cwd, timeoutMs } | null, executions: JobExecution[] }  cli
run     { name } → { name, startedAt }                                                    cli
add     { name, schedule, command, cwd?, timeout? } → { name, nextAt }                    cli
remove  { name } → { name }                                                               cli
pause   { name } → { name }                                                               cli
resume  { name } → { name, nextAt }                                                       cli
```

- `schedule` は、system の Job なら `{ type: "every", ms }`、ユーザーの Job なら `{ type: "cron", expression }`。
- `state` は `running` / `paused` / `active` の順に決める。pause したユーザーの Job を `run` で起こした間は `running` になる。system の Job は `paused` にならない。
- `last` は終わった Job Execution のうち最新のもの。走っている回は `state` の `running` で分かるので、`last` には前回の結果を残す。`nextAt` は `start()` の前の system の Job と、pause したユーザーの Job では null。
- `list` は system の Job を渡された順に、その後にユーザーの Job を add した順に並べる。
- `show` の `shell` はユーザーの Job の command・cwd・timeout で、system の Job では null。`executions` は新しい順に 20 件。
- 無い名前は `NOT_FOUND`。
- change stream は持たない。購読する画面が無いため（ADR-0016）。
- CLI の時刻は local time の `YYYY-MM-DD HH:MM:SS` で出す。`list` の SCHEDULE は `every 5m` か cron 式、LAST は開始時刻と結果。`show` は、ユーザーの Job なら TIMEOUT・CWD・COMMAND と、各 Job Execution の EXIT と LOG も出す。DURATION は終わった回だけに出し、走っている回の RESULT は `running` にする。`show` と `run` の名前の位置には Job の名前を、`remove`・`pause`・`resume` の名前の位置にはユーザーの Job の名前を補完する。

## createJobLedger

`createJobLedger({ db, home, systemJobs, now? })`。`home` はユーザーの Job の log を置く `$MONICA_HOME`。`systemJobs` は `{ name, every, run }` の配列で、`run` は失敗なら reject する。名前に `.` が無いか、名前が重なれば throw する。`.` はユーザーの Job の名前に使えないので、system の Job と名前が重ならない。`now` はテストが時計を進めるための口。

job は task も workbench も note も import しない（ADR-0016）。system の Job は task が `@monica/task/server` の `systemJobs(taskLedger)` で、note が `@monica/note/server` の `systemJobs(noteLedger)` で並びを出し、Backend の組み立てがその 2 つをつないで渡す。`task.sync` の `run` は `taskLedger.syncInBackground()` を、`task.setup-log-cleanup` の `run` は `taskLedger.cleanSetupLogs()` を、`note.image-cleanup` の `run` は `noteLedger.cleanImages()` を呼ぶ。`Db` の型も drizzle の `BunSQLiteDatabase` を直に使う。

## ユーザーの Job

### 登録

- ユーザーの Job は `job` に 1 Job 1 行で持つ。登録の規則（schedule・cwd・timeout の解析）は `user-job.ts`、process は `command.ts` に置く。列は名前、cron 式、command、cwd、timeout、pause、add した時刻。system の Job は行を持たない。
- `add` の名前は小文字・数字・`-` だけ。contract の正規表現が守るので、CLI では Backend を呼ぶ前に `BAD_REQUEST` になる。同じ名前の Job があれば `CONFLICT`。変えたいときは remove してから add する。
- schedule は 5 欄の cron 式で、Mac の local の timezone で読む。解析は croner の `mode: "5-part"`（6 欄と 7 欄を断る）で、`@daily` のような別名も通す。解析できないか、次の予定が無い（`0 0 30 2 *`）なら `BAD_REQUEST`。日と曜日を両方書いた式は、croner の既定どおりどちらかに当たれば走る（cron と同じ OR）。
- command は 1 つの文字列で受け、`/bin/sh -c` に渡す。pipe・redirect・`"$(cat ~/prompts/dreaming.md)"` を書けるようにするため。
- cwd は既定で Backend の `$HOME`。CLI と Backend は cwd が違うので、絶対 path だけを受ける。相対 path か、directory でなければ `BAD_REQUEST`。
- timeout は `<数>s`・`<数>m`・`<数>h` の形で受け、既定は 1 時間、上限は 24 時間。Bun は 2^31 ms（約 24.8 日）を超える `setTimeout` の遅延を 1 ms に丸めるので上限が要り、1 日を超えて走る Job は想定しないので 24 時間にする。形が違うか上限を超えれば `BAD_REQUEST`。
- `remove` は Job の行と、その Job Execution の行を 1 つの transaction で消し、commit の後に `$MONICA_HOME/logs/jobs/<name>/` を消す。走っている間は `CONFLICT`。
- `pause` は行の pause を立て、次の予定を null にする。DB に持つので、再起動しても残る。pause の間も `run` では起こせる。`resume` は pause を下ろし、今から次の予定を計算する。
- system の Job への `remove`・`pause`・`resume` は `BAD_REQUEST`。`add` は名前の `.` で断られる。

### 予定

- `start()`・`add`・`resume` のときは、今から次の予定を計算する（`cron.nextRun(now)`）。予定の時刻に Backend が居なかった回は飛ばし、記録しない。
- tick が予定の時刻を過ぎたのに気づいたら起こし、次の予定はその時から計算する。
- tick が予定の時刻から 60 秒（tick の間隔の 2 倍）を超えて遅れて気づいた回は、起こさず、記録もせず、次の予定を今から計算する。Mac がスリープすると Backend の process は終わらずに凍り、起きた後の最初の tick には予定を大きく過ぎたように見える。深夜 3 時の Job を朝に走らせないよう、ADR-0016 の「予定の時刻に Backend が居なければその回は飛ばす」を凍っていた間にも当てる。system の Job はこの扱いをせず、1 回だけ走る（「tick」の節）。
- 前の Job Execution が走っている間に来た予定は飛ばし、次の予定を今から計算する。走っている回が予定の時刻より後で tick より前に終わっても飛ばす（system の Job と同じ）。

### process

- `/bin/sh -c <command>` を、cwd、`env: process.env`、stdin なしで、自分の process group（`detached: true`）として起こす。stdout と stderr は `$MONICA_HOME/logs/jobs/<name>/<開始時刻>.log` に書く。開始時刻は local time の `2026-10-07T030020.000` の形。
- PATH は Backend が login shell から取った PATH（`docs/packages.md` の「Backend の組み立て」）なので、`claude` は Tab の wrapper ではなく本物の claude になり、hook は付かない。
- 結果:
  - exit 0 なら `succeeded`。
  - それ以外は `failed` で、エラーの 1 行を `exit <code>: <出力の最後の 1 行>` にする。最後の 1 行は log の末尾 4 KiB の、空でない最後の行で、200 文字で切る。出力が無ければ `exit <code>` だけ。signal で終わったら `killed by <signal>` で始め、exit code は null。
  - spawn できなければ（add の後に cwd が消えたなど）`failed` で、エラーは `spawn failed: <理由>`。
  - timeout になったら process group に SIGTERM → 最大 2 秒 → SIGKILL を送り、`timed_out` にする。エラーは `timed out after <秒>s`。Bench の setup（`docs/packages/task-ledger.md` の「Bench」）と同じ形で、job は task を import しないので、同じ処理を `command.ts` に持つ。
- `stop()` は走っている process group に SIGKILL を送る。その行は次の起動で `interrupted` になる（「中断」の節）。
- Backend が SIGKILL で落ちると process group が孤児で残る。setup と同じ既知の穴として残す。

### claude を呼ぶ Job の成否

monica は exit code だけを見る（ADR-0016）。`claude -p` は tool を拒否された回も exit 0 で終わりうるので、Job が呼ぶ script が `--output-format json` の result 行と成果を確かめ、何もできていなければ 0 以外で終わる。

```sh
#!/bin/sh
# monica job add dreaming --schedule '0 3 * * *' --command ~/bin/dreaming.sh
set -u
result=$(claude -p "$(cat ~/prompts/dreaming.md)" --output-format json)
status=$?
echo "$result"
[ "$status" -eq 0 ] || exit "$status"
if echo "$result" | jq -e '.is_error or (.permission_denials | length > 0)' > /dev/null; then
  echo "dreaming: $(echo "$result" | jq -r '.result')" >&2
  exit 1
fi
# 成果（MEMORY.md が変わったかなど）も確かめ、無ければ 0 以外で終わる。
```

result 行は log に残るので、`session_id` を拾って朝に Tab で `claude --resume` できる。

## 記録

- Job Execution は `job_execution` に 1 回 1 行で持つ。列は Job の名前、予定の時刻、開始、終了、結果（`succeeded` / `failed` / `timed_out` / `interrupted`。走っている間は null）、exit code、エラーの 1 行、log の path。exit code と log の path はユーザーの Job だけが持ち、system の Job では常に null。
- 予定の時刻は、その回を起こすはずだった時刻。開始は実際に起こした時刻で、`list` の LAST は開始を見せる。
- system の Job の `run` が reject したら `failed` にし、エラーの message の 1 行目を残す。
- Job Execution を起こすたびに、行を足すのと同じ transaction で、その Job の直近 100 件より古い行を消し、commit の後にその行の log を消す。走っている回を含めても 100 件を超えないよう、消すのは足す側にする。5 分おきの `task.sync` だけで 1 日 288 行になるため。

## tick

- timer は Job Ledger が 1 本だけ持つ。`setInterval` の 30 秒の tick で、各 Job の次の予定を `now()` と比べる。次の予定まで `setTimeout` で直に待たない。Bun は 2^31 ms（約 24.8 日）を超える遅延を 1 ms に丸めるので、月 1 回の cron 式で壊れるため。
- system の Job は `start()` で 1 回走り、その後は前回の開始から `every` ごとに走る。tick は予定の時刻を過ぎた最初の tick で起こすので、開始は予定より最大 30 秒遅れ、次の予定もその分ずれる。
- system の Job は、sleep などで複数の予定を過ぎていても、起こすのは 1 回だけ。その回の予定の時刻は、過ぎた最初の予定のまま。
- 前の Job Execution が走っている間に予定の時刻が来たら、その回は飛ばし、記録しない。system の Job の次の予定は、前回の開始から `every` ずつ進めて今より後になる最初の時刻。走っている回が予定の時刻より後で tick より前に終わっても、その回は飛ばす。走っていた回が終わる時に、予定の時刻を過ぎていないかを見るため。`run` で起こした回が予定の時刻をまたいでも同じく飛ばす。
- `run` は今すぐ 1 回を起こし、終わりを待たずに返す。予定の時刻は起こした時刻で、次の予定は動かさない。走っている間は `CONFLICT` で断る。

## 中断

- `stop()` は tick を止め、それ以降に終わった回の結果を書かない。Backend は `stop()` を Task Ledger より先に呼ぶので、`stop()` が切った Sync の失敗は記録に残らない。
- `start()` は最初に、結果の無い行（Backend が途中で止まった回）を `interrupted` にする（Bench の準備の `failInterruptedPreparations` と同じ形）。終了の時刻は分からないので null のまま残す。

## テスト

- in-memory の SQLite に job の migration だけを当てる。job は他の domain の table を持たない。
- tick は `setInterval` を `spyOn` で捕まえて手で呼び、時刻は `now` に渡した時計で進める。fake timers は使わない（`docs/packages.md` の「テスト」）。
- system の Job の `run` は、呼ばれるたびに保留の Promise を返す偽物にし、終わり方（resolve / reject）と終わる時をテストが決める。
- ユーザーの Job は本物の `/bin/sh` で走らせ、home と cwd は `mkdtemp(tmpdir())` で作る。終わるまでは `show` を読み直して待つ。走り続ける回は、cwd に file ができるまで待つ command で止め、テストが file を置いて終わらせる。timeout は `setTimeout` を `spyOn` して timeout の ms の callback を捕まえ、手で呼ぶ（Bench の setup と同じ）。log の名前と Job Execution の時刻は `now` の時計から来る。
- 行数は procedure に出ないので、保持の件数と remove が消した行は `job_execution` を SELECT して確かめる。
