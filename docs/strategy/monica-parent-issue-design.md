# Parent Issue: Monica 3 Spaces — Intent-to-Run Agentic Workspace 設計

## 概要

このissueは、Monicaを現在の「GitHub Issue Runner / Status Dashboard」から、以下の3つの主要Spaceを持つ **Personal Agentic Workspace** へ拡張するための親issueである。

```text
Project Home
  = Projectの文脈、Intent、ドキュメント、Project Agentとの会話を扱う場所

Work Board
  = Task、Run、Review、PR、Agent状態を管理する場所

Workbench
  = Runspace / Worktree / Terminal / Agent session / Diff / Editor / Logs に入り、観察・介入する場所
```

Monicaの中心はGitHub Issueではなく **Intent** である。GitHub Issueは重要な外部参照だが、Monica内部では `Intent → Task → Task Run → Worktree / Agent Session / PR / Knowledge` の流れを第一級のモデルとして扱う。

この設計の目的は、以下の体験をひとつのアプリケーション内で自然につなげることである。

```text
Projectについて考える
→ Intentを作る
→ Taskに変換する
→ 必要ならGitHub Issueを作成/紐づける
→ Runを開始する
→ Worktreeが作成される
→ Claude CodeなどのAgentが実行される
→ WorkbenchにRunspaceが追加される
→ Terminal / Logs / Diff / Editorで観察・介入する
→ Reviewする
→ PRにする
→ Doneにする
→ Project memory / docs / knowledgeに反映する
```

---

## 1. 背景

現在のMonicaは、GitHub Issueを起点にして、Monica Taskを作り、Project Registryに基づいてworktreeを作成し、setup scriptを実行し、Claude Codeを起動し、hook/event logを通じてStatus Dashboardに状態を表示するところまで進んでいる。

現状の基本フローは以下である。

```text
GitHub Issue
  → Monica Task
  → Project Registry
  → Worktree
  → Setup Script
  → Claude Code Run
  → Hook / Event Log
  → Status Dashboard
```

この流れはIssue Runnerとしては有効だが、実際の作業では以下の不便が出ている。

- GitHub IssueをCLIからtrackするのが面倒。
- GitHub Issueがない状態から、新しくissueを作成し、trackし、runする操作が多い。
- Projectについて考える会話と、Task/Run/Terminalが分断されている。
- Terminal上のClaude Code session、worktree、PR、Task状態を人間が手で結び直している。
- Projectの仕様、memory、docs、issue、task、running sessionが別々の場所に散らばっている。

この問題の本質は、現在のMonicaがまだ **Issue-first** に近い一方で、実際の思考と作業は **Intent-first** に進んでいることにある。

Monicaの最終像では、曖昧な「やりたい」「気になる」「直したい」「調べたい」を受け取り、それをNote、Research、Proposal、Task、Agent Plan、Claude Code Session、PR、Knowledgeへ変換していく。

この親issueでは、そのためのUI/UX、オブジェクトモデル、Agent orchestration、Workbench/ADE、Knowledge連携をまとめて設計する。

---

## 2. 設計方針

### 2.1 Intent-first

Monicaの主語はGitHub Issueではない。

GitHub Issueは重要な入力元・同期先・外部参照だが、Monica内部では以下の流れを主にする。

```text
Intent
  → Task
    → Task Run
      → Worktree
      → Agent Session
      → Terminal Session
      → Diff
      → PR
      → Review
      → Knowledge
```

GitHub Issueが最初に存在する場合は、`External Ref` としてTaskに紐づける。GitHub Issueが存在しない場合は、Monica内でTaskを先に作り、必要に応じてGitHub Issueを後から作成する。

### 2.2 Spaceは「所有者」ではなく「View」

Project Home、Work Board、Workbenchは画面単位のSpaceである。

ただし、Spaceがデータを所有するわけではない。

```text
良くない考え方:
  Project HomeがIntentを所有する
  Work BoardがTaskを所有する
  WorkbenchがRunを所有する

望ましい考え方:
  Intent / Task / Run / Worktree / PR / Note はMonicaの中核object
  Spaceはそれらを見るためのview
```

この方針により、同じTaskをProject HomeのContext Rail、Work BoardのCard、WorkbenchのRunspace、Object Drawerから一貫して扱える。

### 2.3 Project AgentとTask Agentを分ける

Monicaには少なくとも2種類のAgentが存在する。

```text
Project Agent
  - Project全体を司る
  - main branch / docs / memory / issues / tasks / PR / sources を見る
  - userと会話してIntentを整理する
  - TaskやIssueのdraftを作る
  - Taskの優先度や分解を支援する
  - Action-to-Knowledgeを支援する

Task Agent
  - 特定のTask Runに紐づく
  - 特定のworktree / branch / prompt / logs を持つ
  - Claude Codeなどを実行する
  - 実装、調査、テスト、PR準備を行う
```

Project Agentは特定のworktreeに閉じない。したがって本籍地はProject Homeに置く。ただし、Workbench作業中にsidecar/tabとして呼び出せるようにする。

### 2.4 WorkbenchはTerminalではなくAgent-aware ADE

Terminalは必要だが、Monicaが作るべきものは単なるterminal emulatorではない。

Workbenchは、以下をまとめるAgent Development Environmentである。

```text
Task Run
  ├─ Worktree
  ├─ Agent Session
  ├─ Terminal
  ├─ Logs
  ├─ Diff
  ├─ Editor
  ├─ Test Result
  ├─ PR
  ├─ Notes
  └─ Agent Summary
```

画面名としては `Terminal Space` ではなく **Workbench** を採用する。

Workbench内の縦タブ単位は `Runspace` と呼ぶ。

```text
Workbench
  ├─ Runspace A: MON-12 / issue-123 / worktree A
  ├─ Runspace B: MON-13 / mon-13 / worktree B
  └─ Runspace C: main / project shell
```

体感としては `1 Runspace ≒ 1 worktree` でよいが、内部的にはRunspaceはUI containerであり、worktreeそのものではない。

### 2.5 Human-in-the-loop

Monicaは全自動化ツールではない。

エージェントに任せるが、人間が必要なところで判断・介入・レビューできることを第一級にする。

必要な状態は以下である。

```text
Running
Need Approval
Need Intervention
Review
Done
```

- Running: Agentが進行中。
- Need Approval: Agentがユーザーの承認を待っている。
- Need Intervention: Agentが詰まった、誤解している、手動介入が必要。
- Review: Agentの出力を人間が確認する。
- Done: 成果物が閉じ、必要な知識が反映された。

### 2.6 Keyboard-native

すべての主要操作はkeyboardで完結できるようにする。

```text
cmd/ctrl+k  Command Palette
/           Search
j/k         Move selection
enter       Open
esc         Close / Back
space       Toggle selection / Preview
c           Create
r           Run / Review depending on context
a           Agent action
m           Move status
n           New note

Navigation:
g h         Project Home
g b         Work Board
g w         Workbench
g i         Inbox
g d         Docs / Library
g r         Repos
```

Keybindingは後から変更可能にするが、設計上はkeyboard-firstを前提にする。

---

## 3. 推奨命名

### 3.1 Top-level Spaces

| 役割                                            | 採用名           | 補足                                        |
| ----------------------------------------------- | ---------------- | ------------------------------------------- |
| Project文脈、Intent、Project Agent、docs        | **Project Home** | Projectの入口。Dashboardより広い概念。      |
| Task、Run、Review、PR状態管理                   | **Work Board**   | 単なるTask Boardではなく、agent状態も扱う。 |
| Terminal、worktree、agent session、diff、editor | **Workbench**    | Terminal Spaceより広いAgent-aware ADE。     |

### 3.2 内部概念

| 概念                          | 採用名            | 補足                                 |
| ----------------------------- | ----------------- | ------------------------------------ |
| Workbench内の縦タブ/作業空間  | **Runspace**      | 通常はTask Run / Worktreeに紐づく。  |
| Project全体の司りエージェント | **Project Agent** | Project Homeが本籍地。               |
| Task Runに紐づく実行Agent     | **Task Agent**    | Claude Codeなど。                    |
| まだTaskではない意図          | **Intent**        | Capture, triage, promoteされる。     |
| 実行可能な作業単位            | **Task**          | GitHub Issueがあってもなくてもよい。 |
| Taskの実行インスタンス        | **Task Run**      | continue/forkを含む。                |
| GitHub Issue/PR/Slack/URLなど | **External Ref**  | Monica objectへの外部参照。          |

### 3.3 操作名

| 操作                             | 推奨名            | 説明                               |
| -------------------------------- | ----------------- | ---------------------------------- |
| 曖昧な入力を保存                 | Capture Intent    | まだTaskではない。                 |
| IntentをTaskに変換               | Promote to Task   | trackとは分ける。                  |
| 既存GitHub IssueをTaskへ取り込む | Track Issue       | 現CLIとの互換。                    |
| TaskにGitHub Issueを作成         | Create Issue      | external_refとして保存。           |
| Taskと既存Issueを結びつける      | Link Issue        | external_ref追加。                 |
| Taskの実行開始                   | Start Run         | RunはTaskの実行インスタンス。      |
| 実行開始してWorkbenchを開く      | Run & Open        | Workbenchへ遷移。                  |
| 実行だけ開始                     | Run in Background | Boardに残る。                      |
| Agent sessionを継続              | Continue Run      | 同一runまたは新しいrun attempt。   |
| Agent sessionを分岐              | Fork Run          | 新しいrun attempt/runspaceを作る。 |

---

## 4. 中核オブジェクトモデル

### 4.1 全体関係

```text
Project
  ├─ Project Agent
  ├─ Project Home State
  ├─ Project Memory
  ├─ Documents
  ├─ Sources
  ├─ Intents
  │    └─ Task
  │         ├─ External Ref: GitHub Issue
  │         ├─ Task Runs
  │         │    ├─ Worktree
  │         │    ├─ Agent Sessions
  │         │    ├─ Terminal Sessions
  │         │    ├─ Runspace
  │         │    ├─ Events
  │         │    ├─ Run Outputs
  │         │    ├─ Diff Snapshots
  │         │    ├─ Test Results
  │         │    └─ Reviews
  │         └─ External Ref: GitHub PR
  └─ Knowledge Pages
```

### 4.2 Project

ProjectはMonica内の最上位の作業文脈である。

Projectは必ずしも1 GitHub repoに限定しない。最初はrepo単位でよいが、将来的には以下を含められるようにする。

- 単一repo project
- multi-repo project
- 学習project
- 調査project
- 個人目標project
- 開発以外のproject

Project fields:

```text
id
name
slug
description
kind: development | research | learning | personal | misc
primary_repo_id?
default_branch?
local_path?
created_at
updated_at
archived_at?
```

### 4.3 Intent

Intentは、まだ実行可能なTaskとは限らない入力である。

例:

- 「Project HomeのUIを整理したい」
- 「このバグが気になる」
- 「このrepoを後で読んで、Monicaに使えるか調べたい」
- 「Slackで依頼された内容を整理したい」
- 「この設計判断をdocsに残したい」

Intent fields:

```text
id
project_id?
title
body
kind: idea | bug | question | note | research | task_candidate | source_candidate
status: captured | triaging | promoted | dismissed | archived
source_refs[]
created_from: chat | manual | slack | web | github | terminal | command
created_by: user | project_agent | intake_agent
confidence?
priority?
tags[]
created_at
updated_at
promoted_task_id?
```

IntentはTaskになることもあれば、Note、Source、Research、Proposalになることもある。

```text
Intent
  → Task
  → Note
  → Source
  → Research
  → Proposal
  → Document update
  → Dismissed
```

### 4.4 Task

Taskは実行可能な作業単位である。

GitHub Issueが存在してもよいし、存在しなくてもよい。Monica内部ではTaskを第一級にする。

Task fields:

```text
id
monica_id: MON-123
project_id
title
body
status: inbox | backlog | ready | planning | running | need_approval | need_intervention | review | done | archived
priority: none | low | medium | high | urgent
kind: implementation | bugfix | research | docs | refactor | chore | learning | investigation
source_intent_id?
assignee: user | agent | mixed
created_at
updated_at
completed_at?
archived_at?
```

Task relations:

```text
Task
  has many ExternalRefs
  has many TaskRuns
  has many Reviews
  has many Notes
  has many Run Outputs
  may originate from Intent
  may update Knowledge
```

### 4.5 External Ref

External Refは、Monica objectと外部システムを結ぶ参照である。

Examples:

```text
GitHub Issue
GitHub PR
GitHub Repo
Slack thread
Web URL
RSS item
Local file
Obsidian note
```

Fields:

```text
id
object_type: intent | task | run | project | note | source | review
object_id
provider: github | slack | web | local | rss | obsidian | other
kind: issue | pull_request | repo | thread | url | file | article
external_id
url
title?
metadata_json
created_at
updated_at
```

### 4.6 Task Run

Task RunはTaskの実行インスタンスである。

1 Taskに対して複数Runがあり得る。

- 初回run
- continue
- fork
- retry
- alternative approach
- review fix run

Fields:

```text
id
task_id
project_id
run_number
status: queued | setting_up | running | waiting_for_user | stopped | failed | completed | review_ready | cancelled
phase: prepare | setup | agent_running | waiting | testing | summarizing | reviewing | done
branch_name
worktree_id?
agent_session_id?
runspace_id?
started_at?
stopped_at?
completed_at?
exit_code?
failure_reason?
created_at
updated_at
```

### 4.7 Worktree

WorktreeはGitの作業ディレクトリである。

Fields:

```text
id
project_id
repo_id
task_id?
run_id?
path
branch
base_branch
status: creating | ready | dirty | removed | failed
created_at
updated_at
removed_at?
```

worktreeはRunに紐づくのが基本だが、main branch用のshellや調査用workspaceなど、Task Runなしのworktree/working directoryも扱えるようにする。

### 4.8 Agent Session

Agent SessionはClaude CodeなどのAgent実行単位である。

Fields:

```text
id
run_id
project_id
task_id
agent_kind: claude_code | codex | custom | shell_agent
provider_session_id?
status: starting | running | waiting_for_user | stopped | failed | completed
prompt_path?
settings_path?
transcript_path?
last_event_at?
created_at
updated_at
```

### 4.9 Terminal Session

Terminal SessionはPTY/xterm.jsと接続するshell/commandのセッションである。

Fields:

```text
id
project_id
run_id?
worktree_id?
runspace_id?
tab_id?
cwd
env_json
shell
status: starting | active | detached | exited | failed
started_at
ended_at?
exit_code?
created_at
updated_at
```

### 4.10 Runspace

RunspaceはWorkbench内の縦タブに相当するUI workspaceである。

Runspaceは通常Task Runに紐づくが、完全には固定しない。

Fields:

```text
id
project_id
run_id?
task_id?
worktree_id?
name
kind: task_run | project_shell | review | scratch | agent_session
status: active | inactive | archived
sort_order
last_active_tab_id?
layout_json
created_at
updated_at
```

Runspace Tab fields:

```text
id
runspace_id
kind: agent | shell | logs | diff | editor | notes | review | project_agent | test
name
resource_ref
sort_order
active
created_at
updated_at
```

---

## 5. Information Architecture

### 5.1 Top-level navigation

Monicaのトップレベルは以下のSpaceで構成する。

```text
Project Home
Work Board
Workbench
Inbox        later / optional
Library      later / optional
Settings
```

当面の主軸は3つ。

```text
Project Home → Work Board → Workbench
```

ただし、将来的にはIntakeやKnowledge Baseが育つため、以下も自然に追加される。

```text
Daily Home / Today
Intent Inbox
Library / Wiki
Sources
Repos
```

### 5.2 Global Shell

全Spaceに共通するアプリケーションshellを持つ。

```text
┌─────────────────────────────────────────────────────────────┐
│ Top Bar: current project / search / command palette / status│
├───────────────┬────────────────────────────────────┬────────┤
│ Global Nav    │ Main Space                         │ Drawer │
│ Project Home  │                                    │        │
│ Work Board    │                                    │        │
│ Workbench     │                                    │        │
│ Inbox         │                                    │        │
│ Library       │                                    │        │
└───────────────┴────────────────────────────────────┴────────┘
```

Global shell responsibilities:

- current project selection
- global search
- command palette
- notification / agent state indicator
- background run indicator
- GitHub auth / sync status
- keyboard navigation
- object drawer
- active object context

### 5.3 Object Drawer

Object Drawerは、どのSpaceからでも右側に開ける詳細パネルである。

対象:

```text
Intent Drawer
Task Drawer
Run Drawer
Project Drawer
Issue Drawer
PR Drawer
Review Drawer
Document Drawer
Source Drawer
```

Object Drawerがあることで、Space間を移動しても「今扱っているobject」を保持できる。

例:

```text
Project HomeでIntentを見る
→ Taskにpromote
→ Task Drawerに切り替わる
→ Start Run
→ Run Drawerに切り替わる
→ Open Workbench
```

または:

```text
Work BoardでTaskを選ぶ
→ Drawerで詳細を見る
→ Open Workbench
→ Workbenchでも同じTask Drawerを開いたまま作業する
```

---

## 6. Project Home

### 6.1 役割

Project Homeは、Projectについて考え、Intentを作り、docsやmemoryを見ながら、Project Agentと会話する場所である。

Project Homeは単なるdashboardではない。Project全体の入口であり、Projectに関する「思考・整理・作業化」の中心である。

Project Homeで行うこと:

- Project Agentと会話する
- 仕様、バグ、改善案、調査案を話す
- Intentを作る
- IntentをTaskに変換する
- GitHub Issueを作成/紐づける
- TaskをRunする
- Project docsを作る/更新する
- Memory Summaryを見る
- Open Issues / Open PR / Running Runsを見る
- 過去のDecisionやNoteを参照する
- Projectの状態を把握する

### 6.2 Layout

推奨layout:

```text
┌────────────────────────────────────────────────────────────────────┐
│ Project: monica                         [Search] [Command Palette] │
├───────────────┬─────────────────────────────────────┬──────────────┤
│ Left Rail     │ Center                              │ Context Rail │
│               │                                     │              │
│ Chats         │ Project Agent Chat                  │ Intents      │
│ Docs          │ or Project Overview                 │ Tasks        │
│ Decisions     │ or Doc Editor                       │ Issues       │
│ Sources       │ or Intent Draft                     │ Runs         │
│ Memory        │                                     │ PRs          │
│               │                                     │ Memory       │
└───────────────┴─────────────────────────────────────┴──────────────┘
```

### 6.3 Left Rail

Left Railは、Project内の文脈を切り替える場所。

Sections:

```text
Project Agent
  - chat history
  - pinned chats
  - recent chats

Docs
  - Overview
  - Architecture
  - Roadmap
  - Decisions
  - Specs
  - Notes

Sources
  - GitHub issues
  - PRs
  - Slack threads
  - Web articles
  - Repos

Memory
  - Memory Summary
  - Decision Log
  - Recent Learnings
```

初期段階では以下だけでもよい。

```text
Chats
Docs
Memory
```

### 6.4 Center

CenterはProject Homeの主作業領域。

Modes:

```text
Project Agent Chat
Project Overview
Document Editor
Intent Composer
Issue Draft
Task Draft
Memory Summary
```

Project Agent Chatが中心だが、チャットだけに限定しない。Project Homeは「Projectに関する作業台」なので、docs editingやintent draftingも同じCenterで扱える。

### 6.5 Context Rail

右側はIssue専用ではなく **Context Rail** にする。

表示対象:

```text
Open Intents
Task Inbox
Ready Tasks
Running Runs
Need Approval
Need Intervention
Open GitHub Issues
Open PRs
Recent Decisions
Memory Highlights
```

Context Railの目的は、会話中のProject Agentに対して、現在のProject状態を常に見えるようにすること。

Project Agent Chatで会話している最中に、右側で関連TaskやIssueが浮き上がる。

### 6.6 Project Agent Chat

Project Agent Chatは、Project全体を司る会話UI。

Project Agentが参照できるもの:

```text
Project metadata
Project docs
Memory Summary
Open Intents
Tasks
Runs
GitHub Issues
GitHub PRs
Recent events
Decision Log
Sources
```

Project Agentの主なaction:

```text
Capture Intent
Create Intent Draft
Promote Intent to Task
Draft GitHub Issue
Create GitHub Issue
Link Existing Issue
Start Run
Summarize Project State
Update Memory Summary
Create / Update Doc
Suggest Task Decomposition
Explain Current Runs
Prepare Review Summary
```

### 6.7 Intent Draft UX

Project Agentとの会話から、Intent Draftを作れるようにする。

Flow:

```text
User: Project Homeの設計を整理したい
Project Agent: Intent Draftを生成
  title
  body
  kind
  project
  source conversation
  suggested next action

User action:
  Save Intent
  Promote to Task
  Create GitHub Issue
  Dismiss
```

Intent Draftはチャット本文に埋め込まれるだけでなく、Context Railにもcardとして表示する。

### 6.8 Promote to Task UX

IntentをTaskに変換する。

Promote画面で選ぶ項目:

```text
Project
Task title
Task body
Kind
Priority
Target repo
GitHub Issue:
  - Do not create
  - Create new issue
  - Link existing issue
Start behavior:
  - Do not run yet
  - Run in background
  - Run & Open Workbench
```

`Promote to Task` と `Create Issue` と `Start Run` は分ける。

ただし、ユーザー操作としては一括でできる。

```text
Promote → Create Issue → Start Run
```

### 6.9 Project Documents

Project HomeにはProjectに紐づくdocsを持つ。

Docs examples:

```text
Overview
Architecture
Roadmap
Open Questions
Decisions
Runbook
Prompting Guide
Coding Conventions
```

DocsはMonica DB内に保存してもよいし、repo内のmarkdownとして保存してもよい。

設計としては両方に対応できるようにする。

```text
Document Storage:
  internal: Monica-managed note/doc
  repo: files under .monica/docs or docs/
  wiki: Knowledge Base markdown page
```

### 6.10 Memory Summary

Memory SummaryはProject AgentがProject文脈を思い出すための圧縮された知識である。

内容:

```text
Project purpose
Current architecture
Important decisions
Known constraints
Active milestones
Recent completed work
Common commands
Testing strategy
Pitfalls
User preferences
```

Memory Summaryは手動編集もできるが、Task完了時やdocs更新時にProject Agentが更新案を出せるようにする。

---

## 7. Work Board

### 7.1 役割

Work Boardは、TaskとAgent実行状態を管理する場所である。

Linear的なKanbanに似ているが、MonicaのBoardは単なる人間用Task管理ではない。

各Taskは以下と紐づく。

```text
Project
Intent
GitHub Issue
Task Run
Worktree
Agent Session
Runspace
PR
Review
Knowledge updates
```

Work Boardで行うこと:

- Task Inboxを見る
- projectでfilterする
- statusでgroupする
- Taskをtriageする
- TaskをReadyにする
- TaskをRunする
- Running状態を見る
- Need Approval / Need Interventionを処理する
- Reviewへ進む
- PRを開く
- Workbenchへ移動する
- TaskをDoneにする

### 7.2 Board Views

Work Boardには複数viewを持たせる。

```text
Kanban View
  Inbox | Backlog | Ready | Planning | Running | Need Approval | Need Intervention | Review | Done

List View
  filter/sort/groupを重視

Project View
  projectごとにgroup

Agent View
  agent stateごとにgroup

Review View
  Review待ちだけを見る
```

最初の主ViewはKanban。

### 7.3 Status Columns

推奨status:

```text
Inbox
Backlog
Ready
Planning
Running
Need Approval
Need Intervention
Review
Done
Archived
```

意味:

```text
Inbox
  Taskにはなったが、まだ整理されていない。

Backlog
  やる可能性はあるが、今ではない。

Ready
  実行可能。Run開始できる。

Planning
  AgentまたはUserが実装計画を作成中。

Running
  Agentが作業中。

Need Approval
  Agentが明示的な承認を待っている。

Need Intervention
  Agentが詰まった、誤解した、失敗した、または人間の介入が必要。

Review
  出力があり、人間の確認待ち。

Done
  完了。

Archived
  非表示/保管。
```

### 7.4 Task Card Anatomy

Task cardに出す情報:

```text
MON-123
Title
Project badge
Kind badge
Priority badge
GitHub Issue #123 badge
Run status badge
Agent status badge
PR badge
Last event / last update
Branch / worktree indicator
Needs user? indicator
```

Example:

```text
MON-42  Project Home layout redesign
monica · implementation · high
GitHub #188 · Run: running · Agent: waiting_for_user
branch: issue-188 · PR: draft
Last: AskUserQuestion 2m ago
```

### 7.5 Task Actions

Card action:

```text
Open
Open Drawer
Start Run
Run & Open
Run in Background
Open Workbench
Open Issue
Create Issue
Link Issue
Open PR
Create PR
Continue
Fork
Stop
Move Status
Archive
Delete
```

### 7.6 Start Run Flow

Work BoardでTaskをRunする。

Flow:

```text
Task cardでRun
→ Start Run modal / quick action
→ Target repo確認
→ Branch name確認
→ Agent選択
→ Prompt確認
→ Setup script確認
→ Start
→ Task Run作成
→ Worktree作成
→ setup.sh実行
→ Agent session起動
→ WorkbenchにRunspace追加
→ Board上ではRunningへ移動
```

Run actions:

```text
Run
  = backgroundで開始。Boardに残る。

Run & Open
  = 開始後Workbenchへ遷移。

Plan
  = 実装計画だけ作る。Planningへ。
```

### 7.7 Running State

Running columnでは、Agentの状態を分かりやすく表示する。

```text
setting_up
running
waiting_for_user
recently_stopped
failed
```

Running cardはlive updateされる。

更新元:

```text
Claude hooks
process status
terminal session events
git diff changes
test result events
PR sync worker
manual status changes
```

### 7.8 Need Approval / Need Intervention

Need Approvalは、Agentが承認を要求している状態。

Examples:

```text
ExitPlanMode approval
AskUserQuestion
dangerous command approval
needs design confirmation
```

Need Interventionは、より広い介入状態。

Examples:

```text
setup.sh failed
agent failed
tests failing repeatedly
session stopped unexpectedly
agent appears stuck
branch conflict
worktree dirty in unexpected way
```

Cardから直接できること:

```text
Open Workbench
View Question
Approve
Reject
Reply
Continue
Fork
Stop
Mark Review
```

### 7.9 Review Column

ReviewはAgentの出力を見る場所。

Review cardに出す情報:

```text
Agent summary
Changed files count
Test result
Risk level
PR status
Remaining questions
```

Review action:

```text
Open Review
Open Diff
Run Tests
Request Changes
Continue Agent
Fork Run
Create PR
Open PR
Mark Done
Update Memory
```

---

## 8. Workbench

### 8.1 役割

Workbenchは、Task Runの中身を観察し、必要に応じて介入する場所である。

WorkbenchはTerminal Spaceではない。Terminalを含むが、中心はTask Run / Worktree / Agent Session / Diff / Logsである。

Workbenchで行うこと:

- Runspaceを開く
- Claude Code sessionを見る
- Shellを操作する
- Logsを見る
- Diffを見る
- Editorで修正する
- Test resultを見る
- Project Agentに相談する
- Task Agentに追加指示する
- PRを作成/確認する
- Reviewへ進める

### 8.2 Layout

推奨layout:

```text
┌────────────────────────────────────────────────────────────────────┐
│ Workbench: monica                                       [Command] │
├──────────────┬─────────────────────────────────────────┬───────────┤
│ Runspace Rail│ Runspace Header                         │ Drawer    │
│              ├─────────────────────────────────────────┤           │
│ MON-42       │ Tabs: Agent | Shell | Logs | Diff | ... │ Task      │
│ MON-43       ├─────────────────────────────────────────┤ Run       │
│ main shell   │ Active tab content                       │ PR        │
│ review PR    │                                         │ Notes     │
└──────────────┴─────────────────────────────────────────┴───────────┘
```

### 8.3 Runspace Rail

縦方向のタブはRunspace。

Runspace label:

```text
MON-42
issue-188
Project Home UI
running / waiting / review
```

Runspace types:

```text
task_run
project_shell
review
scratch
project_agent
```

通常はTask Run開始時に自動作成される。

```text
Work BoardでRun
→ Task Run作成
→ Worktree作成
→ WorkbenchにRunspace追加
```

### 8.4 Runspace Header

Runspace上部に表示するもの:

```text
Task title
MON id
Project
Branch
Worktree path
Run status
Agent status
PR badge
Open Issue / Open PR buttons
```

Example:

```text
MON-42 Project Home layout redesign
monica · branch issue-188 · /repo/.worktrees/issue-188
Agent: waiting_for_user · PR: draft #201
```

### 8.5 Horizontal Tabs

Runspace内の横タブ:

```text
Agent
Shell
Logs
Diff
Editor
Tests
Review
Notes
Project Agent
```

#### Agent Tab

Task Agentのsessionを見る。

- Claude Code transcript
- Current prompt
- User prompt submit
- Agent output
- Waiting question
- Approval UI
- Continue / Fork / Stop

#### Shell Tab

通常のshell。

- cwdはworktree
- envにMonica contextを注入
- command historyをrun outputに保存
- detached/reconnect可能

Env例:

```bash
MONICA_PROJECT_ID=...
MONICA_TASK_ID=MON-42
MONICA_TASK_RUN_ID=...
MONICA_WORKTREE=/path/.worktrees/issue-188
MONICA_BRANCH=issue-188
MONICA_ISSUE_URL=https://github.com/...
```

#### Logs Tab

- setup.sh logs
- agent hook events
- process logs
- test logs
- sync logs
- event timeline

#### Diff Tab

- git diff summary
- changed files
- file diff viewer
- staged/unstaged
- compare to base branch
- refresh

#### Editor Tab

- file tree rooted at worktree
- text editor
- quick open
- save
- maybe Monaco editor

#### Tests Tab

- last test command
- status
- stdout/stderr
- failures
- rerun button

#### Review Tab

- agent summary
- diff summary
- risk
- checklist
- PR readiness
- action buttons

#### Notes Tab

- run note
- implementation note
- manual observations
- decision notes

#### Project Agent Tab

Project Agentをdockしたもの。

Project HomeにあるProject Agentと同一の文脈を持つが、現在のRunspace contextを追加で受け取る。

できること:

```text
この実装はProject方針に合っているか確認
この差分をレビューして
この結果をmemoryに反映するメモを作って
このTaskを分割すべきか考えて
Issue本文を更新して
PR descriptionを書いて
```

### 8.6 Runspace Lifecycle

```text
created
  → setting_up
  → active
  → waiting_for_user
  → review_ready
  → done
  → archived
```

RunspaceはTask Runに追従するが、UIとしては保持される。

TaskがDoneになっても、Runspaceはすぐ消さない。

- `active`: 現在作業中
- `recent`: 最近使った
- `archived`: 閉じたが履歴から復元可能

### 8.7 Worktreeとの関係

設計上の関係:

```text
Runspace has default worktree
Runspace is not equal to worktree
```

理由:

- main branch shellを開きたいことがある
- 同じTaskでcontinue/forkしたいことがある
- PR reviewだけのRunspaceがあり得る
- worktreeなしのresearch taskもあり得る
- 将来multi-repo taskがあり得る

ただし、UIの体感としては基本的に「縦タブ = worktree単位」でよい。

### 8.8 Terminal Implementation Notes

xterm.jsを使う場合、frontendはterminal renderer、backendはPTY/session managerを持つ。

必要なbackend機能:

```text
create_pty_session(context)
attach_pty_session(session_id)
detach_pty_session(session_id)
resize_pty_session(session_id, cols, rows)
write_pty_input(session_id, bytes)
read_pty_output_stream(session_id)
terminate_pty_session(session_id)
```

Tauri appでは、Rust側でpseudo-terminalを扱うか、sidecar processで扱う。

Terminal sessionはDBにmetadataを保存し、stdout/stderrの全量保存は慎重に扱う。

保存方針:

```text
metadata: DB
important events: DB events
raw terminal transcript: optional run output file
large logs: run output files
```

### 8.9 Detached / Reconnect

Claude Codeやshellを長時間動かすため、Workbenchを閉じてもsessionが生きる設計が望ましい。

必要な概念:

```text
process_id
pty_session_id
run_id
agent_session_id
terminal_session_id
last_seen_at
status
```

App再起動後に、以下を復元する。

- Running task一覧
- active runspace一覧
- attach可能なterminal/agent session
- last event timeline

---

## 9. Project Home / Work Board / Workbench の連携

### 9.1 Object flow

```text
Project Home
  Project Agent Chat
    → Intent Draft
    → Intent
    → Task
    → GitHub Issue external_ref
    → Start Run

Work Board
  Task Inbox / Ready
    → Start Run
    → Running
    → Need Approval / Need Intervention / Review

Workbench
  Runspace
    → Agent / Shell / Logs / Diff / Editor
    → Review
    → PR
    → Done

Project Home
  Action-to-Knowledge
    → Memory Summary update
    → Docs update
    → Decision Log
```

### 9.2 Navigation rules

各Spaceでの遷移:

```text
Project Home:
  Intent card -> Drawer
  Task card -> Drawer
  Start Run -> optional Workbench
  Open Board -> Work Board filtered by project

Work Board:
  Task card -> Drawer
  Run & Open -> Workbench Runspace
  Open Project -> Project Home
  Open Review -> Review Drawer or Workbench Review tab

Workbench:
  Open Task -> Drawer
  Open Board -> Board filtered to current Task/Project
  Open Project -> Project Home with current Task context
  Open Project Agent -> docked Project Agent tab
```

### 9.3 Background Runs

Runは常に画面遷移を伴わない。

```text
Run in Background
  - Boardに残る
  - WorkbenchにはRunspaceが作られるがactiveにはしない
  - global status indicatorに表示

Run & Open
  - Workbenchへ遷移
  - 作成されたRunspaceをactiveにする
```

これにより、複数Taskを連続でRunしても作業の流れを中断しない。

---

## 10. 主要Workflow

### 10.1 Workflow A: Project Agentと会話してTask化する

```text
1. User opens Project Home for monica
2. User chats with Project Agent:
   「Project Home / Work Board / Workbenchの設計を整理したい」
3. Project Agent asks clarifying questions or drafts structure
4. User confirms direction
5. Project Agent creates Intent Draft
6. User saves Intent
7. User promotes Intent to Task
8. Monica creates Task MON-123
9. User chooses Create GitHub Issue
10. Monica creates GitHub Issue and stores external_ref
11. User chooses Run & Open
12. Monica creates Task Run
13. Worktree is created
14. setup.sh runs
15. Claude Code starts
16. Workbench opens new Runspace
```

### 10.2 Workflow B: 既存GitHub IssueをtrackしてRunする

```text
1. User opens Work Board
2. User invokes Track Issue
3. Paste owner/repo#123 or GitHub URL
4. Monica fetches GitHub Issue
5. Monica creates Task and external_ref
6. Task appears in Ready or Inbox
7. User chooses Run
8. Monica creates Task Run, worktree, agent session
9. Workbench Runspace is added
```

### 10.3 Workflow C: Task Inboxを整理する

```text
1. User opens Work Board
2. Filter by Project
3. Inbox column shows new Tasks
4. User reviews each card
5. Actions:
   - Move to Backlog
   - Move to Ready
   - Edit title/body
   - Link Issue
   - Merge duplicate
   - Dismiss/Archive
   - Start Run
```

### 10.4 Workflow D: Running taskに介入する

```text
1. Task moves to Need Intervention
2. Global status indicator highlights it
3. User opens card from Work Board
4. User chooses Open Workbench
5. Workbench opens the relevant Runspace
6. User checks Logs and Agent tab
7. User opens Shell tab if needed
8. User sends instruction to Task Agent
9. Run status returns to Running
```

### 10.5 Workflow E: Need Approvalを処理する

```text
1. Agent enters ExitPlanMode or AskUserQuestion
2. Monica receives hook event
3. Run status becomes waiting_for_user
4. Task appears in Need Approval
5. User opens approval card
6. User reviews plan/question
7. User chooses:
   - Approve
   - Reject
   - Reply with instruction
   - Open Workbench
8. Monica sends continuation to Agent session
```

### 10.6 Workflow F: ReviewしてPRへ進む

```text
1. Agent stops or completes
2. Monica collects diff/test summary/agent summary
3. Task moves to Review
4. User opens Review
5. User checks:
   - Summary
   - Changed files
   - Diff
   - Test result
   - Risks
   - Remaining questions
6. User chooses:
   - Create PR
   - Request changes
   - Continue Agent
   - Fork Run
   - Mark Done
7. If Create PR:
   - Monica creates PR or opens PR flow
   - PR external_ref is stored
   - PR badge appears on Task
```

### 10.7 Workflow G: 完了結果をKnowledgeに反映する

```text
1. Task is marked Done or PR is merged
2. Monica asks whether to update Project Memory
3. Project Agent summarizes:
   - What changed
   - Why it changed
   - Important decisions
   - New commands/tests
   - Follow-up tasks
4. User approves or edits
5. Monica updates:
   - Memory Summary
   - Decision Log
   - Relevant docs
   - Knowledge pages
   - Task completion note
```

### 10.8 Workflow H: SourceからIntent/Taskへ

```text
1. Source is ingested from Web/RSS/Slack/GitHub repo
2. Monica stores raw source
3. Project Agent or Intake Agent summarizes it
4. Monica suggests related Projects
5. User chooses:
   - Save as Note
   - Create Intent
   - Create Research Task
   - Create Implementation Task
   - Dismiss
6. If Task:
   - It enters Work Board
```

---

## 11. State Machines

### 11.1 Intent Status

```text
captured
  → triaging
  → promoted
  → dismissed
  → archived
```

Meaning:

```text
captured: 保存されたが未整理
triaging: Project Agent/Userが整理中
promoted: Task/Note/Source/Docなどに変換済み
dismissed: 不要と判断
archived: 履歴として保管
```

### 11.2 Task Status

```text
inbox
  → backlog
  → ready
  → planning
  → running
  → need_approval
  → need_intervention
  → review
  → done
  → archived
```

遷移例:

```text
inbox -> ready: triage完了
ready -> planning: Agentが計画作成
ready -> running: Start Run
running -> need_approval: Agent asks approval
running -> need_intervention: failure/stuck/manual intervention
running -> review: Agent completed
review -> running: continue / request changes
review -> done: accepted
```

### 11.3 Run Status

```text
queued
  → setting_up
  → running
  → waiting_for_user
  → stopped
  → failed
  → completed
  → review_ready
  → cancelled
```

Run statusはTask statusに影響するが、完全に同一ではない。

例:

```text
Run waiting_for_user -> Task need_approval
Run failed -> Task need_intervention
Run completed -> Task review
```

### 11.4 Agent Session Status

```text
starting
  → running
  → waiting_for_user
  → stopped
  → failed
  → completed
```

### 11.5 Runspace Status

```text
active
  → inactive
  → archived
```

RunspaceはUI状態なので、Task/Run完了後も残せる。

---

## 12. Event Model

### 12.1 Eventの役割

Monicaでは、Agent実行、Terminal操作、Git状態、PR同期、ユーザー操作をEventとして記録する。

Eventは以下に使う。

- Timeline表示
- Run/Task status更新
- Review summary生成
- Debugging
- Knowledge update
- Reconnect/recovery

### 12.2 Event種類

```text
TaskCreated
TaskUpdated
TaskStatusChanged
IntentCaptured
IntentPromoted
IssueTracked
IssueCreated
IssueLinked
RunQueued
RunSetupStarted
RunSetupCompleted
RunStarted
RunStatusChanged
AgentSessionStarted
AgentHookReceived
AgentAskedUser
AgentPlanRequestedApproval
AgentStopped
AgentFailed
TerminalSessionStarted
TerminalCommandExecuted
TerminalSessionExited
WorktreeCreated
WorktreeDirtyChanged
DiffSnapshotCreated
TestStarted
TestCompleted
ReviewCreated
PRCreated
PRSynced
MemoryUpdateProposed
MemoryUpdated
```

### 12.3 Event storage

DBには構造化Eventを保存し、大きなpayloadはrun output fileへ逃がす。

```text
events table:
  id
  project_id
  task_id?
  run_id?
  agent_session_id?
  kind
  message
  payload_json
  output_path?
  created_at
```

---

## 13. Agent Orchestration

### 13.1 Agent Types

```text
Project Agent
Task Agent
Intake Agent
Review Agent
Wiki Maintainer Agent
```

#### Project Agent

Project Homeにいる。

Responsibilities:

```text
Project文脈の把握
Intentの整理
Task/Issue draft作成
docs更新
memory summary更新
Project状態の説明
Task分解
優先度提案
Review支援
```

#### Task Agent

Task Runに紐づく。

Responsibilities:

```text
実装
調査
テスト
diff作成
PR準備
質問
計画作成
```

#### Intake Agent

SourcesをIntent/Note/Task候補に変換する。

#### Review Agent

Agentの出力をレビュー用に要約し、リスクや未解決点を抽出する。

#### Wiki Maintainer Agent

Project memory/docs/knowledgeを更新する。

### 13.2 Agent Context Construction

Task Agentを起動するとき、Monicaはcontextを組み立てる。

Inputs:

```text
Task title/body
GitHub Issue body/comments
Project docs
Memory Summary
Relevant decisions
Repo metadata
.monica/prompt.md
.monica/setup.sh information
Previous run summaries
User instructions
```

Generated run outputs:

```text
prompt.txt
claude-settings.json
context-summary.md
run-metadata.json
```

### 13.3 Project Agent Context

Project Agentは以下を参照する。

```text
Project overview
Memory Summary
Recent docs
Open Intents
Open Tasks
Running Runs
Need Approval / Need Intervention
Recent PRs
Recent decisions
Sources
```

Project Agentは巨大な全履歴を毎回読むのではなく、Memory Summary、index、recent events、selected documentsを使う。

### 13.4 Approval Handling

Agentが承認を求めたとき:

```text
hook/event受信
→ Run waiting_for_user
→ Task need_approval
→ Board card更新
→ Workbench Agent tabにquestion表示
→ User actionをAgent sessionへ送る
```

### 13.5 Continue / Fork

Continue:

```text
同じTask Runまたは新しいRun Attemptとして継続
同じworktreeを使う
Agent sessionはcontinue可能なら同session、不可なら新session
```

Fork:

```text
新しいTask Runを作る
新しいworktreeまたは同worktreeのbranch/forkを作る
別アプローチを試す
元Runとの関係を保持
```

Fork relation:

```text
run.parent_run_id
run.fork_reason
run.forked_from_agent_session_id
```

---

## 14. Review / PR Flow

### 14.1 Review Object

ReviewはTask Runの出力を人間が判断するためのobject。

Fields:

```text
id
task_id
run_id
status: pending | approved | changes_requested | rejected | done
summary
changed_files_json
test_result_id?
risk_level
remaining_questions
created_at
updated_at
completed_at?
```

### 14.2 Review Screen / Drawer

Reviewで表示するもの:

```text
Task description
Agent summary
Diff summary
Changed files
Inline diff
Test result
Risk assessment
Remaining questions
PR status
Related issue
Memory update suggestion
```

Actions:

```text
Approve
Request Changes
Continue Agent
Fork Run
Create PR
Open PR
Mark Done
Update Memory
```

### 14.3 PR Creation

PR作成時に必要な情報:

```text
base branch
head branch
title
body
linked issue
review summary
test result
risk note
```

PR bodyはReview summaryから生成できる。

PR作成後:

```text
External Ref: GitHub PRを保存
Task cardにPR badge表示
PR sync workerが状態更新
mergedならTask Done候補
```

---

## 15. Knowledge / Memory / LLM Wiki Integration

### 15.1 基本方針

MonicaのKnowledgeは、単なるRAGではなく、ProjectやSourcesから育つ持続的なWiki/Memoryとして扱う。

Raw sourcesはimmutable、WikiはLLMが更新するmarkdown群、SchemaはLLMに構造と運用規約を与える設定ファイルとして考える。

### 15.2 Knowledge Layers

```text
Raw Sources
  - Web articles
  - GitHub issues
  - PRs
  - Slack threads
  - PDFs
  - local files
  - terminal transcripts

Project Memory
  - compressed current project state
  - decisions
  - architecture summary
  - important constraints

Project Docs
  - user-facing or project-facing docs
  - specs
  - roadmaps
  - runbooks

Wiki Pages
  - concepts
  - entities
  - comparisons
  - research notes
  - source summaries
  - synthesis pages

Index / Log
  - index.md for content navigation
  - log.md for chronological operations
```

### 15.3 Operations

#### Ingest

```text
Source is added
→ LLM summarizes
→ Source summary page created
→ related pages updated
→ index updated
→ log appended
→ potential Intents/Tasks suggested
```

#### Query

```text
User asks question
→ Monica searches wiki/docs/memory
→ Project Agent synthesizes answer
→ answer can be saved as doc/note/wiki page
→ possible Task/Intent suggested
```

#### Lint

```text
Periodic health check
→ contradictions
→ stale claims
→ orphan pages
→ missing references
→ unresolved questions
→ suggested sources/tasks
```

### 15.4 Action-to-Knowledge

Task完了後にProject Memoryへ戻す。

```text
Task Done
→ Review summary exists
→ Monica proposes memory/doc updates
→ User approves
→ Memory Summary updated
→ Decision Log updated
→ related docs updated
→ source/task links recorded
```

これにより、実装結果がchat historyやPR内に消えず、Projectの知識として蓄積する。

---

## 16. Technical Architecture

### 16.1 Existing Architectureを尊重する

既存構成:

```text
monica-core
  - domain models
  - usecases
  - interface traits

monica-infra
  - SQLite
  - GitHub
  - Git
  - filesystem
  - process
  - Keychain

monica-cli
  - CLI commands

monica-app
  - Tauri app
  - Dashboard UI
```

この設計でも、domain/usecaseをcoreに置き、外部実装はinfraへ寄せる。

### 16.2 Proposed Core Modules

```text
core/domain/project.rs
core/domain/intent.rs
core/domain/task.rs
core/domain/run.rs
core/domain/worktree.rs
core/domain/agent_session.rs
core/domain/terminal_session.rs
core/domain/runspace.rs
core/domain/document.rs
core/domain/source.rs
core/domain/review.rs
core/domain/event.rs
core/domain/external_ref.rs

core/usecase/capture_intent.rs
core/usecase/promote_intent.rs
core/usecase/create_task.rs
core/usecase/create_github_issue.rs
core/usecase/track_issue.rs
core/usecase/start_run.rs
core/usecase/continue_run.rs
core/usecase/fork_run.rs
core/usecase/stop_run.rs
core/usecase/create_review.rs
core/usecase/create_pr.rs
core/usecase/update_project_memory.rs
core/usecase/open_runspace.rs
```

### 16.3 Infra Adapters

```text
infra/sqlite
infra/github
infra/git
infra/filesystem
infra/process
infra/pty
infra/agent/claude_code
infra/search
infra/wiki_fs
infra/keychain
```

### 16.4 Tauri Commands

Examples:

```text
project_list()
project_get(project_id)
project_create_or_init(...)

intent_create(...)
intent_list(project_id, filters)
intent_promote_to_task(intent_id, options)
intent_dismiss(intent_id)

task_create(...)
task_list(filters)
task_get(task_id)
task_update(...)
task_move_status(task_id, status)
task_delete(task_id)

issue_track(ref)
issue_create(task_id, options)
issue_link(task_id, issue_ref)

run_start(task_id, options)
run_continue(run_id, options)
run_fork(run_id, options)
run_stop(run_id)
run_get(run_id)
run_list(filters)

runspace_list(project_id)
runspace_open_for_run(run_id)
runspace_set_active(runspace_id)
runspace_create_tab(runspace_id, kind, options)

terminal_create_session(runspace_id, options)
terminal_attach(session_id)
terminal_write(session_id, bytes)
terminal_resize(session_id, cols, rows)
terminal_terminate(session_id)

review_create(run_id)
review_get(review_id)
review_request_changes(review_id, body)
review_approve(review_id)

pr_create(task_id, run_id, options)
pr_open(pr_id)

project_agent_send_message(project_id, message, context)
project_memory_get(project_id)
project_memory_update(project_id, patch)
```

### 16.5 Frontend State

Frontend should treat server/core state as source of truth.

UI state examples:

```text
active_space
active_project_id
selected_object_ref
open_drawer_ref
active_board_view
active_runspace_id
active_runspace_tab_id
keyboard_mode
```

Data polling/streaming:

```text
Task list: polling or event stream
Run events: event stream preferred
Terminal output: stream
PR sync: background worker
```

### 16.6 Event Streaming

Status Dashboard currently polls. Long term, use event stream for active screens.

```text
Backend emits domain events
→ Tauri event channel
→ frontend store updates
→ Board/Workbench re-render
```

Polling can remain as fallback.

### 16.7 Run Outputs

Run outputs:

```text
run-metadata.json
setup.log
prompt.txt
claude-settings.json
hook-events.jsonl
terminal-transcript.txt optional
agent-summary.md
diff-summary.md
test-result.json
review.md
```

Run output metadata in DB:

```text
id
project_id
task_id?
run_id?
kind
path
mime_type
size
created_at
```

---

## 17. UI Details

### 17.1 Command Palette

Command Paletteはすべての操作の入口。

Commands:

```text
Go to Project Home
Go to Work Board
Go to Workbench
Switch Project
Create Intent
Create Task
Track GitHub Issue
Create GitHub Issue
Start Run
Run & Open
Open Workbench
Open PR
Open Issue
Continue Run
Fork Run
Stop Run
Create Review
Update Memory
Open Project Agent
Open Shell
Search Tasks
Search Docs
```

Commandはactive object contextを受け取る。

例:

```text
Task選択中にcmd+k → Start Run
Runspace選択中にcmd+k → Open Diff / Stop Run / Continue
Project Homeでcmd+k → Create Intent / Update Memory
```

### 17.2 Search

Search対象:

```text
Projects
Intents
Tasks
Runs
Issues
PRs
Docs
Memory
Sources
Events
Run Outputs
```

Search resultから直接actionできる。

```text
Open
Open Drawer
Run
Open Workbench
Open Issue
Open PR
```

### 17.3 Keyboard Navigation

Space navigation:

```text
g h: Project Home
g b: Work Board
g w: Workbench
g i: Inbox
g d: Docs/Library
g p: Project switcher
```

Board navigation:

```text
h/l: column移動
j/k: card移動
enter: open drawer
shift+enter: open full page
r: run
R: run & open
m: move status
p: priority
i: open issue
P: open PR
w: open workbench
```

Workbench navigation:

```text
ctrl+j/k: runspace移動
ctrl+h/l: tab移動
cmd+enter: send to agent / execute depending on focus
cmd+shift+w: close/archive runspace
```

---

## 18. Large Milestones

このissueはMVPではなく、大きな設計単位をまとめる親issueである。子issue化するときは以下のmilestone単位で分解する。

### Milestone 1: Core Object Model / Ownership Foundation

Goal:

```text
Intent-first / Task Run / Runspace / External Ref の所有関係を定義する。
```

Deliverables:

- Project / Intent / Task / Task Run / Worktree / Agent Session / Terminal Session / Runspace / Review / Document / Source / External Refのdomain model整理
- SQLite migration design
- 既存task/run/external_refとの互換方針
- Task statusとRun statusの合成ルール
- Event model拡張
- Spaceはviewでありobject所有者ではないことをコード上でも反映

### Milestone 2: Project Home / Intent Layer

Goal:

```text
Projectについて会話し、Intentを作り、Task/Issueへ変換できるProject Homeを作る。
```

Deliverables:

- Project Home shell
- Project selector
- Project Agent Chat UI
- Chat history left rail
- Context Rail
- Intent draft card
- Intent save/promote flow
- Task create flow
- GitHub Issue create/link flow
- Memory Summary display
- Project docs list/display

### Milestone 3: Work Board / Agent-aware Kanban

Goal:

```text
Task InboxからReady/Running/Reviewまで、人間とAgentの共同作業状態をBoardで管理できる。
```

Deliverables:

- Kanban Board
- Project filter
- Status grouping
- Task card redesign
- Task Drawer
- Task move/status actions
- Track Issue UI
- Start Run / Run & Open / Run in Background
- Need Approval / Need Intervention columns
- PR / Issue / Workbench navigation

### Milestone 4: Run Orchestration / Session Tracker

Goal:

```text
TaskをRunすると、worktree、setup、Agent session、event trackingが一貫して起動・監視される。
```

Deliverables:

- Start Run usecaseのUI化
- Continue / Fork / StopのUI化
- setup.sh execution visibility
- Claude Code launch/reconnect model
- hook event classification
- Task status auto transition
- Run outputs整理
- Background run indicator
- App restart recovery

### Milestone 5: Workbench / Runspace / Terminal ADE

Goal:

```text
RunごとにRunspaceを作り、Terminal、Agent、Logs、Diff、Editorを横tabで扱えるWorkbenchを作る。
```

Deliverables:

- Workbench shell
- Runspace rail
- Runspace lifecycle
- xterm.js terminal integration
- PTY/session manager
- Shell tab
- Agent tab
- Logs tab
- Diff tab
- Editor tab
- Project Agent dock/tab
- Runspace persistence
- Open Workbench from Board

### Milestone 6: Review / PR Closure

Goal:

```text
Agentの出力をReviewし、PR化し、Doneへ閉じられる。
```

Deliverables:

- Review object
- Review screen/drawer
- agent summary run output
- diff summary
- test result viewer
- risk/remaining questions
- Create PR flow
- PR sync improvements
- Request changes / continue / fork
- Mark Done

### Milestone 7: Project Memory / Knowledge Loop

Goal:

```text
TaskやPRの結果をProject memory/docs/wikiへ反映し、作業が知識として蓄積される。
```

Deliverables:

- Project Memory Summary model
- Decision Log
- Memory update proposal
- Task completion summary
- docs update flow
- source/task/run/review links
- wiki index/log integration
- lint/check flow

### Milestone 8: Intake / Daily / Knowledge-to-Action

Goal:

```text
Slack/Web/RSS/GitHub repoなどからIntentを作り、Project/Task/Knowledgeへ接続する。
```

Deliverables:

- Intent Inbox
- Source model
- Web/RSS source intake
- Slack/conversation intake
- GitHub repo source intake
- Source summary
- related project suggestion
- proposal generation
- promote to Task/Research/Note
- Daily Home / Today view

### Milestone 9: Multi-project / Polish / Power User UX

Goal:

```text
複数Project、複数Run、複数Agentを高速に扱えるMonicaらしい操作性に仕上げる。
```

Deliverables:

- Multi-project dashboard
- Global search
- Command palette
- full keyboard navigation
- layout persistence
- notification system
- project switcher
- runspace search/switcher
- theming
- settings/keybindings

---

## 19. Important Design Decisions

### Decision 1: GitHub Issueは主語ではない

GitHub IssueはExternal Refとして扱う。

Monica内部の主語はIntent/Task/Run。

### Decision 2: `track` と `promote` を分ける

```text
track issue
  = 既存GitHub IssueをMonica Taskとして取り込む

promote intent
  = Monica内のIntentをTask/Note/Researchなどへ変換する
```

### Decision 3: Terminal SpaceではなくWorkbench

TerminalはWorkbenchの一部。

WorkbenchはAgent-aware ADE。

### Decision 4: 縦タブはworktreeではなくRunspace

UI体感はworktree単位でよいが、内部モデルはRunspace。

### Decision 5: Project AgentはProject Homeが本籍地

WorkbenchにProject Agent tabを出せるが、Project AgentをRunspace配下の存在にはしない。

### Decision 6: RunはTaskのstatusではなく実行インスタンス

Taskは複数Runを持てる。

Continue/Fork/Retryを自然に扱うため、TaskとRunを分ける。

### Decision 7: Spaceはviewでありobject ownerではない

Project Home、Work Board、Workbenchは同じobject graphを見る異なるview。

### Decision 8: Action-to-Knowledgeを明示する

Task完了はPR mergeだけでは閉じない。

必要に応じてMemory Summary、docs、Decision Logへ反映する。

---

## 20. Open Questions

この親issueから子issueへ分解する際に、以下は個別に決める。

### 20.1 ProjectとRepoの関係

- 1 Project = 1 Repoで始めるか。
- Multi-repo projectをいつから入れるか。
- 学習/調査projectはrepoなしでどう扱うか。

### 20.2 Docsの保存場所

- Monica DBに保存するか。
- repo内markdownに保存するか。
- Wiki directoryに保存するか。
- すべてに対応するか。

### 20.3 Project Agentの実装形態

- Claude Codeを使うか。
- 別のLLM APIを使うか。
- chat historyをどこに保存するか。
- Project Agentにどのtoolsを与えるか。

### 20.4 Terminal Sessionの永続性

- appを閉じてもPTYを維持するか。
- どのprocess managerを使うか。
- transcriptを全保存するか。

### 20.5 RunspaceとTask Runの対応

- 1 run = 1 runspaceを原則にするか。
- continue時に同じrunspaceを使うか新規runspaceにするか。
- fork時のUI表現をどうするか。

### 20.6 Reviewの粒度

- ReviewはTask単位かRun単位か。
- 複数Runの比較Reviewを持つか。

### 20.7 Knowledge更新の承認

- Done時に毎回memory updateを聞くか。
- 自動提案だけにするか。
- 小さな変更は自動更新してよいか。

---

## 21. Parent Issue Checklist

この親issue全体の完了イメージ。

- [ ] Project Home / Work Board / Workbench の3 Space構成がUIに存在する
- [ ] Project HomeでProject Agentと会話できる
- [ ] Project HomeでIntentを作成できる
- [ ] IntentをTaskにpromoteできる
- [ ] TaskからGitHub Issueを作成/紐づけできる
- [ ] 既存GitHub Issueをtrackできる
- [ ] Work BoardでTaskをstatus別に管理できる
- [ ] Work BoardでTaskをRunできる
- [ ] Run開始時にworktree/setup/Agent sessionが起動する
- [ ] Run開始時にWorkbenchへRunspaceが自動追加される
- [ ] WorkbenchでRunspaceを縦タブとして扱える
- [ ] Runspace内でAgent/Shell/Logs/Diff/Editor/Reviewを横tabとして扱える
- [ ] Agent hook/eventによってTask/Run statusが更新される
- [ ] Need Approval / Need InterventionがBoardに表示される
- [ ] Review screenでdiff/test/summary/riskを確認できる
- [ ] PRを作成/同期できる
- [ ] Task完了後にProject Memory/docs更新へつなげられる
- [ ] Command PaletteとKeyboard navigationで主要操作ができる
- [ ] Object DrawerでSpace横断の詳細表示ができる
- [ ] GitHub Issue-firstだけでなく、Intent-firstの作業が成立する

---

## 22. Summary

Monicaの画面設計は以下に整理する。

```text
Project Home
  - Project Agent
  - Intent
  - Docs
  - Memory Summary
  - Issues
  - PRs
  - Running Tasks

Work Board
  - Task Inbox
  - Backlog
  - Ready
  - Planning
  - Running
  - Need Approval
  - Need Intervention
  - Review
  - Done

Workbench
  - Runspace rail
  - Agent tab
  - Shell tab
  - Logs tab
  - Diff tab
  - Editor tab
  - Tests tab
  - Review tab
  - Notes tab
  - Project Agent tab
```

この設計により、Monicaは以下の流れを自然に扱える。

```text
Intent
  → Task
  → GitHub Issue / External Ref
  → Task Run
  → Worktree
  → Agent Session
  → Runspace
  → Review
  → PR
  → Knowledge
```

Monicaは、Linear、Terminal、Claude Code、GitHub Issues、Obsidian/Wikiを単に寄せ集めたものではない。

Projectの文脈でIntentを受け取り、Taskに変換し、Agentに実行させ、人間が必要なところで介入し、成果をReview/PR/Knowledgeへ閉じるための **Personal Agentic Workspace** である。
