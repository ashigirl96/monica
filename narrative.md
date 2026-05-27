# 2026-05-27

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

Monicaを“全部入りアプリ”として作るのではなく、GitHub Issueを実行可能なagent taskに変換するIssue Runnerとして作る。

Issue Runner
→ Session Tracker
→ Status Dashboard
→ Kanban Board
→ Terminal/ADE
→ Multi-repo Dashboard
→ Slack Intake
→ Knowledge Base
→ RSS / Repo Recommendation

私のユースケースに合うように考え直してみた。
最初に、repo registryの作成は必須。
今は `monica project init [owner/repo]` で repo registry を作りつつ、その repo 直下に `.monica/setup.sh` と `.monica/prompt.md` を雛形として置く形になっている。
`setup.sh` は worktree 起動時の初期化用で、例えば `pnpm install` のような idempotent なセットアップを想定している。
`prompt.md` は agent の初回プロンプト置き場で、現状の雛形は `/tackle` を入れている。

次にあるのは、

`monica issue track <owner/repo#123>`

で GitHub Issue を Monica の work item として取り込む流れ。
この時点で owner/repo に紐づく WorkItem が作られて、Monica の ID が採番される。
一覧は `monica issue status` で見える。

まだ未実装だけど、次の段階では `monica start <...>` が worktree 作成と agent 起動の入口になる想定。
CLI には `start` / `status` / `review` / `pr` の枠はもうあるが、現状はプレースホルダで、実体はこれから入れていく。

さっきも話したけど、`/tackle` のような flow でユーザー承認待ちまで来たら、そこで Monica 側の status を `need-approval` 系へ遷移させたい。
そのため、Claude Code hook と issue status 更新の橋渡しも早い段階で仕込みたい。

1. <concept>で話していたけど、issue trackerって概念になってるけど、issueであってる？intentとかの方がいい？このあと、schedulerとか、Slackから来たメッセージで作られたりするこのデータモデルが本当にissueであってるのか不安になった。kind: "issue" でもいいかもしれないけど
2. 上のユースケースを考えているけど、合ってそう？ repo registryを最初に作る予定だけど、その後のはMVPとして一気に作っちゃおうかなって思う
