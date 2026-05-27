うん。**Kanbanで扱う中心モデルはすべて `WorkItem` でいい**と思います。

ただし、少し正確に言うとこうです。

> **Kanbanに載るもの = WorkItem**
> **Monicaに入ってくるすべての情報 = WorkItem ではない**

この区別が大事です。

---

# 結論

MonicaのKanbanは、`Issue` の一覧ではなく、**WorkItemの状態ビュー**として考えるのがよいです。

```text
WorkItem
  ├─ development task
  ├─ bug fix
  ├─ feature idea
  ├─ research task
  ├─ reading item
  ├─ scheduled task
  ├─ Slack-derived task
  ├─ approval request
  └─ reminder
```

これらを全部 `WorkItem` の variant として扱えるようにする。

そのうえで、Kanbanはこういうものになります。

```text
Kanban = WorkItemをstatusごとに並べたprojection
```

つまり、Kanbanは特定の `Issue` モデル専用ではなく、Monica内の「進行状態を持つ作業単位」を表示する場所です。

---

# `Issue` ではなく `WorkItem` を中心にする理由

`Issue` という名前は、開発タスクにはかなり合っています。

でも、Monicaでは今後こういうものも扱いたい。

```text
Slackで拾った依頼
朝読む記事
気になるGitHub repo
あとで調べる技術
Claude Codeの承認待ち
定期的なscheduler task
友人との会話から出た機能案
```

これらを全部 `Issue` と呼ぶと、徐々に意味が苦しくなります。

一方で `WorkItem` なら、

> **自分またはエージェントが何らかの判断・行動・処理をする対象**

として自然に扱えます。

だから内部モデルは `WorkItem` が良いです。

---

# ただし `Source` と `WorkItem` は分ける

ここが重要です。

例えば、Slack messageやRSS articleは、最初からWorkItemとは限りません。

```text
Slack message
RSS article
GitHub repo
Web page
GitHub issue
Calendar event
```

これらはまず `Source` です。

そこから、必要に応じて `WorkItem` が作られる。

```text
Slack message
  → Source
  → WorkItem(kind: "task", status: "inbox")

RSS article
  → Source
  → WorkItem(kind: "reading", status: "inbox")

GitHub issue
  → ExternalRef / Source
  → WorkItem(kind: "development", status: "ready")
```

つまり、

```text
Source = 元情報
WorkItem = Monica上で扱う作業単位
Run = WorkItemを実行した履歴・session
```

です。

この3つを分けておくと、あとでかなり強いです。

---

# 私ならこう整理する

## 1. Source

外から入ってきた元データ。

```text
Slack thread
GitHub issue
RSS item
Article
Repo
Manual note
Schedule rule
```

Sourceはまだ「作業」ではない。
保存されているだけ、参照されているだけ、という状態もありえる。

---

## 2. WorkItem

Monica上で状態管理される対象。

Kanbanに載るのはこれ。

```text
MON-12
title: Add project registry
kind: development
status: running
source: GitHub issue #123
```

または、

```text
MON-44
title: Read article about agent orchestration
kind: reading
status: inbox
source: RSS item
```

または、

```text
MON-51
title: 上司から依頼された分析をまとめる
kind: task
status: ready
source: Slack thread
```

---

## 3. Run

WorkItemを実際に動かした実行単位。

```text
Run
  ├─ worktree
  ├─ branch
  ├─ Claude Code session
  ├─ setup log
  ├─ hook events
  ├─ PR
  └─ result
```

1つのWorkItemに対して、Runは複数あってもよいです。

例えば、一度Claude Codeで実装したが失敗して、別のsessionでやり直すことがある。

```text
WorkItem MON-12
  ├─ Run 1: failed
  ├─ Run 2: stopped
  └─ Run 3: pr_open
```

なので、`WorkItem` と `Run` は分けたほうがいいです。

---

# WorkItemのvariantとして扱う、で合っている

あなたの言い方に合わせるなら、

> **WorkItemのvariantとしてすべてKanbanなどで扱えるようにする**

で合っています。

ただし、variantごとに持つべき情報や可能なactionは違います。

例えば、

```text
development WorkItem
  - repo
  - GitHub issue
  - branch
  - worktree
  - agent run
  - PR

reading WorkItem
  - URL
  - article title
  - summary
  - read status
  - related tags

research WorkItem
  - question
  - sources
  - notes
  - output document

reminder WorkItem
  - due_at
  - recurrence
  - notification settings
```

全部Kanbanに載せられる。
でも、全部が `run --claude` できるわけではない。

だから `kind` ごとに可能なactionを変えるのがよいです。

---

# モデルとしてはこういう感じ

最初はこういう `WorkItem` でよいと思います。

```ts
type WorkItemKind =
  | "development"
  | "task"
  | "bug"
  | "feature"
  | "research"
  | "reading"
  | "idea"
  | "reminder"
  | "approval"
  | "maintenance";

type WorkItemStatus =
  | "inbox"
  | "ready"
  | "setting_up"
  | "running"
  | "need_approval"
  | "waiting"
  | "stopped"
  | "failed"
  | "review"
  | "pr_open"
  | "done"
  | "archived";

type WorkItem = {
  id: string; // MON-12
  kind: WorkItemKind;
  status: WorkItemStatus;

  title: string;
  body?: string;

  projectId?: string;
  priority?: "low" | "medium" | "high" | "urgent";

  sourceRefs: SourceRef[];
  externalRefs: ExternalRef[];

  labels: string[];
  dueAt?: string;

  details: WorkItemDetails;

  createdAt: string;
  updatedAt: string;
};
```

`details` がvariantごとの中身です。

```ts
type WorkItemDetails =
  | DevelopmentDetails
  | ResearchDetails
  | ReadingDetails
  | ReminderDetails
  | ApprovalDetails;
```

例えばdevelopmentなら、

```ts
type DevelopmentDetails = {
  type: "development";
  repo: string;
  githubIssueNumber?: number;
  branch?: string;
  currentRunId?: string;
  prNumber?: number;
};
```

readingなら、

```ts
type ReadingDetails = {
  type: "reading";
  url: string;
  author?: string;
  summary?: string;
  relatedProjects?: string[];
};
```

researchなら、

```ts
type ResearchDetails = {
  type: "research";
  question: string;
  output?: string;
  relatedSources?: string[];
};
```

最初はSQLiteに `details_json` として入れておけば十分です。

---

# Kanbanのstatusは「細かすぎない」ほうがいい

ここで悩ましいのがstatusです。

development用に細かく作ると、

```text
setting_up
running
need_approval
pr_open
```

は便利です。

でもreadingやresearchにも同じstatusを使うと違和感が出ます。

例えばreading itemに `pr_open` は関係ない。

なので、私は2層に分けるのが良いと思います。

## 共通status

Kanban全体で使う大きな状態。

```text
inbox
ready
active
waiting
review
done
archived
```

## kind-specific phase

種類ごとの細かい状態。

```text
development phase:
  setting_up
  running_agent
  need_approval
  stopped
  failed
  pr_open

reading phase:
  unread
  reading
  summarized
  saved

research phase:
  researching
  drafting
  needs_review
```

つまり、

```ts
type WorkItem = {
  status: "inbox" | "ready" | "active" | "waiting" | "review" | "done" | "archived";
  phase?: string;
};
```

のようにする。

例えば、

```json
{
  "id": "MON-12",
  "kind": "development",
  "status": "waiting",
  "phase": "need_approval"
}
```

または、

```json
{
  "id": "MON-44",
  "kind": "reading",
  "status": "ready",
  "phase": "unread"
}
```

この設計だと、Kanbanは共通statusで表示できるし、詳細画面ではkindごとのphaseを見せられます。

---

# Kanbanの列はWorkItem.statusに対応させる

最初のKanbanはこれでいいと思います。

```text
Inbox | Ready | Active | Waiting | Review | Done
```

開発用にもう少し寄せるなら、

```text
Inbox | Ready | Running | Need Approval | Review | PR Open | Done
```

でもいいです。

ただ、長期的には `Running` や `PR Open` はdevelopmentに寄っているので、共通Kanbanではこうしたほうが汎用性があります。

```text
Inbox
Ready
Active
Waiting
Review
Done
```

そしてdevelopment boardだけ、表示をこう変える。

```text
Inbox
Ready
Setting Up
Running
Need Approval
PR Open
Done
```

つまり、

```text
Board = WorkItemのview
Column = statusまたはphaseのprojection
```

です。

---

# Boardごとに見せ方を変える

将来的には、同じWorkItemでもboardによって見え方を変えられるようにするとよいです。

## All Work Board

すべてのWorkItemを見る。

```text
Inbox | Ready | Active | Waiting | Review | Done
```

## Development Board

開発系だけを見る。

```text
Ready | Setting Up | Running | Need Approval | PR Open | Done
```

filter:

```text
kind in development, bug, feature, maintenance
```

## Reading Board

読むものを見る。

```text
Inbox | To Read | Reading | Summarized | Done
```

filter:

```text
kind = reading
```

## Approval Board

自分の判断待ちだけを見る。

```text
Need Approval | Review | Done
```

filter:

```text
status in waiting, review
phase in need_approval, needs_review
```

こうすると、すべての中心は `WorkItem` のまま、UIは用途ごとに変えられます。

---

# `approval` はWorkItemなのか？

ここは少し迷うところです。

Claude Codeがplan承認待ちになったとき、

```text
MON-12: need_approval
```

とするだけで十分な場合が多いです。

つまり、承認待ちは新しいWorkItemではなく、既存WorkItemのstatusです。

```text
WorkItem MON-12
status: waiting
phase: need_approval
```

でよい。

ただし、将来的に「承認だけを独立して管理したい」場合は、approvalをWorkItemとして切り出してもよいです。

例えば、

```text
MON-12: Add project registry
MON-13: Approve implementation plan for MON-12
```

でも、最初はやらなくていいです。
MVPでは、approvalはWorkItemのstatus/phaseで十分です。

---

# schedulerとの関係

schedulerも、直接WorkItemではなく、WorkItemを生成する側にしたほうがいいです。

```text
Schedule Rule
  → creates WorkItem
```

例えば、

```text
毎朝9時に記事digestを見る
```

これはSchedule Rule。

そこから毎朝、

```text
MON-80: Review today's agent/dev articles
kind: reading
status: inbox
```

のようなWorkItemが作られる。

つまり、

```text
Schedule = generator
WorkItem = generated actionable item
```

です。

---

# Slackとの関係

Slack messageも同じです。

```text
Slack Thread
  → Source
  → WorkItem
```

Slack threadそのものはSource。

そこから、

```text
MON-52
kind: task
title: 上司から依頼されたXXを対応する
status: inbox
source: slack_thread
```

が作られる。

友人との会話から機能案が出た場合は、

```text
MON-61
kind: idea
status: inbox
source: slack_thread
```

としてもいい。

それを後でdevelopment taskに変換することもできる。

```text
idea WorkItem
  → development WorkItem
```

あるいは、同じWorkItemのkindを変える。

最初は同じWorkItemを更新するだけで十分です。

---

# GitHub Issueとの関係

GitHub Issueは `WorkItem` そのものではなく、`external_ref` として扱うのが良いです。

```json
{
  "id": "MON-12",
  "kind": "development",
  "status": "ready",
  "title": "Add project registry",
  "externalRefs": [
    {
      "type": "github_issue",
      "repo": "owner/repo",
      "number": 123,
      "url": "https://github.com/owner/repo/issues/123"
    }
  ]
}
```

こうしておけば、

```text
GitHub IssueがあるWorkItem
GitHub IssueがないWorkItem
Slack由来のWorkItem
scheduler由来のWorkItem
manual作成のWorkItem
```

を全部同じKanbanで扱えます。

---

# CLI名は `issue` のままでいい

内部モデルが `WorkItem` でも、CLIは `issue` でいいと思います。

```bash
monica issue track owner/repo#123
monica issue run MON-12 --claude
monica issue status
```

これはあなたの開発フローに合っている。

ただし、内部実装では、

```text
issue command
  → WorkItemを操作するcommand
```

として扱う。

将来的にもっと広げたくなったら、

```bash
monica work list
monica work show MON-12
```

みたいなaliasを足してもいいです。

でも最初から `workitem` というCLI名にすると、やや開発者向けすぎるかもしれません。

---

# 私のおすすめ構造

最初はこれでいくのが良いです。

```text
WorkItem
  = Kanbanに載る中心モデル

Source
  = Slack, RSS, GitHub, Web, manual inputなどの元情報

ExternalRef
  = GitHub issue, PR, Slack threadなど外部システムへの参照

Run
  = Claude Code session / worktree / branch / setup_shellの実行単位

Project
  = repo registry + setup_shell + setup_prompt
```

関係はこうです。

```text
Project
  └─ WorkItem
       ├─ SourceRef[]
       ├─ ExternalRef[]
       └─ Run[]
```

もう少し具体的には、

```text
GitHub Issue #123
  → Source / ExternalRef
  → WorkItem MON-12
  → Run run_abc
  → worktree
  → Claude Code session
  → PR #130
```

Slackなら、

```text
Slack thread
  → Source
  → WorkItem MON-44
  → maybe development WorkItem
  → Run
```

RSSなら、

```text
RSS article
  → Source
  → WorkItem MON-55 kind=reading
  → summary
  → maybe WorkItem MON-56 kind=development
```

---

# 最終回答

はい。**Kanbanで扱うのはすべて `WorkItem` でよい**です。

そして、**WorkItemのvariantとして development / research / reading / reminder / approval / idea などを扱えるようにする**のがよいです。

ただし、設計上はこう分けるのがおすすめです。

```text
Source:
  外から入ってきた元情報

WorkItem:
  Kanbanに載る、状態を持つ作業単位

Run:
  WorkItemを実際にClaude Codeやshellで実行した履歴

Project:
  repo registryと実行環境設定
```

なのでMonicaの中核は、

```text
Kanban = WorkItemの状態ビュー
```

です。

`Issue` はその中の開発寄りの見え方、またはCLI上の名前として使えばいい。
内部モデルとしては `WorkItem` にしておくほうが、Slack、scheduler、RSS、Wiki、repo recommendationまで自然に拡張できます。

---

結論から言うと、あなたの考え直した案はかなり良いです。

私ならこう整理します。

> **Monica M0は「GitHub Issue / Monica Issueを、repoごとの実行環境とClaude Code sessionに接続する runner」として作る。**

そして、最初の核はこれです。

```text
project registry
  → monica issue
  → worktree
  → setup_shell
  → setup_prompt
  → Claude Code
  → hook event
  → monica status
```

ここまでをMVPにしてよいです。

ただし、1点だけ名前とデータモデルは慎重にしたほうがいいです。
CLI上は `issue` でよいですが、内部モデルは `issue` より少し抽象化したほうが長持ちします。

---

# 1. `issue` でいいのか？ `intent` のほうがいいのか？

私の答えはこうです。

## CLIでは `issue` でいい

あなたの現在の開発フローは明確に issue-driven です。

```text
issueを作る
context / goal / out of scopeを書く
Claude Codeに実装させる
確認する
PRを作る
mergeする
```

なので、日常操作としては `monica issue ...` が自然です。

```bash
monica issue new
monica issue track
monica issue run
monica issue status
```

これは違和感ありません。

むしろ `monica intent run` とか `monica intent status` だと、開発フロー上は抽象的すぎると思います。

---

## ただし内部モデル名は `issue` だけにしないほうがいい

将来的にSlack、scheduler、RSS、repo recommendation、learning noteからもMonica内のobjectが作られます。

そのとき、すべてを `issue` と呼ぶと少し苦しくなります。

例えば、Slackから拾った「これ気になる」は、まだissueではない。
schedulerが作った「明日の朝これ読む」は、開発issueではない。
RSSから来た記事は、issueというよりsourceやinbox itemです。

なので内部的には、私はこうします。

```text
Source
  → Intent / Inbox Item
  → Work Item
  → Run / Session
```

ただしMVPでは全部作らなくていいです。

最初は `work_items` という1つのテーブルで十分です。

```ts
WorkItem {
  id: "MON-123"
  kind: "task" | "bug" | "feature" | "research" | "reading" | "reminder"
  status: "inbox" | "ready" | "setting_up" | "running" | "need_approval" | "stopped" | "failed" | "pr_open" | "done"
  title: string
  body: string
  project_id?: string
  external_refs: ExternalRef[]
  source?: SourceRef
}
```

ユーザーに見える名前は `issue`。
内部の本体は `work_item`。
これが一番バランスいいと思います。

---

## 私ならこう定義する

```text
Monica Issue = ユーザーが操作する、実行可能または管理可能な作業単位

WorkItem = Monica内部の抽象データモデル

Intent = まだ作業単位になる前の曖昧な入力
```

つまり、

```text
Slack message
RSS article
scheduled reminder
GitHub issue
manual note
```

は全部 `Source` になりうる。

そこから、

```text
Inbox Item / Intent
```

ができる。

そのうち、実行するものが

```text
Monica Issue / WorkItem
```

になる。

最初のMVPでは、`Intent` を別テーブルにしなくていいです。
`WorkItem.status = inbox` と `WorkItem.kind` で吸収しておけばよいです。

---

# 2. `kind: "issue"` はおすすめしない

`kind: "issue"` にすると、少し意味が曖昧になります。

`issue` はUI上の呼び方、もしくはGitHubの外部object名にしたほうがよいです。

内部の `kind` は、こういう分類にしたほうが後で効きます。

```ts
kind:
  | "task"
  | "bug"
  | "feature"
  | "research"
  | "reading"
  | "reminder"
  | "maintenance"
  | "idea"
```

GitHub Issueに紐づいているかどうかは `external_refs` で表します。

```json
{
  "id": "MON-12",
  "kind": "feature",
  "status": "ready",
  "title": "Add saved repo recommendations",
  "project_id": "owner/repo",
  "external_refs": [
    {
      "type": "github_issue",
      "repo": "owner/repo",
      "number": 123,
      "url": "https://github.com/owner/repo/issues/123"
    }
  ]
}
```

Slackから来たものならこうです。

```json
{
  "id": "MON-44",
  "kind": "task",
  "status": "inbox",
  "title": "上司から依頼されたレポート整理",
  "source": {
    "type": "slack_thread",
    "workspace": "company",
    "channel": "C123",
    "thread_ts": "..."
  },
  "external_refs": []
}
```

この形にしておけば、将来Slackやschedulerから来ても破綻しません。

---

# 3. `repo registry` を最初に作るのは正しい

これは必須です。

むしろ、あなたのユースケースでは `issue` より前に `project registry` が必要です。

なぜなら、Monicaが実行したいことは単にissue管理ではなく、

```text
このrepoで
このbranch名規則で
このworktreeを作り
このsetup_shellを実行し
このsetup_promptでClaude Codeを起動する
```

ことだからです。

つまり、Monicaにとってrepo registryはただの一覧ではなく、**実行環境の定義**です。

---

# 4. `monica project add <owner/repo>` は良い

`repo add` ではなく `project add` にしているのも良いと思います。

将来的にMonicaでは、1つのprojectが複数repoを持つ可能性があります。

例えば、

```text
monica
  - frontend repo
  - backend repo
  - docs repo
  - infra repo
```

のようになるかもしれない。

なので、最初は `project = repo` でよいですが、名前としては `project` のほうが拡張しやすいです。

```bash
monica project add owner/repo
```

は良いです。

---

# 5. project registryに入れるべき設定

最初のproject configはこういう形が良いと思います。

```yaml
projects:
  - id: owner/repo
    name: repo
    provider: github
    repo: owner/repo
    path: ~/dev/repo
    default_branch: main

    worktree:
      root: ~/dev/.worktrees/repo
      branch_template: "monica/gh-{github_issue_number}-mon-{monica_number}-{slug}"

    setup:
      shell: |
        corepack enable
        pnpm install --frozen-lockfile

      prompt: |
        /tackle

    agent:
      default: claude
      launch_mode: interactive
      permission_mode: plan

    hooks:
      claude: true
```

特に大事なのはこのあたりです。

```yaml
setup.shell
setup.prompt
worktree.branch_template
agent.default
hooks.claude
```

`setup_shell` と `setup_prompt` は、あなたのユースケースにかなり合っています。

---

# 6. `setup_shell` はかなり良い概念

`setup_shell` は必須で良いです。

worktreeを作っても、依存関係が入っていなければClaude Codeがすぐに作業できません。

なので、

```bash
pnpm install
bun install
npm install
mise install
direnv allow
docker compose up -d
```

のような初期化をprojectごとに定義できるのは重要です。

ただし、`setup_shell` にはいくつか制約を持たせたほうがいいです。

## `setup_shell` はidempotentであるべき

何度実行しても壊れない必要があります。

```bash
pnpm install
```

は基本的にOK。

でも、

```bash
rm -rf node_modules
pnpm install
```

みたいなものは危険です。

---

## timeoutを持たせる

例えば、

```yaml
setup:
  timeout_sec: 900
  shell: |
    pnpm install --frozen-lockfile
```

はあったほうがいいです。

setupで固まると、Monica issue全体が止まります。

---

## setup logを保存する

これはかなり重要です。

```text
~/.local/share/monica/runs/MON-12/setup.log
```

のように保存しておくと、後で

```bash
monica issue logs MON-12 --setup
```

ができます。

---

## setupに失敗したらClaude Codeを起動しない

状態はこうです。

```text
ready
  → setting_up
  → setup_failed
```

setupに失敗しているのにClaude Codeを起動すると、失敗原因が曖昧になります。

---

# 7. `setup_prompt` に `/tackle` を入れるのは自然

これはかなり良いです。

あなたの会社の `/tackle` がすでに、

```text
branch名からissue idを拾う
issue descriptionを読む
planを作る
approveをもらう
実装する
PRを作る
```

ところまでできているなら、Monica M0はPR作成機能を自前で作る必要すら薄いです。

最初のMonicaの役割は、

```text
/tackle が正しく走れる環境を作る
/tackle が今どの状態かを追跡する
/tackle が止まったらMonica issueのstatusを更新する
```

で十分です。

Claude Codeは、CLIで初期promptを渡してinteractive sessionを開始できますし、SDK経由ではslash commandをprompt stringとして送る使い方も公式に説明されています。Claude Codeのcustom slash commandは `.claude/commands/` 形式でも定義できますが、現在の公式ドキュメントでは同じslash-command呼び出しに対応するSkills形式も推奨されています。([Claude Code][1])

なので、Monica側はこういう起動でよいです。

```bash
cd <worktree>
claude "/tackle"
```

または将来的にSDK化するなら、

```ts
prompt: "/tackle"
```

でよいです。

---

# 8. branch名はかなり重要

`/tackle` がbranch名からissue idを拾うなら、branch namingはMonicaの重要なcontractになります。

ここは適当にしないほうがいいです。

おすすめは、GitHub issue numberとMonica IDを両方入れることです。

```text
monica/gh-123-mon-45-add-project-registry
```

または、

```text
monica/MON-45-gh-123-add-project-registry
```

ただ、`/tackle` がGitHub issue idを拾うなら、`gh-123` を先に置いたほうが安全です。

```yaml
branch_template: "monica/gh-{github_issue_number}-mon-{monica_number}-{slug}"
```

GitHub issueに紐づいていないMonica issueの場合は、

```text
monica/mon-45-add-project-registry
```

にすればよいです。

---

# 9. `monica issue new <owner/repo#123>` は少し違和感がある

ここだけは変えたほうがいいと思います。

`owner/repo#123` は普通、「既存のGitHub Issue #123」を指しているように見えます。

なので、

```bash
monica issue new owner/repo#123
```

と言われると、

> 既存issueを指定しているのにnewなの？

という違和感があります。

私ならコマンドを分けます。

---

## 既存GitHub IssueをMonicaで管理し始める

```bash
monica issue track owner/repo#123
```

これは、

```text
GitHub Issue #123を読み込む
Monica IDを発行する
MON-12 と owner/repo#123 を紐づける
status = ready or inbox にする
```

という意味です。

例えば出力はこうです。

```text
Created MON-12 from owner/repo#123
Status: ready
Title: Add project registry
```

---

## 新しくMonica Issueを作る

```bash
monica issue new owner/repo
```

これはMonica内に新規issueを作る。

オプションでGitHub Issueも作るなら、

```bash
monica issue new owner/repo --github
```

または、

```bash
monica issue new owner/repo --create-github
```

がよいです。

---

## 既存GitHub Issueを取り込むなら `track` が一番しっくりくる

私はこの命名が一番良いと思います。

```bash
monica issue track owner/repo#123
```

`import` でもいいですが、`import` はコピーする感じが強いです。

MonicaはGitHub Issueを完全にコピーするというより、継続的に追跡するので `track` が合っています。

---

# 10. `monica issue run <monica-id> --claude` は良い

これは良いです。

ただ、将来Claude以外もありえるなら、少しだけ抽象化しておくとよいです。

```bash
monica issue run MON-12 --agent claude
```

短縮として、

```bash
monica issue run MON-12 --claude
```

を許すのはありです。

内部的には、

```ts
agent = "claude"
```

に変換すればいい。

---

# 11. `run` がやること

`monica issue run MON-12 --claude` は、最初のMVPではこれをやれば十分です。

```text
1. MON-12 を読む
2. 紐づく project / repo を解決する
3. GitHub Issueがあれば最新情報をfetchする
4. branch名を生成する
5. worktreeを作る
6. run recordを作る
7. status = setting_up にする
8. setup_shellを実行する
9. 成功したら status = running にする
10. Claude Code用のhook設定を生成する
11. setup_promptを初期promptとしてClaude Codeを起動する
12. Claude session情報をrun recordに保存する
```

これができたら、Monicaの核はもう動いています。

---

# 12. Claude Code hookは最初から仕込んでよい

これは賛成です。

ただし、最初からhookで賢い状態判定をしようとしすぎないほうがいいです。

Claude Code hooksは、session lifecycle、turn単位、tool call単位などのイベントで発火し、command hookではイベントJSONがstdinに渡されます。公式ドキュメント上も `SessionStart`、`Stop`、`StopFailure`、`SessionEnd`、`PermissionRequest`、`FileChanged`、`WorktreeCreate` などのイベントが定義されています。([Claude Code][2])

なので、Monica側は最初からhook receiverを作ってよいです。

```bash
monica hook claude
```

Claude Code側のhook設定から、このコマンドを呼ぶ。

---

# 13. hook設定はグローバルではなくrunごとに生成したい

ここは重要です。

最初から `~/.claude/settings.json` を直接書き換えるより、MonicaがrunごとのClaude settingsを生成して、それをClaude起動時に渡すほうが安全です。

Claude Codeには `--settings` でsettings JSONを指定するCLI flagがあります。([Claude Code][1])

イメージはこうです。

```text
~/.local/share/monica/runs/MON-12/claude-settings.json
```

中身は例えば、

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "monica hook claude"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "monica hook claude"
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "monica hook claude"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "monica hook claude"
          }
        ]
      }
    ]
  }
}
```

実際には `MONICA_ID` や `MONICA_RUN_ID` を環境変数で渡しておくのが良いです。

```bash
MONICA_ID=MON-12 \
MONICA_RUN_ID=run_abc123 \
claude --settings ~/.local/share/monica/runs/MON-12/claude-settings.json "/tackle"
```

hook handler側はstdinのJSONと環境変数を見て、Monica DBを更新します。

---

# 14. `need-approve` 判定はhookだけに頼らないほうがいい

ここはかなり大事です。

`/tackle` が「planを作って、ユーザーのapproveを待つ」ところで止まるとしても、Claude Codeの `Stop` eventだけを見ると、それが

```text
plan approval待ち
実装完了
質問待ち
エラーで止まった
単に返答が終わった
```

のどれなのかは曖昧です。

なので、状態判定は3段階で考えるのがよいです。

---

## M0: Stopしたら `stopped` または `need_review`

最初はこれで十分です。

```text
Stop → stopped
StopFailure → failed / need_intervention
SessionEnd → stopped
```

この段階では、あなたが `monica issue status` を見て、必要なら開く。

---

## M0.5: `/tackle` にMonicaへの明示的signalを出させる

一番堅いのはこれです。

`setup_prompt` にこう書きます。

```text
/tackle

When you have created the implementation plan and need my approval, run:

monica issue mark "$MONICA_ID" need-approval --note "Plan is ready for approval"

When implementation is done and a PR is created, run:

monica issue mark "$MONICA_ID" pr-open --pr-url "<PR URL>"
```

これなら、自然言語の出力をhookで推測する必要がありません。

Claudeに状態を明示的に通知させる。

これが一番堅いです。

---

## M1: hookでlast messageやtranscriptを見て分類する

将来的には、

```text
Stop event
  → transcript / last assistant message を読む
  → need_approval / review / failed を分類する
```

もできます。

ただ、最初からここを頑張る必要はないです。

MVPでは、**Claudeに `monica issue mark` を呼ばせる** のが一番良いと思います。

---

# 15. 最初のstatus lifecycle

あなたの用途なら、最初はこれでいいです。

```text
inbox
ready
setting_up
running
need_approval
stopped
failed
pr_open
done
archived
```

それぞれの意味はこうです。

```text
inbox        = 作った/取り込んだが、まだ実行するか決めていない
ready        = 実行可能
setting_up   = worktree作成後、setup_shell実行中
running      = Claude Code session実行中
need_approval = Claudeがplan承認などを待っている
stopped      = Claudeが止まったが、意味分類はまだ曖昧
failed       = setup_shellやClaude実行で失敗
pr_open      = PRが作られている
done         = 完了
archived     = 非表示/保管
```

`review` は最初はなくてもいいかもしれません。

あなたの場合、`/tackle` がPRまで作るなら、状態としては

```text
running
need_approval
pr_open
done
```

が中心になるはずです。

---

# 16. PR作成機能は最初は作らなくていいかもしれない

これは前回から少し考えが変わりました。

前回は `monica pr` を提案しましたが、あなたの最新の話では `/tackle` がすでにPR作成までやってくれる。

それならM0でMonicaがPR作成機能を持つ必要は薄いです。

最初は、

```text
PRを作る = /tackleの責任
PRが作られたことを知る = Monicaの責任
```

でよいです。

Monicaはbranch名からPRを探して、

```bash
gh pr list --head <branch>
```

のように同期するだけでも十分です。

つまりM0の責務は、

```text
create PR
```

ではなく、

```text
detect PR
track PR
show PR status
```

です。

---

# 17. `monica issue status` は必須

これはMVPに必ず入れたいです。

たぶん最初に価値を感じるのはここです。

```bash
monica issue status
```

出力例はこうです。

```text
ID      PROJECT       GH ISSUE   STATUS         BRANCH                                   PR
MON-12  owner/repo    #123       need_approval  monica/gh-123-mon-12-project-registry    -
MON-13  owner/api     #88        running        monica/gh-88-mon-13-fix-auth             -
MON-14  owner/web     #91        pr_open        monica/gh-91-mon-14-add-filter           #95
```

この一覧が出るだけで、あなたの今の問題である

```text
どのTerminalで何が動いているかわからない
どのClaude Codeが終わったかわからない
どのissueが確認待ちかわからない
```

がかなり解消されます。

---

# 18. 私ならMVPをこう切る

「MVPとして一気に作る」のはありです。

ただし、1つの巨大PRにするのではなく、**1本のvertical sliceを複数issueに分ける**のが良いです。

MVPの完成形はこれです。

```text
monica project add owner/repo
monica issue track owner/repo#123
monica issue run MON-12 --claude
monica issue status
```

これが動けばMVPとして十分強いです。

---

# 19. 最初に切るIssue

## Issue 1: Project Registry

```text
[M0] Implement project registry
```

### Goal

```text
monica project add owner/repo でprojectを登録できる。
projectにはrepo path, default branch, worktree root, setup_shell, setup_promptを設定できる。
```

### Acceptance Criteria

```text
- monica project add owner/repo が動く
- monica project list が動く
- project configが保存される
- path, default_branch, worktree.root が設定できる
- setup.shell と setup.prompt が設定できる
```

---

## Issue 2: Monica WorkItem / Issue model

```text
[M0] Implement Monica issue model and ID generation
```

### Goal

```text
MON-1 のようなMonica IDを発行し、Monica issueをlocal DBに保存できる。
```

### Acceptance Criteria

```text
- MON-<number> のIDが発行される
- kind, status, title, body, project_id を保存できる
- external_refsを保存できる
- statusは inbox / ready / setting_up / running / need_approval / stopped / failed / pr_open / done を持てる
```

---

## Issue 3: Track GitHub Issue

```text
[M0] Implement monica issue track owner/repo#123
```

### Goal

```text
既存のGitHub IssueをMonica issueとしてtrackできる。
```

### Acceptance Criteria

```text
- monica issue track owner/repo#123 が動く
- GitHub Issueのtitle/body/urlを取得できる
- Monica IDが発行される
- external_refとしてGitHub Issueが保存される
- 初期statusはreadyにできる
```

ここは `new` より `track` をおすすめします。

---

## Issue 4: Run Issue with Worktree and Setup Shell

```text
[M0] Implement monica issue run MON-<id>
```

### Goal

```text
Monica issueからbranch/worktreeを作成し、setup_shellを実行できる。
```

### Acceptance Criteria

```text
- project configからrepo pathを解決できる
- branch_templateからbranch名を生成できる
- git worktreeを作れる
- statusがsetting_upになる
- setup_shellがworktree内で実行される
- 成功したらstatusがready_to_agentまたはrunningになる
- setup logが保存される
- 失敗したらstatusがfailedになる
```

---

## Issue 5: Run Claude with setup_prompt

```text
[M0] Implement monica issue run MON-<id> --claude
```

### Goal

```text
setup_shell成功後、project configのsetup_promptを使ってClaude Codeを起動できる。
```

### Acceptance Criteria

```text
- --claude でClaude Codeを起動できる
- setup_promptを初期promptとして渡せる
- MONICA_ID, MONICA_RUN_ID, MONICA_PROJECT_ID などのenvが渡される
- Claude用settings fileがrunごとに生成される
- statusがrunningになる
```

---

## Issue 6: Claude Hook Bridge

```text
[M0] Implement Claude Code hook bridge
```

### Goal

```text
Claude Code hooksからMonicaのissue/run statusを更新できる。
```

### Acceptance Criteria

```text
- monica hook claude がstdin JSONを受け取れる
- MONICA_ID / MONICA_RUN_ID をenvから読める
- SessionStartでrunningにできる
- Stopでstoppedにできる
- StopFailureでfailedまたはneed_interventionにできる
- SessionEndでstoppedにできる
- hook event logが保存される
```

---

## Issue 7: Issue Status

```text
[M0] Implement monica issue status
```

### Goal

```text
Monica issueとrunの状態を一覧できる。
```

### Acceptance Criteria

```text
- monica issue status で一覧が出る
- project, GitHub issue, status, branch, worktree, PRを表示できる
- statusでfilterできる
- projectでfilterできる
```

---

# 20. MVPとして一気に入れていい範囲

私はこの範囲ならMVPで一気に作っていいと思います。

```text
project add
project list
issue track
issue run --claude
setup_shell
setup_prompt
Claude hook bridge
issue status
```

これは広そうに見えますが、全部が同じvertical sliceに乗っています。

逆に、これはまだ入れないほうがいいです。

```text
Slack連携
scheduler
RSS
LLM Wiki
Kanban GUI
PR作成
merge automation
agent複数起動
高度な状態分類
```

今のMVPでは、

```text
GitHub IssueをClaude Code実行単位として安全に走らせ、状態を見えるようにする
```

に絞るべきです。

---

# 21. 最初のアーキテクチャ

私はこうします。

```text
~/.config/monica/projects.yaml
  - project registry
  - setup_shell
  - setup_prompt
  - branch_template

~/.local/share/monica/monica.db
  - work_items
  - runs
  - events
  - external_refs

~/.local/share/monica/runs/<run_id>/
  - setup.log
  - claude-settings.json
  - hook-events.jsonl
  - prompt.txt
```

設定はYAML。
状態はSQLite。
ログはファイル。

これが良いと思います。

JSONファイルだけでも始められますが、あなたの構想はすぐに

```text
status一覧
filter
scheduler
Slack intake
events
sessions
PR sync
```

が必要になるので、最初からSQLiteでよいと思います。

---

# 22. 具体的なコマンド体系案

最初はこれで十分です。

```bash
# project
monica project add owner/repo
monica project list
monica project edit owner/repo
monica project show owner/repo

# issue
monica issue track owner/repo#123
monica issue new owner/repo
monica issue show MON-12
monica issue status
monica issue mark MON-12 need-approval

# run
monica issue run MON-12 --claude
monica issue open MON-12
monica issue logs MON-12
```

`issue open` は、最初はworktree pathを表示するだけでもいいです。

```bash
cd ~/dev/.worktrees/repo/gh-123-mon-12-project-registry
```

あとでTerminal UIやtmux連携にできます。

---

# 23. いちばん重要な修正提案

あなたの案に対して、私が変えるならこの3つです。

## 1. `issue new owner/repo#123` ではなく `issue track owner/repo#123`

これはかなり強くおすすめします。

```bash
monica issue track owner/repo#123
```

のほうが意味が明確です。

---

## 2. 内部モデルは `issue` ではなく `work_item`

CLIは `issue` のままでよいです。

```bash
monica issue run MON-12
```

でもDBのテーブル名やコード内の中心モデルは、

```text
WorkItem
```

にする。

将来Slackやschedulerが入っても耐えられます。

---

## 3. `need-approval` はhook推測ではなく明示signalを優先する

`Stop` hookだけで「承認待ち」を判定するのは曖昧です。

なので、`setup_prompt` にこれを入れる。

```text
When you need my approval, run:
monica issue mark "$MONICA_ID" need-approval --note "Plan is ready"
```

これが一番堅いです。

---

# 24. 最終的な判断

あなたの方針は良いです。

特に、

```text
repo registryを最初に作る
setup_shellをprojectごとに持つ
setup_promptをprojectごとに持つ
/tackleをsetup_promptに入れる
issue runでworktreeとClaude Codeを起動する
hookで状態更新する
```

は、MonicaのMVPとしてかなり筋がいいです。

私ならM0をこう定義します。

> **Monica M0は、GitHub IssueまたはMonica Issueを、project registryに基づいてworktree化し、setup_shellで開発可能状態にし、setup_promptでClaude Codeを起動し、hookで状態を追跡できるCLIである。**

そして、最初に作るコマンドはこの4つです。

```bash
monica project add owner/repo
monica issue track owner/repo#123
monica issue run MON-12 --claude
monica issue status
```

これが動けば、Monicaはもうあなたの実際の開発フローに入り込めます。

[1]: https://code.claude.com/docs/en/cli-reference "CLI reference - Claude Code Docs"
[2]: https://code.claude.com/docs/en/hooks "Hooks reference - Claude Code Docs"
