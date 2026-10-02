---
status: accepted
---

# agent 状態の正本は Agent Session だけにし、task が Run と Bench の対応を所有し、workbench は Task を知らない

monica は hook を受けるたびに agent の状態を TaskRun と TerminalSession の両方へ書き、TaskRun と tab の対応も env（`MONICA_TASK_ID`）経路と tab binding 経路の 2 本立てだった。TaskRun は worktree の準備（`SettingUp / Prepared`、branch、worktree_path）と agent の生死（`Running / WaitingForUser / Stopped`）を 1 つの状態機械に混ぜ、その上に Main Run の選定と side run の区別が載っていた。tania では agent の状態（動作中 / ユーザー待ちとその理由 / 終了）の正本を `workbench` の Agent Session だけに置き、Task に紐づかない Tab でも同じ仕組みで観測する。`task` は Agent Session への対応として Run を、Runspace への対応として Bench を所有し、どちらも agent の状態を持たない。`workbench` は Task を一切参照しない。

## Considered Options

- **TaskRun に状態を残す**（monica 踏襲）: 二重化を解くには tab 側の表示を Run から逆引きすることになり、Task に紐づかない Tab の agent が観測できなくなる。
- **Agent Session や Runspace に `task_id` を持たせる**: 概念は 1 つ減るが、依存が `workbench → task` に向き、Workbench が Task 無しで成立しなくなる。`task` が Workbench の id を参照する向きなら、Workbench は端末として閉じたまま、その上に Task を載せられる。
- **第 3 の概念（agent observation）を新設して両方から参照する**: 正本が 1 つになる点は同じだが、既にある Agent Session と役割が重なる。

## Consequences

- Agent Session の同一性は agent の session_id。resume と compact は同じ Agent Session の再開で Run は増えず、fork は別の Agent Session なので新しい Run になる。
- Run は Bench の Tab で Agent Session が始まった時か Attach した時に生まれ、その Agent Session が終わるまで、Tab がどこに移っても Task に属し続ける。Bench への所属が決めるのは「これから始まる Agent Session を Run にするか」だけ。
- Main Run / side run の区別は無い。Task の表示状態は所属する Run の Agent Session を集約して導き、resume の対象は最新の Run。
- worktree の準備状態（準備中 / 準備済み / 失敗）は Bench が持つ。Bench は最初に開いた時に作られ、cwd は変えず、Task の close で壊れ、reopen で作り直す。
- hook の受け口は env の terminal session id と payload の session_id だけで Agent Session を特定し、Task は Tab → Runspace → Bench で辿る。Task の解決に env の task id は要らない。Attach は「Tab を Bench の Runspace に移す」1 操作になる。
- Task 自身が保存する状態は open / closed だけ。着手済みか、ユーザー待ちか、片付け待ちかは Run / Agent Session / Bench / Issue からの導出で、Work Board の列もすべて導出で作る。
