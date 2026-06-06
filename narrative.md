# 2026-06-06

この文書は、Monicaの最終的なビジョンと、現時点の実装状況の両方を残すためのもの。
大きな構想は消さず、現在どこまでできているかは末尾の「15. 現在地」にまとめる。

## Personal Agentic Workspace for My Work, Learning, and Development

## 1. Monicaとは何か

**Monicaは、私の関心・知識・タスク・開発作業・エージェントの実行状態をひとつの作業空間に統合する、個人用のAgentic Workspaceである。**

単なるタスク管理ツールではない。
単なるIDEでもない。
単なるWikiでも、RSSリーダーでも、Slack botでもない。

Monicaは、私が日々考えたこと、読んだもの、任されたこと、作りたいもの、調べたいこと、実装したいことを受け取り、それを知識・タスク・計画・エージェント実行・成果物へと変換していくための環境である。

一言で言えば、

> **Monicaは、私とAIエージェントが一緒に仕事を進めるための、個人用Agent OSである。**

---

## 2. なぜMonicaを作るのか

現在の私は、主にGitHub IssuesとTerminal上のClaude Codeを使って開発を進めている。

この運用でも大きな問題はない。
ただし、実際には多くの手作業が発生している。

毎回Terminalからworktreeを作る。
Claude Codeを起動する。
特定のコマンドを実行する。
実装が終わったか確認する。
複数タブを見ながら、どのsessionが何をしているのか把握する。
必要なタイミングでClaude Codeに介入する。
Slackや記事やGitHub repoで見つけたアイデアを、あとで自分でタスク化する。

これらはすべて、開発そのものではなく、**開発を進めるための周辺管理**である。

AIエージェントが実装を進められるようになったことで、私の役割は少し変わってきている。
すべてを自分の手で書くのではなく、エージェントに作業を任せ、必要なところで判断し、介入し、レビューし、次の方向を決める役割が増えている。

そのためには、従来のIDEやタスク管理ツールだけでは足りない。

私に必要なのは、

> **人間である私と、Claude Codeのようなエージェントが、同じ作業状態を共有しながら進められる環境**

である。

Monicaはそのために作る。

---

## 3. Monicaの中心思想

Monicaの中心にあるのは、`Ticket` ではなく **Intent** である。

Intentとは、私の中に発生した「何かしたい」という意図のこと。

例えば、

- この記事を読みたい
- このrepoが気になる
- この機能を作りたい
- このbugを直したい
- Slackで言われたことをタスク化したい
- Claude Codeに調べさせたい
- 仕様を整理したい
- 実装を任せたい
- 実装結果を確認したい
- あとで知識として参照したい

こうした曖昧な入力を、Monicaは受け取る。

そして、それを必要に応じて以下の形へ変換していく。

```text
Intent
  → Note
  → Research
  → Proposal
  → Ticket
  → Agent Plan
  → Claude Code Session
  → Pull Request
  → Knowledge
  → Done
```

Monicaの本質は、私のIntentを、知識・タスク・実行・成果物へ変換することである。

---

## 4. Monicaが目指す世界

Monicaが完成に近づくと、私は朝起きてMonicaを開く。

そこには、今日見るべきものがまとまっている。

夜のうちに収集された記事。
気になるGitHub repo。
私の開発中のrepoに関係しそうな新しいアイデア。
Slackで拾われたタスク候補。
Claude Codeが実装を終えて確認待ちになっているticket。
途中で詰まっているsession。
私の判断が必要なもの。

私はそれらをキーボードでさばいていく。

読む。
保存する。
メモにする。
タスクにする。
Claude Codeに調査させる。
実装計画を作らせる。
実装させる。
Terminalを開いて中身を見る。
必要なら介入する。
完了したらレビューする。
知識として蓄積する。

この一連の流れが、ひとつのUIの中で自然につながっている。

Monicaは、私の仕事と学習と開発を分断しない。
記事を読むこと、repoを眺めること、Slackで話すこと、仕様を書くこと、ticketを作ること、Claude Codeに実装させること、Terminalで確認すること、PRを見ること、知識として残すことが、すべて同じ流れの中にある。

---

## 5. Monicaの主要な役割

## 5.1 Task Management

Monicaには、LinearのようなKanban boardがある。

ただし、これは単なるタスク管理ではない。
各ticketは、必要に応じてClaude Codeのsession、worktree、terminal、PR、note、関連repoと紐づく。

例えば、statusは人間の作業状態だけでなく、エージェントの状態も表す。

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

`Running` は、Claude Codeが実装中であることを表す。
`Need Approval` は、エージェントが私の判断を待っていることを表す。
`Need Intervention` は、sessionが変な方向に進んでいる、または詰まっている可能性があることを表す。

つまりMonicaのKanbanは、タスクの一覧ではなく、**私とエージェントの共同作業の状態管理画面**である。

---

## 5.2 Agent Orchestrator

Monicaは、Claude Codeのようなエージェントを起動し、監視し、状態を管理する。

理想的には、1つのticketに対して1つのClaude Code sessionを対応させる。

ticketを開始すると、Monicaは自動でworktreeを作成し、必要な初期コマンドを実行し、Claude Code sessionを起動する。
Claude Codeが実装を進める。
hookやログから状態を読み取り、完了したらticketを自動でReviewやNeed Approvalへ移動する。

私は毎回terminalを見に行かなくても、board上で状況を把握できる。

ただし、Monicaはエージェントを完全にブラックボックス化しない。
私は必要なときにsessionを開き、terminalで直接確認し、介入できる。

MonicaにおけるAgent Orchestratorは、エージェントを自動実行するためだけのものではない。
**エージェントの作業を人間が理解可能な形で管理するためのもの**である。

---

## 5.3 ADE: Agent Development Environment

MonicaにはTerminalとEditorが必要である。

Claude Codeが完全に私の望む通りに動くわけではない以上、私はsessionの中身を確認し、必要なタイミングで操作できなければならない。

MonicaのADEは、普通のIDEとは少し違う。

中心にあるのは「ファイル」だけではなく、`ticket`、`agent session`、`worktree`、`diff`、`command history`、`logs`、`notes` である。

例えば、あるticketを開くと、そこには以下がまとまっている。

```text
Ticket
  ├─ description
  ├─ related repo
  ├─ worktree
  ├─ Claude Code session
  ├─ terminal
  ├─ editor
  ├─ current diff
  ├─ test result
  ├─ PR
  ├─ notes
  └─ agent summary
```

私はboardからticketを開き、そのままterminalに入り、sessionを見て、editorで修正し、Claude Codeに追加指示を出し、PRまで確認できる。

MonicaのADEは、**エージェント時代の開発作業を前提にした作業環境**である。

---

## 5.4 Knowledge Base / LLM Wiki

Monicaは、私専用の知識ベースでもある。

記事、GitHub repo、Slack thread、調査メモ、実装メモ、設計判断、過去のticket、Claude Codeとのやり取りが蓄積される。

ただ保存するだけではない。

Monicaは、保存された情報を私の開発中のrepoや関心領域と紐づける。

例えば、私が気になるrepoを保存する。
Monicaはそのrepoを分析し、私の開発中のrepoとタグや機能単位で関連づける。
その上で、「このrepoにあるこの機能は、あなたのこのprojectにも応用できるかもしれない」と提案する。

そして、私が実装したいと思ったら、そのままticket化する。
ticket化されたら、Claude Codeが実装計画を作る。
私は承認する。
実装が始まる。

知識が、単なる読書ログで終わらない。
知識が、機能提案になり、タスクになり、実装につながる。

MonicaのWikiは、読むためのWikiではなく、**行動につながるWiki**である。

---

## 5.5 Information Intake

Monicaは、私のための情報収集レイヤーを持つ。

夜のうちにWebサイト、記事、GitHub repo、RSS的な情報源を巡回する。
朝、私はMonicaのdashboardを開いて、今日読むべきものを確認する。

この情報収集は汎用ニュースフィードではない。
私の関心、開発中のrepo、過去に保存した記事、作りたい機能、Slackで話していた話題に基づいて選ばれる。

つまりMonicaは、私にとって重要な情報を集める。

```text
Web
GitHub
RSS
Blogs
Papers
Docs
Slack
Personal notes
```

これらを集約し、読むべきもの、保存すべきもの、タスク化すべきもの、調査すべきものに分類する。

Monicaの情報収集は、単に「面白い記事を集める」ためではない。
**私の学習と開発を前に進めるための情報を集める**ためにある。

---

## 5.6 Slack / Conversation Intake

Monicaは、Slackのような会話空間にも入り込む。

友人と「こういう機能ほしいな」と話しているthreadでMonicaを呼び出す。
Monicaはそのthreadの文脈を読み、関連情報を調べ、機能案を整理し、必要ならticket化する。

会社のSlackで上司が「これやって」と言った場合も、Monicaがそれを拾う。
私に対して、「こういう依頼が来ていた」と通知する。
内容を整理し、タスク候補として出す。
必要なら説明を読みやすくし、実行可能なticketに分解する。

Slack上の会話は、そのままだと流れていく。
Monicaは、流れていく会話からIntentを拾い上げる。

会話を、知識・タスク・調査・実装につなげる。

---

## 6. MonicaのUI原則

MonicaのUIは、すべてキーボードで操作できるべきである。

私はvimライクな操作を好む。
そのため、Monicaはmouse-firstではなく、keyboard-firstである。

重要なのは、速く操作できることだけではない。
思考を中断しないことが重要である。

Monicaでは、以下のような操作が自然にできる。

```text
j/k で移動
enter で開く
cmd/ctrl+k でcommand palette
/ で検索
g b でboard
g i でinbox
g t でterminal
g w でwiki
g r でrepo
a でagent action
m でmove
n でnote
c でcreate ticket
```

すべての機能は、command paletteから呼び出せる。
すべての画面は、キーボードで移動できる。
すべてのobjectは、検索できる。

MonicaのUIは、見た目の美しさだけでなく、**私の思考速度に合わせて操作できること**を重視する。

---

## 7. Monicaの中核オブジェクト

Monicaの中には、いくつかの重要なオブジェクトがある。

### Intent

私の「やりたい」「気になる」「任された」「調べたい」という入力。

### Ticket

実行可能な作業単位。
Kanban上に表示され、agent sessionやrepoと紐づく。

### Agent Session

Claude Codeなどのエージェントによる作業単位。
ticket、worktree、terminal、logs、diffと紐づく。

### Repo

開発対象、または参考対象のrepository。
自分のrepoと気になるrepoの両方を扱う。

### Note

調査メモ、設計メモ、学習メモ、実装メモ。

### Source

記事、Slack thread、GitHub issue、PR、Webページ、RSS itemなど、Intentの元になった情報。

### Proposal

知識やrepo分析から生成される機能提案。

### Review

エージェントの出力に対して私が判断する場所。
diff、test、summary、risk、remaining questionsなどを含む。

---

## 8. Monicaの基本フロー

Monicaの理想的な流れはこうである。

```text
1. 情報が入る
   - Slack
   - Web
   - GitHub
   - RSS
   - 手入力
   - Terminal
   - Notes

2. MonicaがIntentとして受け取る

3. Monicaが分類する
   - 読む
   - 保存する
   - 調べる
   - タスク化する
   - 実装する
   - 後で見る
   - 無視する

4. 必要ならticketに変換する

5. ticketにrepo、worktree、agent sessionを紐づける

6. Claude Codeが作業する

7. Monicaが状態を監視する

8. 私が必要なところで介入・承認・レビューする

9. 成果物がPRやpatchになる

10. 結果がknowledge baseに蓄積される
```

この流れによって、Monicaは私の日々の入力を、実際の成果に変換していく。

---

## 9. Monicaが大事にすること

## 9.1 Personal First

Monicaは万人向けのSaaSではない。

まずは私のためのツールである。
私の作業スタイル、私の開発環境、私のkeybinding、私の情報源、私のrepo、私の思考の癖に最適化する。

機能が増えてもよい。
それが私にとって必要なら問題ない。

kitchen sinkになることを恐れすぎない。
ただし、中心思想を失わない。

中心にあるのは常に、

> **私のIntentを、知識・タスク・実行・成果物に変換すること**

である。

---

## 9.2 Human-in-the-loop

Monicaは、すべてを自動化するためのツールではない。

むしろ、私が見るべきところだけを見られるようにするためのツールである。

エージェントに任せるところは任せる。
でも、判断が必要なところは私に返す。
怪しい挙動があれば見えるようにする。
Terminalにも入れる。
diffも見られる。
sessionもforkできる。
仕様も質問できる。

Monicaは、私を作業から排除しない。
私をより重要な判断に集中させる。

---

## 9.3 Agent-native

Monicaは、後からAIを足したタスク管理ツールではない。

最初から、エージェントが作業することを前提に設計する。

ticketにはagent sessionが紐づく。
statusにはagent stateが含まれる。
terminalはagent作業の観察と介入のために存在する。
knowledge baseはagentが参照し、更新する。
Slack threadや記事はagentによって調査・整理・提案へ変換される。

Monicaは、**AIエージェントが実際に作業者として存在する前提のworkspace**である。

---

## 9.4 Knowledge-to-Action

Monicaにおける知識は、保存されるだけでは不十分である。

記事を読んだ。
repoを保存した。
Slackで話した。
メモを書いた。

そこで終わりではない。

それらが、私のprojectにどう関係するのか。
何を学ぶべきか。
何を作れるのか。
どのticketに変換できるのか。
どのagentに任せられるのか。

Monicaは、知識を行動に変える。

---

## 9.5 Keyboard-native

Monicaは、キーボード操作を第一級の操作方法として扱う。

mouseで使えるだけでは足りない。
すべての主要操作がkeyboardで完結する必要がある。

Monicaは、vim的な移動、command palette、fuzzy search、quick actionを中心にしたUIである。

---

## 10. Monicaが解決する問題

Monicaが解決したい問題は、「タスクが多い」ことだけではない。

本当の問題は、私の作業が複数の場所に分散していることである。

```text
GitHub Issues
Terminal tabs
Claude Code sessions
Slack threads
Web articles
Saved repos
Notes
PRs
Worktrees
Local commands
Personal ideas
```

これらが別々に存在しているため、私は常に自分でつなぎ直している。

Monicaは、それらをひとつの作業グラフとして扱う。

```text
Slack thread
  → Intent
  → Ticket
  → Repo
  → Worktree
  → Claude Code session
  → Diff
  → PR
  → Note
  → Knowledge
```

この接続がMonicaの価値である。

Monicaは、情報を一箇所に集めるだけではない。
情報同士をつなぎ、作業を前に進める。

---

## 11. Monicaの理想的な利用シーン

## 朝

Monicaを開く。

今日読むべき記事が並んでいる。
夜の間に発見されたrepoがある。
Claude Codeが完了したticketがNeed Approvalにある。
Slackから拾われたタスク候補がInboxにある。

私はキーボードで確認していく。

読む。
保存する。
捨てる。
タスク化する。
Claude Codeに調査させる。

---

## 開発中

Boardを見る。

Runningのticketがいくつかある。
それぞれにClaude Code sessionが紐づいている。

ひとつのticketがNeed Interventionになっている。
開くとterminalとlogが見える。
Claude Codeが仕様を誤解している。
私はその場で指示を追加する。
必要ならsessionをforkして別の質問をする。

別のticketはReviewに移動している。
diff、test result、agent summaryを確認する。
問題なければPRへ進める。

---

## Slack上

友人と新しい機能について話している。

Monicaをthreadに呼ぶ。
Monicaは文脈を読み、関連する技術やrepoを調べ、機能案として整理する。
私はそれをMonicaのInboxに送る。

会社のSlackで上司から作業依頼が来る。
Monicaが拾う。
「この依頼が来ている」と私に通知する。
内容を整理し、実行可能なticket案を作る。

---

## 学習中

気になる記事を読む。

Monicaは要点を保存する。
関連する自分のrepoや過去のticketとリンクする。
「このアイデアはこのprojectに応用できる」と提案する。

私はそれをticket化する。
Claude Codeが実装計画を作る。
必要ならそのまま実行する。

学習が、実装につながる。

---

## 12. Monicaを一文で表すなら

> **Monica is my personal agentic workspace that captures my intents, organizes them into knowledge and tasks, executes them through agents and terminals, and brings me back in when judgment is needed.**

日本語では、

> **Monicaは、私の関心・会話・知識・タスクを取り込み、エージェントとTerminalを通じて実行し、判断が必要なところだけ私に返す、個人用Agentic Workspaceである。**

---

## 13. Monicaのプロダクトタグライン候補

### 一番素直なもの

> **Monica — Personal Agentic Workspace**

### 少し強いもの

> **Monica — Your Personal Agent OS**

### 開発者向けに説明しやすいもの

> **Monica — Linear, Terminal, Claude Code, and Knowledge Base in one personal workspace**

### 世界観が伝わるもの

> **Monica — Where my ideas, agents, and code come together**

### 日本語

> **Monica — 私とエージェントが一緒に働くための個人用ワークスペース**

---

## 14. 最終的なビジョン

Monicaは、私が日々触れている情報、会話、アイデア、repo、issue、terminal、Claude Code sessionを、ひとつの作業空間に統合する。

私はMonicaを開けば、自分が何を読むべきか、何を作るべきか、何を確認すべきか、どのエージェントが何をしているか、どこに介入すべきかがわかる。

Monicaは、情報を集めるだけではない。
タスクを管理するだけでもない。
エージェントを走らせるだけでもない。
コードを書く場所だけでもない。

Monicaは、私のIntentを中心に、知識、タスク、開発環境、エージェント実行、会話、学習をつなぐ。

その結果、私は「何をやるべきかを探す時間」や「状態を確認する時間」から解放され、より高いレベルの判断、設計、学習、創造に集中できる。

Monicaは、私専用の作業OSである。
私のためのLinearであり、Claude Code cockpitであり、Terminal workspaceであり、Obsidianであり、Slack assistantであり、RSS readerである。

しかし、それらの寄せ集めではない。

Monicaの本質は、

> **私とエージェントが、同じ文脈を共有しながら、知識を行動に変えていくためのPersonal Agentic Workspace**

である。

---

## 15. 現在地: Issue RunnerとしてのMonica

Monicaを最初から“全部入りアプリ”として作るのではなく、まずは **GitHub Issueを実行可能なagent taskに変換するIssue Runner** として作る。

この方針はすでにコードにも反映されている。
現時点のMonicaは、最終ビジョン全体のうち、以下の核が実装済みである。

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

つまり今できているのは、SlackやRSSやKnowledge Baseを含むPersonal Agentic Workspace全体ではなく、**GitHub Issueを起点に、repoごとの実行環境を用意し、Claude Codeに渡し、状態をMonica側で追跡するところまで**である。

### 15.1 実装済みのもの

Rust側は `monica-core`、`monica-infra`、`monica-cli`、`monica-app` に分かれている。
`monica-core` はドメインモデル、ユースケース、interface traitを持ち、SQLite、GitHub、Git、filesystem、process、Keychainなどの具体実装は `monica-infra` に寄せている。

永続化はSQLiteで動いている。
現在のDBには、project registry、task、task run、event、external ref、GitHub Pull Request同期状態が保存される。
task本体のstatusは `inbox`、`ready`、`in_progress`、`done`。
run側のstatusは `setting_up`、`running`、`waiting_for_user`、`stopped`、`failed`。
DashboardやCLIの表示では、task statusとrun statusを合成して現在の作業状態を見せる。

CLIでは以下が実装済み。

- `monica project init [owner/repo]`
- `monica project list`
- `monica project show <owner/repo> [--json]`
- `monica project set <owner/repo> <key> <value>`
- `monica auth github login`
- `monica auth github status`
- `monica auth github logout`
- `monica issue track <owner/repo#123>`
- `monica issue status [--status <status>] [--project <owner/repo>]`
- `monica issue run <MON-id> [--claude | --agent claude]`
- `monica issue run <MON-id> --claude --continue`
- `monica issue run <MON-id> --claude --fork <session-id>`
- `monica issue mark <MON-id> <status> [--note <text>]`
- `monica issue delete <MON-id>`
- `monica hook claude`
- `monica completions zsh`

GitHub認証はGitHub App device flowで実装されている。
GitHub CLIのtoken storageは読まず、Monica専用のtokenをKeychainに保存する。
開発用には `MONICA_GITHUB_TOKEN` の一時overrideも使える。
DashboardはGitHub未認証状態を表示し、未認証時はPR同期処理を行わない。

`monica project init` はrepo registryを作る。
owner/repoは引数で渡せるし、未指定なら `git remote get-url origin` から検出する。
default branchもローカルの `origin/HEAD` またはGitHub APIから拾う。
さらにrepo直下に `.monica/setup.sh` と `.monica/prompt.md` を雛形として作る。

`.monica/setup.sh` はworktree起動時の初期化用で、例えば `pnpm install` のようなidempotentなセットアップを想定している。
`MONICA_TASK_ID`、`MONICA_TASK_RUN_ID`、`MONICA_PROJECT_ID`、`MONICA_BRANCH`、`MONICA_WORKTREE` などのenvを受け取れる。
実行ログはrun artifactとして保存され、timeoutやexit codeもrun statusに反映される。

`.monica/prompt.md` はagentの初回プロンプト置き場で、現状の雛形は `/tackle` を入れている。
`monica issue run --claude` ではこのpromptをClaude Codeに渡す。

`monica issue track <owner/repo#123>` はGitHub Issueを取得し、Monicaのtaskとして保存する。
taskには `MON-<n>` のIDが採番され、GitHub Issueのtitle/body/urlと外部参照が保存される。
該当repoがproject registryに登録済みなら、そのprojectにも紐づく。
取り込まれたtaskは `ready` から始まる。

`monica issue run <MON-id>` は、project registryからrepoの実行環境を解決し、Git worktreeを作る。
GitHub Issueに紐づくtaskならbranchは `issue-<issue-number>`、issueがないtaskなら `mon-<MON-number>` になる。
worktreeは通常 `<repo>/.worktrees/<branch>` に作られる。
その後 `.monica/setup.sh` を実行し、run artifactを作り、必要ならClaude Codeを起動する。

Claude Code起動時には、hook設定入りの `claude-settings.json` と `prompt.txt` がrun artifactとして生成される。
`monica hook claude` はClaude Codeのhook callbackを受け取り、SQLiteのevent timelineと `hook-events.jsonl` に保存する。
`SessionStart`、`UserPromptSubmit`、`Stop`、`StopFailure`、`SessionEnd` などでrun statusを更新する。
また `AskUserQuestion` や `ExitPlanMode` の `PreToolUse` を `waiting_for_user` として検出できる。

Tauri app側には、Status Dashboardが実装されている。
現在のUIは、完全なKanban boardではなく、status rail付きのtask listである。
taskの一覧、status別filter、詳細drawer、event timeline、GitHub Issue/PRリンク、PR status badge、削除modal、GitHub auth警告がある。
task一覧は3秒ごとにpollingされ、Tauri command経由でSQLiteを読む。

Dashboard上の操作としては、以下ができる。

- statusごとの件数を見る
- task listを開く
- task詳細でproject、issue、branch、PR、phase、created/updated、body、event timelineを見る
- GitHub Issueをブラウザで開く
- linked PRをブラウザで開く
- taskを削除する
- GitHub未認証状態を確認する
- `mod+1`、上下移動、`enter`、`escape`、`mod+d`、spaceなどの基本キーボード操作を使う

PR同期も一部実装済みである。
Tauri app起動中、GitHub認証がある場合は定期的にPR同期workerが動く。
runのbranchからGitHub PRを探し、PR番号、URL、`draft` / `open` / `closed` / `merged` の軽量状態をSQLiteに保存し、Dashboardに表示する。

### 15.2 まだ実装していないもの

以下は、ビジョンとしては残すが、現時点では未実装または部分実装である。

- 完全なKanban board
- command palette
- `/` での全体検索
- `g b`、`g i`、`g t`、`g w`、`g r` のような画面遷移keybinding
- Tauri UIからの `project init` / `issue track` / `issue run`
- Dashboard上でのClaude Code session起動・停止・再接続
- app内terminal
- app内editor
- diff viewer
- test result viewer
- agent summary表示
- PR作成flow
- review画面
- top-levelの `monica start`、`monica status`、`monica review`、`monica pr`
- multi-repo dashboard
- Slack / conversation intake
- Web / RSS / article intake
- GitHub repo recommendation
- Note
- Source
- Proposal
- Knowledge Base / LLM Wiki
- IntentからNote/Research/Proposal/Ticketへ分類するinbox
- 保存された知識をrepoやtaskへ自動で関連づける仕組み
- 朝見るべきものをまとめるdaily dashboard

特に、現在のMonicaはまだ「情報収集アプリ」ではない。
Slack、RSS、Web記事、GitHub repo recommendation、Knowledge Baseはまだ実装の中心には入っていない。
これらは、Issue RunnerとStatus Dashboardが安定した後に拡張していく。

### 15.3 今の基本フロー

現時点で想定している実際の使い方はこうである。

```bash
cd /path/to/repo
monica project init owner/repo
monica auth github login
monica issue track owner/repo#123
monica issue status
monica issue run MON-1 --claude
```

この流れで、GitHub IssueがMonica taskになり、repo registryに基づいてworktreeが作られ、setup scriptが実行され、Claude Codeが起動し、hookによってrun statusとeventがMonica側に残る。
Tauri appを開けば、そのtaskとrunの状態をDashboardで確認できる。

### 15.4 次に伸ばす順序

当面のロードマップは、引き続き以下の順序で考える。

```text
Issue Runner
→ Session Tracker
→ Status Dashboard
→ Kanban Board
→ Terminal/ADE
→ Multi-repo Dashboard
→ Slack Intake
→ Knowledge Base
→ RSS / Repo Recommendation
```

ただし、すでにIssue Runner、Session Tracker、Status Dashboardの一部は実装済みである。
次は、Dashboardから実行に介入できる範囲を増やし、CLIに残っている未実装の `review` / `pr` 系flowを具体化するのが自然である。
