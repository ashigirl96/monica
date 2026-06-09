# Workboard v0 UI Design

Workboard v0は、Taskを整理するKanbanでありながら、TaskRunとWorkbench Runspaceの状態も同じ画面で扱うためのagent-aware boardである。

目的は「何をやるか」と「いま何が動いているか」を分離しすぎないこと。Taskは作業対象、TaskRunは実行の試行、Runspaceはその試行を観察・介入するためのWorkbench上の場所として扱う。

## Core Idea

```text
Workboard = Task Kanban
          + Active Run Shelf
          + Workbench Runspace entry points
```

WorkboardはTask/TaskRun/Runspaceを所有しない。Monicaの中核objectを、実行状態がわかる形で見るviewである。

- Task cardはTaskを主役にする。
- TaskRunはcard内のlatest run stripとActive Run Shelfで見せる。
- RunspaceはWorkbenchへの接続先として表示する。
- DisplayStatusはBoard表示の入力にするが、列名は人間向けに折りたたむ。

## Layout

Workboard v0はsidebarなしの1画面構成にする。

```text
┌───────────────────────────────────────────────────────────────┐
│ Header                                                        │
│ [Track Issue] [Project] [Search] [View options]               │
├───────────────────────────────────────────────────────────────┤
│ Active Run Shelf                                              │
│ MON-42 running · monica · Open Bench                          │
│ MON-51 needs you · ExitPlanMode · Reply                       │
├───────────────────────────────────────────────────────────────┤
│ Inbox     Ready     Running     Needs You     Interrupted Done│
│ [cards]   [cards]   [cards]     [cards]       [cards]     ... │
└───────────────────────────────────────────────────────────────┘
```

Headerは作業開始の導線を置く場所にする。v0で最も重要なのは`Track Issue`、project filter、searchである。

Active Run Shelfは、実行中またはユーザーの反応待ちのTaskRunだけを横並びで表示する。Kanban上のcardとは別に、現在動いているものを常に見える位置に置く。

## Columns

Board列はDisplayStatusをそのまま出さず、まず以下に折りたたむ。

```text
Inbox       = inbox
Ready       = ready
Running     = in_progress / setting_up / running
Needs You   = waiting_for_user
Interrupted = stopped / failed
Done        = done
```

この折りたたみにより、Boardは実装状態一覧ではなく、人間が次に判断すべき作業面として読める。

`setting_up`や`failed`などの細かい状態は、columnではなくcard badge / latest run strip / Active Run Shelfに出す。

## Task Card

Task cardは情報量を絞り、次の順序で読む。

```text
MON-42  Workboard / Workbench bridge
monica · GitHub #188 · branch issue-188

Run: running · run-31
Workbench: bound · active
PR: draft #201

[Open Bench] [Issue] [PR]
```

必須要素:

- Task id
- Title
- Project or repo
- GitHub issue badge when linked
- latest TaskRun status when present
- Runspace bound/unbound indicator
- primary action

TaskRunがないcardでは、latest run stripを`Ready to run`として扱う。TaskRunがあるcardでは、run id、run status、wait reason、branch、PR状態を優先して見せる。

## Active Run Shelf

Active Run Shelfは「いまMonicaが走らせているもの」を見る場所である。

表示対象:

- `setting_up`
- `running`
- `waiting_for_user`

各itemの主情報:

```text
MON-42 · running · run-31 · monica
branch issue-188 · Open Bench
```

`waiting_for_user`の場合は、`Needs You`として強く表示し、可能なら`Reply` / `Approve` / `Open Bench`を直接出す。

このshelfはKanbanの重複ではなく、global execution monitorである。複数Taskを連続でRunしても、Board上で実行中の全体像を失わない。

## Workbench Connection

Workboardから実行されたTaskRunは、原則として1つのRunspaceに対応する。

```text
Task MON-42
  latest TaskRun run-31
    Workbench Runspace rs-abc
```

WorkbenchのRunspace railでは、Task-bound Runspaceを上部groupに置く。

```text
Task Runs
MON-42  running
MON-51  needs you

Shells
main
scratch
```

`Run & Open`はRunspaceを作成してWorkbenchへ移動し、そのRunspaceをactiveにする。

`Run in Background`はRunspaceを作成するが、Workbenchへ移動せず、Active Run Shelfに表示する。

`Open Bench`は既存の対応RunspaceをactiveにしてWorkbenchへ移動する。Workbench側には`Back to Board`導線を置き、戻ったときに該当cardをハイライトできるとよい。

## Track Issue Flow

Workboard headerの`Track Issue`からGitHub Issueを取り込む。

```text
1. User clicks Track Issue
2. Paste owner/repo#123 or GitHub issue URL
3. Monica fetches issue
4. Preview title / repo / issue number
5. User chooses:
   - Track only
   - Track & Run
   - Track & Run & Open Bench
6. Task appears on Workboard
```

v0ではsidebarを作らず、modalまたはcommand panelで完結させる。

## Interaction Principles

- Board上の主操作は`Run`、`Run & Open`、`Open Bench`、`Track Issue`に絞る。
- 実行中の詳細操作はWorkbenchに寄せる。
- ユーザーの判断が必要なものは`Needs You`としてBoard上で目立たせる。
- WorkboardとWorkbenchは別画面だが、同じTask/TaskRunを見ている感覚を保つ。
- Runspaceはterminal tabではなく、TaskRunを観察・介入する場所として見せる。

## v0 Non-goals

- Workboard sidebar
- 複数Board view
- drag-and-dropによるstatus変更
- full review UI
- file diff/editor/test resultのBoard内表示
- TaskRun lineageの複雑な表現

v0では、Task一覧、実行状態、Workbench接続が気持ちよく成立することを優先する。
