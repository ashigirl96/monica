---
name: epic-worker
description: >-
  Epic の sub-issue を実装する Worker が、親の Epic Brief と情報をやり取りするための義務。
  `/tackle` が issue に親があると分かった時点で `epic-worker start`、実装中に人にしか
  できない作業や未知の前提に当たったら `epic-worker blocked`、`/create-pr` で PR を作った
  直後に `epic-worker pr` として呼ぶ。「epic に書き戻して」「親 issue に共有して」と
  言われたときも使う。親の無い issue では何もしない。
---

# epic-worker

sub-issue を実装する Worker は、親 epic の **Epic Brief** を読んで着手し、知ったことを epic に書き戻す。書き戻しは epic issue への **コメント** で行い、本文に畳むのは Orchestrator の仕事。呼ばれる瞬間は 3 つで、引数で示す。

| 引数 | 瞬間 |
|---|---|
| `start` | 着手時。Brief を読み、着手できるかを判定し、Epic context を返す |
| `blocked` | 実装中に Human Action・未知の前提・新しい依存に当たった瞬間 |
| `pr` | `/create-pr` が PR を作った直後。Verification の節、merge gate、書き戻し |

## 用語

- **Epic Brief**: epic issue 本文。Discovery・Human Action・Merge Gate・Fog を持つ。
- **Discovery**: 兄弟 sub-issue にも効く事実 1 行。例: 鍵の保管場所、外部 API の制約。
- **Human Action**: 人にしかできない作業 1 項目。Gate（`#N 着手前` / `#N merge 前`）を持つ。
- **Gate**: 依存の関門。`start-after-merged`（既定。上流が merge されるまで着手しない）と `merge-after-released`（並行して実装してよいが、上流が Released になるまで merge しない）。
- **Released**: 本番に出た状態。既定は default branch への merge。タグでリリースする repo は `.monica/epic-flow.md` に判定を宣言している。

## 共通: 親と repo ルールを確定する

```bash
gh issue view <this> --json number,title,parent --jq '{number, title, parent: .parent.number}'
```

- `parent` が null なら「親なし。epic-worker はここで終わる」と 1 行報告して呼び出し元に戻る。本文に `Part of #N` や `親 issue: #N` の文言だけがあるときは、`gh issue edit <this> --parent <N>` でリンクを張ることを提案する。リンクが無いと Orchestrator にはこの sub-issue が見えない。
- repo ルートに `.monica/epic-flow.md` があれば、その「Released の判定」に従う。無ければ default branch への merge を Released とする。形式は [../setup-monica/epic-flow-template.md](../setup-monica/epic-flow-template.md)。

## start

S1. Epic Brief を読む。本文と、minimize されていないコメントの両方。コメントの取り方は [../orchestrate/gh-recipes.md](../orchestrate/gh-recipes.md) の「epic 本文とコメント」。

S2. 自分に関わるものを抜き出す。

| 見る場所 | 抜き出すもの |
|---|---|
| `gh issue view <this> --json blockedBy` | 上流の一覧。各上流を `gh issue view <up> --json state,stateReason,closedByPullRequestsReferences` で見て、closed なら通過。open なら `closedByPullRequestsReferences` の各 `number` を `gh pr view <pr> --json state,mergedAt` で見て、merged かつ `stateReason` が `REOPENED` でなければ start gate 通過（`--json closedByPullRequestsReferences` は PR の番号と URL しか返さず、merged かは分からない。reopen された issue も merged PR を返し続ける）。Monica の `monica task run` が同じ規則で拒否しているので、ここで未達と出るのは `--force` で起動されたか、attach など Run を経ずに始めたとき |
| Brief の `## Merge Gate` | 自分が下流として出る行。上流が Released かを判定し、未 Released なら「PR は draft + `merge-gate` で出す」と控える |
| Brief の `## Human Action` | Gate が `#<this> 着手前` の未チェック項目（着手を止める）と、`#<this> merge 前` の未チェック項目（着手は止めないが R2 で PR を draft + `merge-gate` にする）。両方を控える |
| Brief の `## Discovery` と、コメントの `### Discovery` | 自分の実装に効く事実 |
| `gh issue view <epic> --json subIssues` | 兄弟の一覧。各兄弟の領分には踏み込まない |

S3. 判定して返す。start gate 未達、または `#<this> 着手前` の Human Action が未チェックなら、理由を報告して止まる。あなたが続行を指示したときだけ先へ進む。通れるなら Epic context を出して呼び出し元に戻る。

```
## Epic context — #<epic> <title>
- start gate: 上流 #A（merged、通過）
- merge gate: #A の Released 後に merge。現在 未 Released → PR は draft + merge-gate で出す
- 効く Discovery: 決済鍵は 1Password「<item>」に保管（#A）
- Human Action: 着手前 なし / merge 前 「本番鍵の発行」が未完 → PR は draft + merge-gate
- 兄弟: #B <title>、#C <title>
```

完了条件: 5 行すべてに値か「なし」が入っている。

## blocked

B1. 当たったものを 1 行にし、種類を決める。人にしかできない作業なら **Human Action**（Gate 付き）。分かった事実なら **Discovery**。他の issue が先に要ると分かったなら **依存**。

B2. 書き戻しコメントを書く（下の「書き戻しコメント」）。依存のうち、上流が merge されるまで着手できないもの（start-after-merged）だけ辺を張る。上流が Released になるまで merge しなければよいだけのもの（merge-after-released）は辺を張らない — 張ると start gate が着手を止め、並行して実装できなくなる。そちらはコメントの `### 依存` に書いて Orchestrator に Merge Gate へ入れてもらう。

```bash
gh issue edit <this> --add-blocked-by <upstream>
```

B3. あなたに報告する。何が要るか、依存せずに進められる部分、止まる部分。進められる部分から続ける。

完了条件: コメントに項目が載っていて、報告に「続ける部分」と「止まる部分」の区別がある。

## pr

`/create-pr` の直後に呼ぶ。PR 番号は `gh pr view --json number,url,body` で取る。

R1. **Verification の 3 節を PR 本文に揃える。** 見出しは固定で `## マージ前の確認` / `## マージ後の手順` / `## リリース後の確認`。この 3 つを本文に置き、各項目を `- [ ] <内容> — 条件: <いつ確認できるか>` の形で書く。項目が無い節は `- なし`。無い節は末尾に追記する。既にある節のうち、PR template のプレースホルダ行（`- [ ]  — 条件:` のように内容が空のもの）は残さず、実項目か `- なし` に置き換える — 空のまま残すと Orchestrator が条件不明の未完了 Verification として取り込み、epic が閉じられなくなる。人が書いた実項目はそのまま残す。書き戻しは `gh pr edit <PR> --body-file <path>`。

| 節 | 入れるもの | 条件の例 |
|---|---|---|
| pre-merge | merge の前に人か環境に必要なこと。他 repo の PR の先行 merge、環境変数の追加、外部サービス側の設定 | `即時`、`terraform 側 PR の merge 後` |
| post-merge | merge 直後に確認・実行すること。ステージングでの確認、backfill の実行 | `merge 後`、`ステージング反映後` |
| post-release | 本番で確認すること。cron の結果、本番の値、監視 | `Released 後`、`2026-09-16 14:00 以降` |

PR を作る前に自分で確かめたことは PR template の既存の動作確認の節に属する。この 3 節は「これから誰かが確かめること」だけを持つ。

R2. **merge gate を反映する。** 次のどちらかが残っていれば draft に戻し、ラベルを付ける — start で控えた merge-after-released の上流が今も未 Released、または Gate が `#<this> merge 前` の Human Action が未チェック（実装中に増えたものも含むので Brief を読み直す）。どちらも解けていれば ready のままでよい。解除は Orchestrator が行う。

```bash
gh pr ready --undo <PR>
gh label create merge-gate --color D93F0B --description "Waiting for the upstream sub-issue to be Released. Removed by the Orchestrator." 2>/dev/null
gh pr edit <PR> --add-label merge-gate
```

R3. **書き戻す。** 実装で知った Discovery、新たに判明した依存、merge や release までに人が要る Human Action を書き戻しコメントに載せる。依存の辺は B2 と同じ規則で、start-after-merged のものだけ `gh issue edit <this> --add-blocked-by <upstream>` で張る。載せるものが無ければコメントは書かない。

R4. 3 行で報告して呼び出し元に戻る。PR の URL、gate の状態（ready か draft + merge-gate か）、書き戻した項目数。

完了条件: 3 節が本文にあり、gate が反映され、コメントは「書いた」か「書くものが無い」のどちらかで報告されている。

## 書き戻しコメント

epic issue へのコメント。先頭行の目印を Orchestrator が読む。

```markdown
<!-- epic-worker: #<this> -->
### Discovery
- <事実 1 行>

### Human Action
- <内容> — Gate: <#N 着手前 | #N merge 前>

### 依存
- #<this> は #<upstream> の Released 後に merge（<理由>）
```

- 見出しは要るものだけ。1 項目 1 行。振る舞いと場所の名前で書き、着手までに日が空いても腐らない粒度にする。
- sub-issue あたり 1 本。minimize されていない自分のコメントがあれば編集し、無ければ作る。

```bash
# 自分のコメントを探す（先頭行が目印で isMinimized が false のもの）
# --paginate は必須。畳まれたコメントも connection に残るので、書き戻しが溜まった
# epic では自分の最新コメントが 2 ページ目以降に沈み、見落とすと 2 本目を作ってしまう
gh api graphql --paginate -f query='query($endCursor: String) { repository(owner: "<O>", name: "<R>") { issue(number: <epic>) {
  comments(first: 100, after: $endCursor) { nodes { databaseId isMinimized body } pageInfo { hasNextPage endCursor } } } } }' \
  --jq '.data.repository.issue.comments.nodes[] | select(.isMinimized == false and (.body | startswith("<!-- epic-worker: #<this> -->"))) | .databaseId'

# 無ければ作る
gh issue comment <epic> --body-file <path>

# あれば編集する
gh api -X PATCH repos/<O>/<R>/issues/comments/<databaseId> -F body=@<path>
```
