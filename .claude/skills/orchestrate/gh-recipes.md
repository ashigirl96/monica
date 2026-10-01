# gh の手順書

`gh` 2.94 以降を前提にする（`--parent` / `--blocked-by` と `parent` / `blockedBy` の JSON フィールドが入った版。`/setup-monica` 項目 1 と同じ）。`<O>` `<R>` は owner / repo、`<E>` は epic の issue 番号。

## 読む

### epic 本文とコメント（minimize 状態つき）

`gh issue view --json comments` は minimize 状態を返さないので GraphQL で取る。`id` はあとで minimize に使う node id。

```bash
gh api graphql --paginate \
  -f query='query($endCursor: String) {
  repository(owner: "<O>", name: "<R>") {
    issue(number: <E>) {
      id body
      comments(first: 100, after: $endCursor) {
        nodes { id databaseId isMinimized author { login } body url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}' --jq '.data.repository.issue'
```

`--paginate` を落とさないこと。畳んだコメントは minimize されるだけで connection に残るので、書き戻しが溜まった epic では最初の 100 件が全部 minimize 済みになり、未処理の Worker コメントが 2 ページ目以降に沈む。1 ページしか見ないと「書き戻しは無い」と誤って結論づける。

### sub-issue 一覧と、それぞれの依存・PR

1 クエリで揃う。`closedByPullRequestsReferences` が「その issue を閉じる PR」。`blockedBy` は GitHub が許す上限の 50 で取り切る（20 で切ると 21 件目以降の open な上流が見えず、blocked を着手可と誤判定する）。上流ごとに `state` / `stateReason` / 閉じる PR の `state` を持つので、epic の外にある上流でも start gate を判定できる。

```bash
gh api graphql -f query='query {
  repository(owner: "<O>", name: "<R>") {
    issue(number: <E>) {
      subIssues(first: 50) {
        nodes {
          number title state url
          assignees(first: 5) { nodes { login } }
          blockedBy(first: 50) {
            nodes {
              number state stateReason
              closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state } }
            }
          }
          closedByPullRequestsReferences(first: 5, includeClosedPrs: true) {
            nodes { number url state isDraft mergedAt mergeCommit { oid } labels(first: 10) { nodes { name } } }
          }
        }
      }
    }
  }
}' --jq '.data.repository.issue.subIssues.nodes'
```

### PR 本文

```bash
gh pr view <PR> --repo <O>/<R> --json body,state,isDraft,labels,mergeCommit,mergedAt,url
```

見出し 3 つ（固定: `## マージ前の確認` / `## マージ後の手順` / `## リリース後の確認`）の下の箇条書きを集める。`- [ ]` / `- [x]` が項目で、`- なし` はその節に項目が無いことを表す。各行は `- [ ] <内容> — 条件: <…>` の形を期待するが、`条件:` が無い行も項目として扱い、条件は「不明」とする。

そのどれでもない素の `- <内容>` 行は、**未チェック項目として数え**、かつ「形式違反の Verification 項目」として手順 8 の報告に出す。集計から落としてはいけない — 落とすとチェックボックスを付け忘れた PR が「Verification 項目ゼロ」に見え、手順 7 の提案 5（close 判定）が未確認のまま通る。この行はチェックを入れられないので、提案する手は確認の実行ではなく「PR 本文の該当行を `- [ ]` に直す」。

### Released の判定

- `.monica/epic-flow.md` が無い repo（既定）: `mergedAt` が非 null なら Released。
- タグでリリースする repo（`.monica/epic-flow.md` の「Released の判定」にパターンがある）: merge commit を含むリリースタグがあれば Released。

```bash
git fetch --tags --quiet
git tag --contains <mergeCommit.oid> | grep -E '<タグのパターン>'
```

### Monica の Task と Run

```bash
MONICA_HOME=$HOME/monica monica task status --project <O>/<R>
```

`--status` 無しは Closed archive 以外の全ての Task を返す（`stopped` や `ready` も含む）。落ちるのは closed だけで、closed の Task は Tick のどの判定も変えない — 生きている Run を持たないので「着手中」にはならず、close 済みなので close の対象にもならず、Task 無しとして track に回しても正しい手になる。`--status closed` は読まない（sub-issue ごとに絞れないので project の全履歴が返り、行数は単調に増え続ける）。

列は `ID / PARENT / PROJECT / GH ISSUE / STATUS / BLOCKED BY / BRANCH`。GH ISSUE 列で sub-issue と突き合わせる。STATUS は snake_case で出る。`setting_up` `prepared` `running` `waiting_for_user` のいずれかなら「生きている Run」。`in_progress` は Run の無い Task なので生きている Run には含めない。

BLOCKED BY は Monica の start gate がまだ塞いでいると見ている上流を `owner/repo#N` のカンマ区切りで示す（解消済みの上流は出ない。`-` なら gate は開いている）。これは前回 sync 時点の写しなので、手順 7 で GitHub から出した blocked 判定と食い違ったら `monica task sync MON-<n>` で写しを更新してから読み直す。

## 書く

### 本文を置き換える

読み直した本文を手元で編集してファイルに書き、`--body-file` で置き換える。触ってよいのは `## Discovery` / `## Human Action` / `## Merge Gate` / `## Verification` の 4 節だけで、追記は末尾に足す。既存行は消さない。追記する分が無い Tick は、このコマンドを打たない。

```bash
gh issue edit <E> --repo <O>/<R> --body-file <path>
```

### コメントを minimize する

```bash
gh api graphql -f query='mutation {
  minimizeComment(input: { subjectId: "<comment node id>", classifier: RESOLVED }) {
    minimizedComment { isMinimized }
  }
}'
```

### PR 本文のチェックボックスを入れる

本文を取り、該当行の `- [ ]` を `- [x]` にして書き戻す。

```bash
gh pr view <PR> --repo <O>/<R> --json body --jq .body > <path>
# 該当行を編集
gh pr edit <PR> --repo <O>/<R> --body-file <path>
```

### merge gate を解除する

```bash
gh pr ready <PR> --repo <O>/<R>
gh pr edit <PR> --repo <O>/<R> --remove-label merge-gate
```

### Worker を起動して Claim を立てる

```bash
MONICA_HOME=$HOME/monica monica task run MON-<n>
gh issue edit <sub-issue> --repo <O>/<R> --add-assignee @me
```

`task run` は起動の直前に対象 Task を 1 回 sync し、start gate を通す。上流が未完なら worktree を作らずに次で拒否する。

```
monica: task MON-<n> is blocked by <O>/<R>#<upstream>; land them first or force the run
```

拒否されたら assignee は立てず、その旨を報告する。`--force` は Orchestrator の判断では付けない。あなたが「gate を無視して起動して」と明示したときだけ `monica task run MON-<n> --force` を打つ（`--force` は sync も飛ばす）。

Task が無い sub-issue は先に track する。track は直後に対象 Task を 1 回 sync するので、続けて sync を打つ必要はない。同じ issue を再び track しても Task は二重にならない — ただし重複の判定は open な Task に対してだけで、前の Task が閉じている issue（例: 一度 done にして reopen した sub-issue）には新しい Task が作られる。これは仕様なので、closed の Task を気にせず track してよい。

```bash
MONICA_HOME=$HOME/monica monica task track <O>/<R>#<sub-issue>
```

## 作る（plan モード）

### sub-issue を作る

blocker になる issue から順に作る。`--blocked-by` は既に存在する issue しか指せないので、依存の下流ほど後に作る。

```bash
gh issue create --repo <O>/<R> --parent <E> --title "<title>" --body-file <path>
```

### 依存を張る

作成順で表せなかった辺は 2 パス目で張る。張るのは start-after-merged の依存だけ — GitHub の辺は種類を持てず、張れば必ず Monica の start gate として効くので、merge-after-released の依存に辺を張ると並行実装ができなくなる。そちらは Brief の `## Merge Gate` にだけ書く。

```bash
gh issue edit <downstream> --repo <O>/<R> --add-blocked-by <upstream>[,<upstream>]
```

### sub-issue 本文の形

```markdown
## 実現する振る舞い

<利用者から見て、これが終わると何ができるか>

## 受け入れ条件

- [ ] <観測できる条件>

## Blocked by

- #<upstream>（<gate: start-after-merged | merge-after-released>）
- なし（すぐ着手できる）
```

ファイルパスや行番号は書かない。着手までに日が空いても腐らない粒度で書く。

## `.monica/epic-flow.md` の形

タグでリリースする repo だけ `/setup-monica` が書く。形は [../setup-monica/epic-flow-template.md](../setup-monica/epic-flow-template.md)。
