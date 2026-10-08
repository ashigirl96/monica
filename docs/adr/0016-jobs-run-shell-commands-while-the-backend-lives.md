---
status: accepted
---

# Job は Backend が動いている間だけ、予定の時刻に shell command を走らせる

裏で動く処理は、task の `start()` が張る 5 分おきの背景 sync（#18）だけで、前回の成否は memory の `backgroundSyncError` にしか残らず、再起動で消える。これに、深夜に claude を起こして MEMORY.md を掃除する、architecture review を回して issue を立てておく、log を片付ける、といった私が足したい処理が加わる。何が・どの間隔で・前回いつ・成否・次はいつ、を 1 か所で見るため、job の domain（`packages/job`）を足して timer をすべて持たせ、Job Execution を DB に 1 回 1 行で記録し、CLI の `monica job list` と `show` で見せる。system の Job（`task.sync` など）は apps/backend の `main.ts` が `{ name, every, run }` で渡し、ユーザーの Job は `monica job add` で DB に登録する。ユーザーの Job が走らせるのは shell command だけで、monica は claude を知らない。claude は `claude -p …` という command の 1 つで、成否は exit code で、timeout は setup.sh と同じく process group を kill して決まる。headless の claude 実行と personal agent は map #1 で Out of scope に置いたもので、monica をその runner にしない。Backend は desktop と同寿命のまま（ADR-0007）で、予定の時刻に Backend が居なければその回は飛ばす。私の Mac は system sleep しない設定なので、逃すのは desktop を閉じていた時と再起動の時だけになる。

## Considered Options

- **claude の prompt を走らせる**: monica が repo・prompt・permission mode から claude の起動を組み立て、session_id を記録する。monica が claude の runner になり、map #1 が退けた personal agent の入口になる。command のままでも `--output-format json` を付ければ session_id は Job の log に残り、朝に Tab で resume できる。
- **Workbench に Tab を開いて claude を対話で起こす**（Task の run と同じ形）: Agent Session として観測でき、画面で見られる。しかし claude は手空きで止まるだけで終わらないので、成否は Agent Session の状態から決めることになり、job が workbench に依存する。諦めて手空きになった回も完了に見えるので、作業が済んだかは exit code と同じく分からない。毎晩 Tab が増え、深夜に通知が溜まる。shell command の Job と並ぶ 2 つ目の種類として後から足せるので、朝に resume する手間が効いてきたら足す。
- **設定ファイルに宣言する**（`$MONICA_HOME/jobs.toml` など）: dotfiles として git で管理できるが、map #1 が fog のまま閉じた設定の層を作ることになり、読み直しの契機と構文エラーの見せ方も要る。CLI から DB に登録すれば ADR-0003 の形のままで、CLI は Skill の語彙なので agent にも登録を頼める。長い prompt は、command が呼ぶ script の file に置く。
- **ユーザーの Job は launchd に任せる**: 一覧が monica と launchd の 2 か所に割れる。
- **timer を各 domain に残し、job の domain は記録だけを持つ**: 次はいつかを知っているのは timer を持つ側だけなので、各 domain に次の時刻を聞く口が要る。各 domain が job に自分の Job を登録する形は task → job の依存を生む。`main.ts` が並べれば、apps は組み立てるだけ（ADR-0002）と、domain を直接並べる `docs/packages/backend.md` の「起動と終了」の延長で、job は task も workbench も import しない。
- **起動時に逃した回を 1 回走らせる**（nanoclaw の形）: 深夜を選んだ理由（作業と重ねない）を破り、朝に desktop を起こした時に claude が MEMORY.md を書き換え、usage を使う。逃したことは一覧の前回の時刻で分かり、`monica job run` で追いつける。

## Consequences

- 背景 sync の `setInterval` は task の `start()` から job の domain に移り、task は sync の関数を出すだけになる。`task.list` の `backgroundSyncError` は今のまま task の memory から出す。読み出しを job の記録に移すと task → job の依存が生まれるため。
- system の Job は起動時に 1 回走り、その後は間隔ごとに走る。ユーザーの Job は cron 式（Mac の local の timezone）で書き、起動時に今から次の予定を計算する。前の Job Execution が走っている間に来た予定は飛ばす。
- claude の Job の成否は、Job が呼ぶ script が決める。`claude -p` は tool を拒否された回も質問できずに終えた回も exit 0 で終わりうるので、script が `--output-format json` の result 行（`is_error`、`permission_denials`）と成果を確かめ、何もできていなければ 0 以外で終わる。monica は exit code だけを見る。
- ユーザーの Job の process は Backend の `process.env`（login shell の PATH）で起こすので、PATH の `claude` は Tab の wrapper ではなく本物になり、hook が付かず、Agent Session にならない。
- Backend が Job Execution の途中で止まると process group を kill し、次の起動でその行を中断にする（Bench の準備の `failInterruptedPreparations` と同じ形）。
- `docs/packages/backend.md` の「domain は 2 つしかないので」は 3 つになるが、汎用の domain の登録機構を作らずに直接並べる方針は変えない。
- task は sync の関数だけでなく、system の Job の並び（名前・間隔・`run`）も `@monica/task/server` の `systemJobs(taskLedger)` で出し、Backend の組み立てはそれを job に渡すだけにした（#110）。Backend の組み立てと CLI のテストの in-memory の Backend の 2 か所に同じ並びを写すと、CLI のテストが本物の名前と間隔を確かめないため。task は job を import せず、`{ name, every, run }` と同じ構造の素のオブジェクトを返すので、退けた task → job の依存は生まれない。
- 一覧は CLI だけで、画面も通知も持たない。失敗に気づくのは一覧を見た時になる。
- Job の追加は CLI に出すので、Tab の agent も呼べる。関門は Claude Code の Bash の許可で、agent が今も crontab や launchd でできることを超えない。
