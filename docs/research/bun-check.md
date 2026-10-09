# `bun run check` の時間の内訳と、削れるテスト・待ち

`bun run check` が長いという相談で、各段の時間を測り、遅いテストと実時間の待ちと重複したテストを洗い出した。決定はまだ無い。直すときは issue に切る。

確かめた環境: macOS（28 core の Mac Studio）、Bun 1.4.2、Rust は `rust-toolchain.toml` の版。測った commit は `6da49af`（#306 の後）で、途中で他の session が main を `4505fba` まで進めた（テストが 1833 本から 1841 本に増えた）。同じ machine で他の session が動いていて、load average は 8〜34 の間で揺れた。下の秒数はその負荷の下の値で、±30% ほど揺れる。

## 要約

- **支配的な段は `bun test`（`scripts/test.ts`）**。`bun run check` 全体の 26〜39 秒のうち 17〜24 秒を占める（61〜68%）。残りは cargo test が約 6 秒で、ほかの段は各 0.4〜2 秒。
- `bun test` は `--parallel=8` なので、壁時計の時間は **一番遅い file 1 つ** で決まる。今は `packages/task/src/close.test.ts`（単体で 12.4 秒）。file の時間の合計は 90 秒で、そのうち 56.5 秒（63%）が `packages/task`。
- 遅さの中身は process の起動（sys 61 秒 > user 35 秒）。task のテストは 1 本あたり git を 10〜17 回起こし、fixture の origin を作るだけで 1 回 100〜125ms かかる。固定の実時間の待ち（2 秒の猶予 3 本、500ms の debounce 4 本など）は合計で約 10 秒ある。
- 削れる見込み: `bun test` の壁時計は 16〜24 秒から 9〜11 秒ほどに、`bun run check` 全体は 26〜39 秒から 15〜25 秒ほどに縮む見込み。file の合計（CPU 時間）は 90 秒から 50 秒前後になる見込みで、他の session と同時に流したときの待ち合いも減る。どれも見込みで、直した後に測り直す。

優先度順の推奨:

1. **`scripts/test.ts` に `--timings` を渡し、遅い file から始める**。1 行で済み、測ったところ 16.6〜17.7 秒が 14.4〜14.6 秒になった（約 2〜3 秒）。timings の file をどこに置くか（commit するか、手元で `--update-timings` するか）は決める必要がある。
2. **task のテストの fixture で git を減らす**。origin と clone 済みの checkout を template から `cpSync` する（1 回 100ms 超が 1〜2ms になる）。git を使わないテストでは origin を作らない。Bench の型に依存しないテストは in-place の Bench にする。CPU 時間と、壁時計を決める `close.test.ts` の両方に一番効く。
3. **実時間の待ちを、捕まえた timer を手で呼ぶ形か `setSystemTime` に替える**。2 秒の猶予（`bench.test.ts`・`user-job.test.ts`）、hook の 2 秒、`ui-state.test.ts` の 500ms の debounce、ptyd の繋ぎ直しの backoff、chat の `Bun.sleep(500)` と `Bun.sleep(100)`。本番に seam を足さずに書ける形を「timeout と sleep の一覧」に挙げた。
4. **重複したテストを消す**。確度の高いものは 7 本（chat 1、run-claude 1、run-button 1、bench 1、teardown 1 と、まとめるもの 2）。速さより、同じ契約を 2 か所で持つ保守の費用を減らすのが目的。
5. **`check` の段どうしを並べて流すことを測る**。`check:ts` と `check:rust` は `&&` で直列になっている。並べれば cargo の約 6〜8 秒が隠れるかもしれないが、macOS の初回 exec の検査で待ち合う（`docs/packages/dev-loop.md:75`）ので、2〜3 の後に測ってから決める。

## 1. `bun run check` が流すもの

`package.json:77-79` の script を辿ると、次の 10 段が `&&` で 1 列に流れる。CI も同じ script を呼ぶ（`.github/workflows/ci.yml:27`、`:76`）。

| 段 | コマンド | 秒（1 回目、段ごと） |
|---|---|---|
| lint | `oxlint …`（type-aware） | 1.46 |
| format | `oxfmt --check` | 0.41 |
| 型 | `tsc --noEmit`（TypeScript 7） | 0.94 |
| **テスト** | `bun scripts/test.ts` → `bun test --parallel=8` | **23.90** |
| build | `vite build`（desktop） | 1.09 |
| build | `vite build`（web） | 1.06 |
| build | `vite build`（extension） | 1.94 |
| Rust format | `cargo fmt --all --check` | 0.47 |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` | 1.08 |
| Rust テスト | `cargo test --workspace` | 6.39 |
| 合計 | | 38.7 |

- 測り方: scratchpad の sh script で各段を順に流し、前後の時刻の差を取った（load 10 前後）。
- `bun run check` を通しで 2 回流すと 27.2 秒と 25.7 秒だった（load 8〜11）。そのうち `bun test` の報告は 18.1 秒と 17.3 秒。
- Rust は incremental の build が効いた状態の値。`crates/terminal-protocol/src/lib.rs` を touch して流し直しても、clippy 2.1 秒、cargo test 9.9 秒（build 3.0 秒）だった。Rust を触ったときだけ数秒増える程度で、支配的ではない。
- #301 で測ったときは直列の `bun test` が 83〜104 秒だった。#306 で `--parallel=8` にしたので、今の遅さはそのときの 1/4 ほど。

## 2. テストの時間の内訳

### bun test

測り方: `bun test --parallel=8 --reporter=junit --reporter-outfile=… --timings=… --update-timings`。junit は test ごとの `time` を、timings は file ごとの ms を JSON で書く（`bun test --help`、https://bun.com/docs/test/parallel ）。

壁時計 16.5 秒、`user 35.2 s`・`sys 61.7 s`、file の合計 90.3 秒、127 file、1833 本。

package ごとの合計:

| 秒 | package |
|---|---|
| 56.5 | packages/task |
| 11.3 | packages/workbench |
| 11.0 | packages/chat |
| 3.2 | apps/cli |
| 2.9 | apps/backend |
| 2.9 | packages/job |
| 1.5 | packages/note |
| 1 未満 | その他 |

遅い file（`--parallel=8` の下での file ごとの時間）:

| 秒 | file | 本数 | git の起動 | 主な原因 |
|---|---|---|---|---|
| 12.39 | `packages/task/src/close.test.ts` | 32 | 442 | worktree の Bench を開いて閉じる（1 本で git 約 17 回） |
| 9.67 | `packages/task/src/run-button.test.ts` | 38 | 283 | git の要らないテストでも origin を作る |
| 9.36 | `packages/task/src/bench.test.ts` | 17 | 160 | 本物の git と setup.sh の実行、2 秒の猶予 |
| 8.53 | `packages/chat/src/chat.test.ts` | 36 | 0 | 偽の claude（bun）を 1 本で 1〜2 個起こす、Worker、`ps` の polling |
| 7.55 | `packages/task/src/run-claude.test.ts` | 31 | 254 | 全部のテストで origin を作る |
| 3.88 | `packages/task/src/attach.test.ts` | | | `openBench` が常に worktree |
| 3.55 | `packages/task/src/run.test.ts` | | | 同上 |
| 3.09 | `packages/workbench/src/ui/sidebar-model.test.ts` | 31 | 88 | `ghqCheckout`（1 回で git 5 回） |
| 2.88 | `packages/job/src/user-job.test.ts` | | | 2 秒の猶予、`true` を 101 回 spawn |
| 2.74 | `apps/backend/src/main.test.ts` | 9 | | 1 本ごとに `bun main.ts` を起こす |
| 2.72 | `packages/task/src/current.test.ts` | | | `openBench` が常に worktree |
| 2.21 | `apps/cli/src/hook.test.ts` | | | hook の 2 秒の打ち切りを本物で待つ |
| 2.20 | `packages/task/src/ui/close-bench.test.ts` | 4 | | 準備中にするため setup.sh を初めて exec する |
| 2.13 | `packages/workbench/src/tab-env.test.ts` | | | 本番が書く wrapper が毎回新しい実行 file になる |
| 2.06 | `packages/workbench/src/ui/ui-state.test.ts` | | | 500ms の debounce を 4 本が本物で待つ |

git の回数は、PATH の先頭に置いた git の shim で 1 file ずつ単体で数えた（shim が数えるのは PATH で引く `git` だけ）。

1 本で 2 秒を越えるテストは、次の 3 本だけだった。どれも本番の固定時間を本物で待っている。

| 秒 | テスト |
|---|---|
| 2.58 | `bench.test.ts` `a setup still running after 600 seconds fails, its process group getting SIGTERM and 2 seconds before SIGKILL` |
| 2.04 | `user-job.test.ts` `a Job still running at its timeout is timed out, its process group getting SIGTERM and 2 seconds before SIGKILL` |
| 2.03 | `apps/cli/src/hook.test.ts` `a Backend that does not answer is given up after 2 seconds and the hook exits 0` |

その次は 0.4〜0.9 秒のテストが続き、ほとんどが task の worktree を作るテスト。

### 並列の設定を変えて測った

| 設定 | 壁時計 | 結果 |
|---|---|---|
| `--parallel=8`（今の設定） | 17.7 / 16.6 秒 | pass |
| `--parallel=8 --timings=<前回の計測>` | 14.6 / 14.4 秒 | pass |
| `--parallel=8 --no-isolate --timings=…` | 15.4 秒 | pass（load 34 の下） |
| `--parallel=16 --timings=…` | 32.3 秒 | **1 fail**。`sidebar-model.test.ts` の `ghqCheckout` の `git init` が 5 秒の timeout に当たった |

- `--timings` を渡すと、各 worker が遅い file から始める（https://bun.com/docs/test/parallel 、「each worker starts its slowest file first」）。一番遅い `close.test.ts` が最後に回らなくなるので、2〜3 秒縮んだ。
- 並列度を上げると遅くなり、落ちる。process の起動と macOS の初回 exec の検査が system 全体で待ち合うため（`docs/packages/dev-loop.md:75`）。8 のままでよい。
- 並列の単位は file。1 つの file の中は分けられないので、一番遅い file が壁時計の下限になる（https://bun.com/docs/test/parallel ）。
- `--no-isolate` は差が出なかった。file が互いの残り物を見えるようになる（同じページ）ので、採らない。

### 1 回あたりの費用（microbenchmark）

| 操作 | ms |
|---|---|
| `Bun.spawnSync(['git','-C',repo,'rev-parse','HEAD'])` | 11.7 |
| `Bun.spawnSync(['/bin/sh','-c','true'])` | 3.0 |
| `Bun.spawnSync([bun,'-e','0'])` | 4.8 |
| origin を作る（init・add・commit・rev-parse）＋ clone | 104.7（task の監査では origin だけで 126） |
| 同じ origin と clone を `cpSync` で写す | 1.4 |

### cargo test

`cargo test --workspace` の 6.4 秒のうち、test binary の実行時間は次のとおり。

- `crates/ptyd/tests/daemon.rs`: 7 本で 2.96 秒。
- `monica-terminal-daemon`: 85 本で 1.26 秒。
- ほかは各 0.1 秒以下。

binary の中は thread で並列に、binary どうしは直列に流れる（https://doc.rust-lang.org/cargo/commands/cargo-test.html 、「each target compiles to a special executable … and then is run serially」）。`daemon.rs` の 2.96 秒は、`session_survives_client_reconnect_and_replays_output` の `thread::sleep(2500ms)`（`crates/ptyd/tests/daemon.rs:197`）と、daemon が 2 秒ごとに socket を見る間隔（`crates/terminal-daemon/src/daemon/mod.rs:21`）で決まっている。

## 3. 遅い原因の分類

| 分類 | どこで | 規模 |
|---|---|---|
| 実 process（git） | task の fixture（`packages/task/src/fake-ghq.ts:8-12` の `git()` は `spawnSync`）、本番の prepare と close、workbench の `ghqCheckout` | task の 56.5 秒の大半。close だけで 442 回 |
| 要らない setup の繰り返し | git を使わないテストでも作る origin（`run-button.test.ts:19`・`run-claude.test.ts:22`・`close.test.ts:27` の helper）。`openBench`（`packages/task/src/testing.ts:91`）は Bench の型が関係ないテストでも worktree を開く | 1 本で 100〜400ms |
| 実 process（bun） | chat の偽の claude と spare、`main.test.ts` と `hook.test.ts` の `bun main.ts`、HTML と PDF の Worker | chat 8.5 秒、backend 2.7 秒 |
| 新しく書いた実行 file の初回 exec | `tab-env.test.ts` の wrapper、`close-bench.test.ts` と `close.test.ts` の setup.sh | 1 回 0.1〜0.3 秒（負荷の下では秒単位） |
| 固定時間の待ち | 2 秒の猶予 ×2、hook の 2 秒、debounce 500ms ×4、ptyd の繋ぎ直しの backoff 200ms ×4、chat の sleep 0.6 秒、backend.test の 300ms | 合計 約 10 秒（CPU は使わないが、その file の時間を延ばす） |
| 直列の部分 | `check:ts` と `check:rust` の `&&`、build 3 つの直列、cargo の test binary の直列 | 6〜10 秒 |
| 並列の単位が file | `close.test.ts` 1 つが壁時計の下限 | 12 秒 |

ビルドの重複は見つからなかった。`vite build` 3 つは別々の app で、合わせて約 4 秒。

## 4. 重複・価値の低いテストの候補

判断の基準は `test-audit` skill（低価値、実装への結合、重複、テストのためだけの production の seam）に従った。遅いことは消す理由にしない。下の表は、同じ振る舞いを別のテストが同じか強い境界で既に確かめているものだけを挙げる。消す前に、変異を入れてカバーしているテストが落ちることを確かめる（`docs/packages/dev-loop.md:83`）。

| file | テスト名 | 何を検出するか | 既にカバーしているテスト | 推奨 | 確度 |
|---|---|---|---|---|---|
| `packages/chat/src/chat.test.ts` | `aborting the call while claude answers kills that claude` | abort で claude が死ぬ | `an aborted answer starts no spare`。手順が同じで、同じ `gone(pid)` に加えて `claudes()==[]` も確かめる | 消す | 高 |
| `packages/chat/src/chat.test.ts` | `an aborted answer closes without an error` | abort した stream が error なしで閉じる | 上の 2 本の `for await` が投げないこと。この test にしか無いのは `['snapshot','text']` の並びの assert だけ | `an aborted answer starts no spare` に並びの assert を足して 1 本にする | 中〜高 |
| `packages/task/src/run-claude.test.ts` | `run types the prompt given in place of /tackle` | 渡した prompt が /tackle の代わりに打たれる | `a prompt with ' in it reaches claude as one argument, with nothing in it expanded`。argv が `[prompt]` と一致することを見るので、prompt を無視すれば落ちる | 消す | 高 |
| `packages/task/src/run-button.test.ts` | `running from the resume button of a triage Issue resumes claude without the /triage prompt` | triage の resume で prompt を送らない | `a Task whose repo was renamed before any sync still gets its resume button by the new name, and resumes claude without the prompt`。同じ needs-triage で `{kind:'triage', run:'resume'}` と `claude --resume 's-1'\r` の両方を見る | 消す | 高 |
| `packages/task/src/bench.test.ts` | `a Repo without a setup script gets a ready Bench` | setup.sh が無ければ ready になる | script の無い worktree で `run` の成功を await するテストすべて（close.test の `withWorktreeBench` など）。失敗すれば PRECONDITION_FAILED を投げるので全部落ちる | 消す | 高 |
| `packages/task/src/teardown.test.ts` | `with force, the worktree and the branch go whatever was written after the inspection` | force では dirty でも未 push の commit があっても消す | `close.test.ts` `close refuses with every reason it finds, a live Run, uncommitted changes and commits on no remote, and changes nothing; --force closes anyway` | 消す | 高 |
| `packages/task/src/run-button.test.ts` | `running from the button of a %s Issue types claude with /wayfinder, its map and itself into a Bench of its own Task`（4 件） | 4 つのラベルの認識と、`/wayfinder` の組み立て | ラベルの認識は各 case の `runButtons` の assert で足りる。`runFromButton` の後半はラベルに依存しない | `runButtons` の assert は 4 件とも残し、`runFromButton` は 1 件だけ流す | 高 |
| `packages/task/src/run-claude.test.ts` | `the claude run started becomes a Run of the Task, waiting idle` | Bench の Tab の claude が Run になる | `run.test.ts` `a claude started in a Tab of the Bench becomes a Run of the Task, waiting idle`（display state まで見る） | 消す | 中〜高 |
| `packages/chat/src/chat.test.ts` | `a question on the page of an earlier turn gets a snapshot that points at that turn, and claude does not read the text twice` | 同じページの判定、history の配線、document を 2 回送らないこと | `snapshot.test.ts` `a page whose URL, apart from the hash, and text match an earlier one points at the newest such turn…`、chat.test の PDF の `…the same PDF asked again points at that turn`、`prompt.test.ts` `a page the same as an earlier one has no document of its text…` | 消す | 中〜高 |
| `apps/backend/src/main.test.ts` | `the Backend answers chat.ask with the claude that MONICA_CLAUDE_PATH names` | env `MONICA_CLAUDE_PATH` の配線 | 同じ file の `a failure after some text of the answer reaches an RPCLink client…` も偽の claude が流した text を受ける | 消す（Backend の起動が 1 回減る） | 中 |
| `packages/task/src/run-button.test.ts` | `running from a button types the prompt of the labels the Issue has when it runs, not when the button was told` | 押した時点のラベルを読み直す | `running from a button reads the labels anew and refuses an Issue that has lost its button…` が同じ変異で落ちる | 消す | 中 |
| `packages/task/src/close.test.ts` | `a live Run stops close of an in-place Bench` | in-place の Bench でも live Run が close を止める | `liveRunsBesides` は Bench の型で分岐しない（`packages/task/src/close.ts:53`）。worktree の `close refuses with every reason…` が同じ gate を見る | 消す | 中 |
| `packages/task/src/close.test.ts` | `reopen opens a closed Task with no Bench, and the next run makes the worktree and the Bench anew on a new branch issue-n` | 後半（2 回目の run と HEAD）は古い branch が消えたこと | branch の削除は force close のテスト、origin/main から作ることは bench.test の最初のテストが見る | reopen の出力・合図・not_started だけを残す | 中 |
| `packages/task/src/run-claude.test.ts` | `run given %s of an untracked Issue…` の URL の case | URL の ref で run できる | `ref.test.ts` の URL の parse、`track.test.ts` の URL の track | 消す | 中〜低 |

検討したが残すもの（理由つき）:

- `close.test.ts` の merged PR の 4 本（squash merge、only closes、commits after merge、head missing）: `mergedHeads` の選び方と `--ignore-missing` を別々に見ている。
- `close.test.ts` の「GitHub に届かなければ写しで続ける」3 本（close、reopen、run）: 入口がそれぞれ違う。
- `chat.test.ts` `leaving the answer before the result kills the claude that answers`: `break` で抜ける経路は abort せず `finally` だけが走る。abort とは別の経路。
- `chat.test.ts` `a spare claude that is not logged in…`: `fromSpare` の経路を見る唯一のテスト。
- `user-job.test.ts` の 100 件を残すテスト: 残す数そのものが contract。速くするなら DB に行を直に入れて 1 回だけ走らせる（優先度は低い）。
- `teardown.test.ts` の force 以外の 3 本: inspect の後の競合の窓は close からは作れない。
- `run --force still syncs the Task`: force が gate と一緒に sync も飛ばす、というありそうな変異を捕まえる。

速くするために書き換える候補（消さない）:

- task: origin と clone の template（files の種類ごとに memo して `cpSync`。clone を写したら `.git/config` の remote の url を写し先の origin に書き換える）。git を使わないテストから origin を外す（run-button の約 19 本、run-claude の 10 本、close の 8 本）。`openBench`・`liveRun`（`run-button.test.ts:326`）・`benched`（`setup-log.test.ts:29`）を in-place と checkout の mkdir にする。in-place の Bench は checkout が在れば git を 1 回も呼ばない（`packages/task/src/prepare.ts:75` は `existsSync` しか見ない）。scratchpad の probe では、Run の帰属・close・setup log が git 0 回、81ms で成り立った。worktree が要る sync.test の 3 本と close の worktree の本は今のまま残す。
- `packages/workbench/src/testing.ts` の `ghqCheckout`: 使わない `elsewhere` の repo（init と commit で約 40ms）を、使う `repo.test.ts` に移す。
- `tab-env.test.ts` の `test.each` の 5 本と `…past another wrapper…`: home を 1 つにして wrapper の初回 exec を 6 回から 1 回にする。ただし、その 1 回が負荷の下で `Bun.spawn` の `timeout: 5000` を越えないかを確かめる。
- `packages/chat/src/page/snapshot.test.ts`: ARTICLE の本文を module で 1 回だけ作り、使い回す（同じ変換が約 9 回、1 回 70〜140ms）。
- `close.test.ts` を 2 つの file に分ける: 並列の単位が file なので、上の書き換えの後も一番遅い file が残るなら分ける。

## 5. timeout と sleep の一覧と、待たずに書く形

grep の対象は `setTimeout|Bun.sleep|sleep(|waitFor|until(|untilSettled|receivedAtLeast|{ timeout|timeout:|第 3 引数の数値|useFakeTimers|setSystemTime`（TS）と `thread::sleep|time::sleep|Duration::from|timeout`（Rust）。全 214 行の出力から、問題の無い形（条件を待つ poll、microtask を回す `Bun.sleep(0)`、`setSystemTime` で時刻を固定する形、`setTimeout` を spy して手で呼ぶ既存の形）を除いた。

前提: Bun の `jest.useFakeTimers()` は `Bun.sleep` と `setTimeout` を全部止める。一部の timer だけを偽にできないので、HTTP の応答を待つテストが進まなくなる（`docs/packages.md:148`）。公式の文書は `useFakeTimers` と `setSystemTime` が在ることと、mock した時刻が `Date.now`・`new Date()`・`Intl.DateTimeFormat` に効くことしか書いていない（https://bun.com/docs/test/dates-times ）。そこで、この repo の規約（`setTimeout` を `spyOn` して callback を手で呼ぶ、`docs/packages.md:146-148`）と、`Date.now()` で締め切る loop には `setSystemTime` を使う。

### 正の待ち（何かが起きるのを時間で待つ）

| 場所 | 待っているもの | 待たない書き方 |
|---|---|---|
| `packages/task/src/bench.test.ts` `a setup still running after 600 seconds fails, …`（本番は `packages/task/src/prepare.ts:173-179`） | TERM を無視する子に対し、`SETUP_KILL_GRACE_MS`（2000）を `Date.now()` の締め切りと `Bun.sleep(50)` の loop で待ち切る | 締め切りは `Date.now()` で見るので、`.cleaned` ができた後に `setSystemTime(new Date(Date.now() + 2_001))` で時計を進める。次の loop で SIGKILL に進む。本番の変更は要らず、`+1_999` で stubborn がまだ生きていることも確かめれば「2 秒」の値も見られる |
| `packages/job/src/user-job.test.ts` `a Job still running at its timeout is timed out, …`（本番は `packages/job/src/command.ts:84-90`） | 同じ形の `KILL_GRACE_MS`（2000） | 同上 |
| `apps/cli/src/hook.test.ts` `a Backend that does not answer is given up after 2 seconds and the hook exits 0`（本番は `packages/workbench/src/cli.ts:32` の `AbortSignal.timeout(2000)`） | 子の `bun main.ts` が 2 秒で諦めるまで | 子の process なので、テストの process からは spy できない。子に `bun --preload <テスト用の file>` を渡し、preload が `AbortSignal.timeout` を「ms を file に書き、すぐ abort する signal を返す」ものに差し替える。テストは記録が 2000 であることと、exit 0 を確かめる。abort が fetch に繋がっていなければ hang して落ちる。本番に seam は要らない。経過時間の assert（`> 1900`・`< 3000`）は消える |
| `packages/workbench/src/ui/ui-state.test.ts` の 4 本（`saveFrom`、本番は `packages/workbench/src/ui/ui-state-persistence.ts:15`・`:47` の 500ms の debounce） | 本物の 500ms | `spyOn(globalThis, 'setTimeout')` で ms===500 の callback を捕まえて手で呼ぶ（`packages/note/src/ui/notes/save-queue.test.ts:31` と同じ形）。`stop()` でも flush されるが、それだと timer が壊れても通るので使わない |
| `packages/workbench/src/workbench.test.ts:199`、`agent-session.test.ts:643`・`:669`、`pin.test.ts:191` の `Bun.sleep(50)` | ptyd を止めた後、Backend が 1 回失敗するまで。結果として本番の backoff `Bun.sleep(Math.min(5000, 200 * 2 ** attempt))`（`packages/workbench/src/workbench.ts:136`）の 200ms も待つ | `spyOn(Bun, 'sleep')` で、ms が 200 の初回（繋ぎ直しの 1 回目が失敗した印）のときに `startFakePtyd(home)` を起こしてすぐ resolve し、ほかの ms は本物に流す。4 本で共有の helper（例 `restartPtyd(home)`）にする |
| `packages/chat/src/chat.test.ts:224` `Bun.sleep(500)`（`while a page whose DOM nests 3,000 deep turns into text, the Backend answers its other calls at once`） | 3,000 段の DOM の変換が始まるまで | `spyOn(globalThis, 'setTimeout')` で、`textInWorker` が 30_000ms の timer を仕掛けたこと（Worker に request を渡した印）を待ち、そこから `prepare()` を測る |
| `packages/chat/src/chat.test.ts:497` `Bun.sleep(100)` | 4 つの ask が `reading++` に届くまで | 30_000ms の `setTimeout` が 4 回呼ばれるのを待つ |
| `apps/cli/src/backend.test.ts:75` `setTimeout(() => serveBackend(home), 300)` | CLI が繋ぎ直しを 1 回失敗するまで | in-process なので、`spyOn(Bun, 'sleep')` で `RETRY_INTERVAL_MS`（200）の初回のときに `serveBackend` を起こしてすぐ resolve する |
| `packages/task/src/sync.test.ts:446` `Bun.sleep(50)` | 1 本目の sync が GitHub で止まるまで | `packages/task/src/fake-github.ts:130` は request を記録してから `held` を待つので、`github.requests.length === 1` を待ってから `release()` する。fake-github に、fake ptyd の `received`（`packages/workbench/src/fake-ptyd.ts:79`）と同じ「届いたら resolve する」waiter を足せば poll も要らない |
| `packages/task/src/sync.test.ts` `a sync that joins a running one gives up at its own timeout`（`syncTask(deps, ref, 50)`） | 本物の 50ms の打ち切り | `setTimeout` を spy して ms===50 の callback を手で呼ぶ（`docs/packages.md:146`） |
| `packages/note/src/image.test.ts:244` `Bun.sleep(50)` | fetch が飛んでいる途中であること | site の handler で `arrived()` を resolve し、それを await する |
| `packages/note/src/image.test.ts` `an import from a site that %s is given up at its timeout`（`importImage(…, 100)`） | 本物の 100ms。引数 `timeoutMs` を渡す本番の呼び手は `IMPORT_TIMEOUT_MS` の 1 か所だけで、テストのための seam になっている | `link-metadata.test.ts:229` の `captureTimeouts`（`AbortSignal.timeout` の spy）で手で発火させ、ms の値も確かめる。そのうえで引数を消す |
| `packages/task/src/close.test.ts:430`、`ui/close-bench.test.ts:102`（上限 15 秒）と `:112` の timeout 20 秒、`bench.test.ts:77` | 準備中の Bench を作るため、新しく書いた setup.sh を exec して file を poll する（初回 exec の検査も待つ） | `spyOn(ghq.client, 'get')`（in-place）か `root`（worktree）を pending の Promise にして準備を止める。setup.sh も poll も 20 秒の timeout も消える。probe では、in-place と get の hold で preparing になり、close は CONFLICT、git 0 回、73ms だった。setup.sh の振る舞いそのものを見るテストは今のまま残す |
| `packages/task/src/close.test.ts:447`、`run-button.test.ts:460`・`:463` | `github.requests.length` を 25ms ごとに poll | fake-github の waiter（上と同じ）を await する |
| `packages/task/src/close.test.ts:493` | `answer !== undefined` を poll | mock の中で deferred を resolve し、それを await する（`attach.test.ts` に同じ形がある） |
| `packages/task/src/close.test.ts:578`・`:589`・`:599` | spy した `setTimeout` の呼び出しを poll | `mockImplementation` で、ms===`SYNC_BEFORE_COMMAND_TIMEOUT_MS` の callback を deferred に渡し、ほかは本物に流す（`bench.test.ts:149` の形） |
| `packages/task/src/run-claude.test.ts:344`・`:347` `Bun.sleep(5)` | Agent Session の時刻に差を付ける | `setSystemTime(t0)` → hook → `setSystemTime(t0 + 1000)` → … → 最後に `setSystemTime()` |
| `crates/ptyd/tests/daemon.rs:197` `thread::sleep(2500ms)` | shell が daemon の socket の確認（2 秒ごと）を 1 回越えて生き残ること | 間隔を env で変えられるようにすれば縮むが、テストのためだけの seam になる。binary の中は並列なので、壁時計への効きは 1〜2 秒。残してよい |

### 負の待ち（しばらく待ってから、何も起きなかったことを確かめる）

| 場所 | 確かめていること | 扱い |
|---|---|---|
| `packages/workbench/src/workbench.test.ts:238` `Bun.sleep(100)` | 2 本目の接続ができないこと | `start()` は最初の `ready()` の promise を待つ。`onClose` の `!wasConnected` を外す変異なら、`start()` が返った時点で 2 本目が既に繋がっているはずなので、sleep を消しても捕まえる力は落ちない見込み。消す前に、その変異で落ちることを確かめる |
| `packages/task/src/list.test.ts:118` `Bun.sleep(20)` | `start()` が sync を起こさないこと | 後の op を barrier にしようにも、同じ Task の sync は 1 本に合流するので隠れてしまう。20ms と安いので残す |
| `packages/note/src/link-metadata.test.ts:245` `Bun.sleep(50)` | body を読んでいる途中で打ち切られること | header を止める `/late` では意味が無いので、helper を分けて sleep を外す。body が止まる場合は client 側に届いた印が取れないので残す |

### テストごとの timeout の引き上げ

- `apps/backend/src/main.test.ts` の 9 本の `}, 20_000)`: 各テストは 0.2〜0.6 秒で、通ったときの時間には効かない。引き上げが要るのは、負荷の下で `bun main.ts` の起動が 5 秒を越えたときだけ。Backend の起動を 1 file で 1 回にまとめれば、要らなくなるか確かめられる。まとめないなら、file の先頭の `setDefaultTimeout(20_000)` 1 行に寄せる。
- `packages/task/src/ui/close-bench.test.ts:112` の 20 秒: 上の「準備を ghq の hold で止める」に替えれば要らなくなる。
- `packages/workbench/src/tab-env.test.ts:26` の `Bun.spawn(…, { timeout: 5000 })`: 本番が書く wrapper の初回 exec を待つ。home を共有すれば初回が 1 回になる。
- bunfig.toml は repo に無く、`--timeout` も渡していないので、既定の 5 秒のまま（https://bun.com/docs/test/runtime-behavior 、「Each test has a default timeout of 5000ms」）。
- `docs/packages/dev-loop.md:77` は、第 3 引数を 20 秒にしたテストとして `close-bench.test.ts`・`bench.test.ts`・`tab-env.test.ts`・`scripts/native-host.test.ts` を挙げている。今そうなっているのは `close-bench.test.ts` だけで、文書が実態とずれている。

## 6. 使える bun test と cargo のオプション

| オプション | 中身 | 出典 |
|---|---|---|
| `--parallel=N` | test file を N 個の worker process に配る。`--isolate` を含む | `bun test --help`（1.4.2）、https://bun.com/docs/test/parallel |
| `--timings=<file>` / `--update-timings` | file ごとの ms を JSON（`{ "version": 1, "files": { path: ms } }`）に書き、次からは各 worker が遅い file から始める。`--shard` も時間で分ける | 同上。形は空の `{}` を渡したときのエラーで確かめた |
| `--no-isolate` | `--parallel` の worker が global と module を file をまたいで使い回す。速いが、残り物が見える | 同上 |
| `--shard=i/n` | file を n 個に分ける | 同上 |
| `--timeout=<ms>`、test の第 3 引数 | 既定は 5000ms。`0` か `Infinity` で無効 | https://bun.com/docs/test/runtime-behavior |
| `--concurrent`、`--max-concurrency` | 1 つの file の中のテストを並行に流す（既定 20） | `bun test --help`。この repo のテストは module の state と spy を共有するので、そのままでは使えない |
| `--reporter=junit --reporter-outfile=` | test ごとの時間を XML に出す | `bun test --help`、https://bun.com/docs/test/reporters |
| `setSystemTime`、`jest.useFakeTimers` | 時刻を固定する（`Date.now`、`new Date()`、`Intl.DateTimeFormat`）。fake timers が `setTimeout` や `Bun.sleep` をどこまで止めるかは文書に無い。この repo は全部止まると確かめている（`docs/packages.md:148`） | https://bun.com/docs/test/dates-times |
| bunfig の `[test]` | `parallel` は文書の key に無く、`scripts/test.ts:8` のコメントのとおり黙って無視される | https://bun.com/docs/test/configuration |
| `cargo test -- --test-threads=N` | binary の中の thread 数。binary どうしは直列で、`-j` は build にだけ効く | https://doc.rust-lang.org/cargo/commands/cargo-test.html |

## 既に済んでいる改善（二重に提案しないもの）

- #306（#301・#250）: `bun test --parallel=8`。偽の実行 file を repo の 1 つへの symlink にして、初回 exec の検査を減らした。直列 104 秒が 17〜20 秒になった。
- #304（#253）: sidebar の Tile の規則のテストを、git を使わない `assignTiles` と `buildSidebar` のテストに移した。`ghqCheckout` を使うテストが 17 本から 8 本になった。
- #305（#252）: issue で消すテストを、行番号ではなく test の名前で挙げる規則を足した（この文書もそれに従う）。
- 時間の打ち切りを `setTimeout` の spy で手で起こす規約は、すでに多くのテストが従っている（`docs/packages.md:146-148`、`save-queue.test.ts`、`reach.test.ts`、`read-page.test.ts`、`pdf.test.ts`、`snapshot.test.ts` など）。
