# Job Ledger

`packages/job` の contract と、Job Execution の記録と起こし方の規則。決定の理由は ADR-0016 にある。今あるのは system の Job だけで、ユーザーの Job（cron 式、shell command、log、timeout）は後続の issue で足す。

## contract（root は `job`）

```
list  → { jobs: { name, schedule, state, last: { startedAt, result } | null, nextAt }[] }  cli
show  { name } → { name, schedule, state, nextAt, executions: JobExecution[] }          cli
run   { name } → { name, startedAt }                                                    cli
```

- `schedule` は `{ type: "every", ms }`。ユーザーの Job の cron 式は 2 つ目の type として足す。
- `state` は `active` / `paused` / `running`。system の Job は止められないので、今は `paused` にならない。
- `last` は終わった Job Execution のうち最新のもの。走っている回は `state` の `running` で分かるので、`last` には前回の結果を残す。`nextAt` は `start()` の前は null。
- `show` の `executions` は新しい順に 20 件。
- 無い名前は `NOT_FOUND`。
- change stream は持たない。購読する画面が無いため（ADR-0016）。
- CLI の時刻は local time の `YYYY-MM-DD HH:MM:SS` で出す。`list` の LAST は開始時刻と結果、`show` の DURATION は終わった回だけに出し、走っている回の RESULT は `running` にする。`show` と `run` の名前の位置には Job の名前を補完する。

## createJobLedger

`createJobLedger({ db, systemJobs, now? })`。`systemJobs` は `{ name, every, run }` の配列で、`run` は失敗なら reject する。名前が重なれば throw する。`now` はテストが時計を進めるための口。

job は task も workbench も import しない（ADR-0016）。system の Job は apps/backend の `main.ts` が並べ、`task.sync` の `run` は `taskLedger.syncInBackground()` を、`task.setup-log-cleanup` の `run` は `taskLedger.cleanSetupLogs()` を呼ぶ。`Db` の型も drizzle の `BunSQLiteDatabase` を直に使う。

## 記録

- Job Execution は `job_execution` に 1 回 1 行で持つ。列は Job の名前、予定の時刻、開始、終了、結果（`succeeded` / `failed` / `timed_out` / `interrupted`。走っている間は null）、exit code、エラーの 1 行、log の path。exit code と log の path は後続のユーザーの Job が使い、今は常に null。
- 予定の時刻は、その回を起こすはずだった時刻。開始は実際に起こした時刻で、`list` の LAST は開始を見せる。
- `run` が reject したら `failed` にし、エラーの message の 1 行目を残す。
- Job Execution を起こすたびに、行を足すのと同じ transaction で、その Job の直近 100 件より古い行を消す。走っている回を含めても 100 件を超えないよう、消すのは足す側にする。5 分おきの `task.sync` だけで 1 日 288 行になるため。

## tick

- timer は Job Ledger が 1 本だけ持つ。`setInterval` の 30 秒の tick で、各 Job の次の予定を `now()` と比べる。次の予定まで `setTimeout` で直に待たない。Bun は 2^31 ms（約 24.8 日）を超える遅延を 1 ms に丸めるので、月 1 回の cron 式で壊れるため。
- system の Job は `start()` で 1 回走り、その後は前回の開始から `every` ごとに走る。tick は予定の時刻を過ぎた最初の tick で起こすので、開始は予定より最大 30 秒遅れ、次の予定もその分ずれる。
- sleep などで複数の予定を過ぎていても、起こすのは 1 回だけ。その回の予定の時刻は、過ぎた最初の予定のまま。
- 前の Job Execution が走っている間に予定の時刻が来たら、その回は飛ばし、記録しない。次の予定は、前回の開始から `every` ずつ進めて今より後になる最初の時刻。走っている回が予定の時刻より後で tick より前に終わっても、その回は飛ばす。走っていた回が終わる時に、予定の時刻を過ぎていないかを見るため。`run` で起こした回が予定の時刻をまたいでも同じく飛ばす。
- `run` は今すぐ 1 回を起こし、終わりを待たずに返す。予定の時刻は起こした時刻で、次の予定は動かさない。走っている間は `CONFLICT` で断る。

## 中断

- `stop()` は tick を止め、それ以降に終わった回の結果を書かない。Backend は `stop()` を Task Ledger より先に呼ぶので、`stop()` が切った Sync の失敗は記録に残らない。
- `start()` は最初に、結果の無い行（Backend が途中で止まった回）を `interrupted` にする（Bench の準備の `failInterruptedPreparations` と同じ形）。終了の時刻は分からないので null のまま残す。

## テスト

- in-memory の SQLite に job の migration だけを当てる。job は他の domain の table を持たない。
- tick は `setInterval` を `spyOn` で捕まえて手で呼び、時刻は `now` に渡した時計で進める。fake timers は使わない（`docs/packages.md` の「テスト」）。
- system の Job の `run` は、呼ばれるたびに保留の Promise を返す偽物にし、終わり方（resolve / reject）と終わる時をテストが決める。
- 行数は procedure に出ないので、保持の件数は `job_execution` を SELECT して確かめる。
