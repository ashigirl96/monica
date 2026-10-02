# Issue tracker: GitHub

このリポジトリの issue と spec は GitHub Issues で管理する。操作はすべて `gh` CLI で行う。

## 規約

- **issue を作る**: `gh issue create --title "..." --body "..."`。複数行の本文は heredoc を使う。
- **issue を読む**: `gh issue view <number> --comments`。コメントは `jq` で絞り込み、ラベルも併せて取得する。
- **issue を一覧する**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`。必要に応じて `--label` と `--state` で絞る。
- **issue にコメントする**: `gh issue comment <number> --body "..."`
- **ラベルを付ける / 外す**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **閉じる**: `gh issue close <number> --comment "..."`

リポジトリは `git remote -v` から推定する。clone 内で実行すれば `gh` が自動で解決する。

## Pull request を triage の対象にするか

**PRs as a request surface: no.** _(外部からの PR を機能要望として扱うリポジトリなら `yes` にする。`/triage` がこのフラグを読む。)_

`yes` の場合、PR も issue と同じラベルと状態で扱い、`gh pr` 系のコマンドを使う。

- **PR を読む**: `gh pr view <number> --comments`。diff は `gh pr diff <number>`。
- **triage 対象の外部 PR を一覧する**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` を実行し、`authorAssociation` が `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`NONE` のものだけ残す（`OWNER` / `MEMBER` / `COLLABORATOR` は除く）。
- **コメント / ラベル / クローズ**: `gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub では issue と PR が同じ番号空間を共有するので、裸の `#42` はどちらの可能性もある。`gh pr view 42` を試し、失敗したら `gh issue view 42` にフォールバックする。

## スキルが「issue tracker に publish する」と言ったら

GitHub issue を作成する。

## スキルが「該当するチケットを取得する」と言ったら

`gh issue view <number> --comments` を実行する。

## Wayfinding の操作

`/wayfinder` が使う。**map** は 1 つの issue で、チケットは **child** issue として紐づける。

- **Map**: `wayfinder:map` ラベルの付いた 1 つの issue。本文に Notes / Decisions-so-far / Fog を持つ。`gh issue create --label wayfinder:map` で作る。
- **Child チケット**: map に GitHub sub-issue として紐づけた issue（sub-issues エンドポイントに `gh api`）。sub-issues が使えない場合は、map 本文の task list に child を追加し、child 本文の先頭に `Part of #<map>` を書く。ラベルは `wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）。claim されたチケットは担当の dev に assign する。
- **Blocking**: GitHub の **native issue dependencies** を正とする。UI でも見える表現になる。`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` で辺を追加する。`<blocker-db-id>` は blocker の数値の **database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`）であり、`#number` や `node_id` ではない。GitHub は `issue_dependencies_summary.blocked_by`（open な blocker のみ。これが生きたゲート）を返す。dependencies が使えない場合は、child 本文の先頭に `Blocked by: #<n>, #<n>` の行を書いてフォールバックする。すべての blocker が closed になったらチケットは unblocked。
- **Frontier の問い合わせ**: map の open な child を一覧し（`gh issue list --state open` を map の sub-issues / task list に絞る）、open な blocker を持つもの（`issue_dependencies_summary.blocked_by > 0`、または `Blocked by` 行に open な issue がある）と assignee のいるものを除く。map 上の順で最初のものを選ぶ。
- **Claim**: `gh issue edit <n> --add-assignee @me`。セッション最初の書き込み。
- **Resolve**: `gh issue comment <n> --body "<answer>"`、次に `gh issue close <n>`、最後に map の Decisions-so-far に context pointer（gist とリンク）を追記する。
