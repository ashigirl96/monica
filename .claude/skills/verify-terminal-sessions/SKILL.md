---
name: verify-terminal-sessions
description: Workbench の帳簿（Terminal Session の行と Tab）と monica-ptyd の shell がずれないことを、TLA+ の model で起こりうる順序をすべて確かめる。workbench の reconcile、Tab の開閉と pin の張り直し、ptyd への接続と繋ぎ直し、Create と Terminate の送り方、ptyd の dispatch と Exit の配り方を変えるときに使う。
---

`TerminalSessions.tla` は、Backend・ptyd・接続の切断・Backend と ptyd の死・transaction の rollback が、どの順で来ても次の規則が成り立つかを TLC で総当たりにする。test は誰かが書いた順しか見ないので、順序に関わる変更はここで確かめる。

## 規則

「落ち着いた」は、Backend が ptyd に繋がっていて、送りかけの要求も届きかけの答えも ready() を待つ処理も無い状態（spec の `Settled`）。

| 規則 | 成り立つこと | 破れたときの害 |
|---|---|---|
| `NoHiddenShell` | 落ち着いたとき、ptyd が動かす shell はどれも、行が live な Tab に表示されている | 誰にも見えない claude が動き続ける。pin した Tab に shell が 2 つ起きる。task の close が動いている claude の下で worktree を消す |
| `NoDeadTab` | 落ち着いたとき、live（starting・running）な行の shell は ptyd で動いている | Tab が死んだ端末を動いていると見せ続け、attach が失敗する |
| `LostOnlyWhenLost` | 行が lost になるのは、shell が ptyd ごと死んだか、Create が捨てられたか断られた答えを Backend が聞けなかったときだけ | ptyd の繋ぎ直し中に開いた Tab が、何も壊れていないのに lost と出る |
| `EndedStaysEnded` | exited・lost・failed の行は live に戻らない | 終わった Tab が running に戻り、shell の無い端末を見せる |

## 対象のコード

spec がどの版のコードを表すかは、`covered-files.txt`（下の表の file の中身の hash）が記録する。最後に確かめた commit は、この file を最後に変えた commit で、`git log -1 --format=%h -- .claude/skills/verify-terminal-sessions/covered-files.txt` で引く。squash merge で PR の commit が消えても、main の commit が残る。

| file | 関数 | spec の action・operator |
|---|---|---|
| `packages/workbench/src/terminal-session.ts` | `start`・`rebind` | `StartIn`（`OpenTab`・`RespawnTab`・`SettleSlot`） |
| 同 | `create`・`startingRow`・`createNotSent` | `Flush`、`Receive` の reply、`BackendSeesClose` |
| 同 | `terminateRemoved`・`sendTerminate` | `RemoveTabIn`、`Flush`、`BackendSeesClose` |
| 同 | `recordExit` | `RecordExitIn` |
| 同 | `reconcile` | `Reconcile` |
| `packages/workbench/src/workbench.ts` | `connect`・`onExit`・`onClose`・`ready`・`exitsDuringReconcile` | `Connect`・`HelloDone`・`Receive`・`BackendSeesClose`・`Replay`・`MustFlush` |
| `packages/workbench/src/ptyd.ts` | `PtydClient`（`request`・`shutdown`・`outcome`）・`openDaemon` | `Send`・`BackendSeesClose`・`HelloDone` |
| `packages/workbench/src/layout.ts` | `openTab`・`closeTab`・`removeTab`・`dropRunspace`・`respawnTab`・`settleEndedTabs` | `OpenTab`・`OpenTabRolledBack`・`CloseTab`・`RespawnTab`・`Settle` |
| `packages/workbench/src/pin.ts` | `shouldRespawn` | `SettleSlot`（exited と lost では常に張り直すと置く） |
| `crates/terminal-daemon/src/daemon/connection.rs` | `serve_connection`・`dispatch` | `PtydServe`・`PtydReplies`・`PtydDropsConn` |
| `crates/terminal-daemon/src/daemon/state.rs` | `create`・`terminate`・`list`・`reap`・`on_exit` | `PtydServe`・`ShellExits` |

変更がこの表に触れるかは、上で引いた commit からの `git diff --stat <commit> -- <上の file>` で見る。触れていれば、関数の中身を spec の対応する action と読み比べる。

## 流す

repo の root で:

```sh
sh .claude/skills/verify-terminal-sessions/check.sh
```

TLC 1.7.4 と Java（Temurin 25）を mise で版を固定して入れる（初回だけ network が要る）。本体の model を確かめた後、壊れた版（spec の `Mutant`）を 6 つ流し、それぞれが名指しの規則を破ることを確かめる。全体で 1 分ほど。exit 0 で次の 3 つが揃う:

- `model: every rule holds (<数> distinct states found)`
- `mutant <名前>: breaks <規則> as it must` が 6 行
- `in step: every covered file matches covered-files.txt`

spec は手で写した model で、コードを読まない。そこで最後に、上の表の file の今の中身（未 commit の変更を含む）を `covered-files.txt` と比べる。違えば、その file を挙げて exit 3 で止まる。exit 3 の pass は、変わった file を spec と読み比べるまでコードの確認にならない。exit 1 は規則か mutant が破れた。CI の `tla` の job が、PR と main への push のたびにこの command を流す。

## 結果を読む

TLC の結果は、通ったときも破れたときも pstack の `/statechart` で読む。spec は `TerminalSessions.tla`、config は `TerminalSessions.cfg`（mutant なら `Mutant` を書き換えた写し）、view は `view.ts` を渡す。この model は chart の上限を超えるので、`/statechart` は破れた規則ごとに最短の道を、Tab と Backend の言葉の歩みで返す。

破れた道は、本物の bug か model の誤りかを次で分ける:

1. 道の各歩を、上の表で対応する関数に引き直し、その順が本物のコードで起きるかを読む。Bun の event loop では、同じ promise を待つ処理は登録順に動き、microtask の間に I/O は割り込まない（`MustFlush`）。ptyd は接続ごとに 1 本の thread で要求を順に処理し、答えは lock の外で積む（`PtydReplies`）。
2. 下の「置いた前提」に反する歩があれば model の誤り。spec を本物のコードに合わせて直し、規則は変えない。
3. どの歩もコードで起きるなら本物の bug。道を Tab・Terminal Session・ptyd の言葉で数歩に書いてユーザーに伝える。product code は頼まれたときだけ直す。

`mutant <名前>: did NOT break` が出たら、その mutant が壊す guard を model が見なくなっている。直前の spec の変更が、その guard の要る順序を消していないかを確かめる。

## 意図した変更に model を合わせる

1. 変えた関数の振る舞いを、表で対応する action に写す。新しい guard を足したなら、それを外す mutant を `Mutants` と `check.sh` の一覧に足す。
2. `check.sh` を流し、exit 3 の他は上の 3 行が揃うまで直す。
3. 変わった file をすべて spec と読み比べ、spec が今のコードを表すと確かめてから、`sh .claude/skills/verify-terminal-sessions/check.sh --confirm` で `covered-files.txt` を書き直し、同じ PR に入れる。読み比べていない file の hash は書き込まない。表に file を足し引きしたときも同じ。

## 範囲

確かめた範囲: Terminal Session の id は 3 つまで、Tab は pin した 1 つと pin していない 1 つ、ptyd の接続断・Backend の再起動・ptyd の死はそれぞれ 1 回まで。この範囲のすべての順序で 4 つの規則が成り立つ。範囲の外（Tab が 3 つ以上、断が 2 回以上）は確かめていない。

置いた前提:

- Backend が死んだ後、ptyd は古い接続に残った要求を、新しい Backend が繋ぐ前に処理し終える（Backend の起動は ptyd の 1 要求よりずっと遅い）。
- ptyd 側から接続が切れると、読んでいない要求と送っていない答えは捨てられる（`PtydDropsConn`）。
- SQLite の transaction は同期で、commit か rollback の後に microtask が動く（ADR-0015）。
- Terminate の SIGHUP で shell はやがて終わる（ADR-0023）。

model に入っていないもの: Run の `input`（`claude\r`）の Write、Agent Session と hook、Tab の move と pin の付け外し、`dropRunspace` の `spare`、`processes`、`stop()`、`shouldRespawn` の 2 秒の下限（常に張り直すと置いた）、Tab を閉じる transaction の rollback、DB を消した後に ptyd にだけ残る session。規則は安全性だけで、「いつかは落ち着く」（liveness）は確かめていない。
