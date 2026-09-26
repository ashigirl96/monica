# `/tackle` の雛形

`.claude/skills/tackle/SKILL.md` に置く。`<…>` を repo の値で埋める。この雛形は Worker flow と Epic flow が `/tackle` に求める最小の骨格で、計画の観点やレビューの基準など repo 固有の手順は後から足す。

````markdown
---
name: tackle
description: >-
  GitHub Issue を端から端まで片付ける: ブランチ作成・計画・実装・テスト・レビュー・PR 作成。
  `/tackle <URL or #番号>` で起動。「この issue やって」「#16 を tackle」でも発火する。
  番号の代わりに機能説明テキストを渡すと、Issue を先に作ってから着手する。
---

# tackle

PR は Issue に書かれた scope を丸ごと含む。**1 PR = Issue の全 scope。** 分割は運用上の順序制約（先に本番へ出さないと次が壊れる）があるときだけで、計画の段階で `gh issue create --parent <N>` で sub-issue として切る。

## Step 1: Issue を作る（自由文が渡されたときだけ）

`.github/ISSUE_TEMPLATE/` の構成に沿って body を組み、タイトルと body を見せて確認を取り、`gh issue create` で作る。番号を控えて Step 2 へ。

## Step 2: Issue を読み、親を確かめ、ブランチを切る

1. 番号を解決する。引数が番号・`#N`・URL ならそれ。無ければ現在のブランチ名から取る。Monica の Run は `issue-<N>` という名前のブランチで `/tackle` を引数無しで起動するので、`^issue-[0-9]+$` は必ず受ける。取れなければ番号を求めて止まる。
2. `gh issue view <N> --json number,title,body,labels,comments` で読む。Out of Scope は scope を広げないための制約として守る。
3. `gh issue view <N> --json parent --jq .parent` で親を引く。親があれば `epic-worker` skill を `start` で呼び、返ってきた Epic context の制約の中で計画する。兄弟 sub-issue の scope には踏み込まない。
4. default branch 上なら `git pull` して `issue-<N>` でブランチを切る。別のブランチ上（Monica の worktree を含む）ならそのまま使う。

## Step 3: 計画する

`EnterPlanMode` で計画を立てる。ロジックを変えるならテストを含める。計画は次の checklist で終える。

```markdown
## Checklist

- [ ] 実装完了
- [ ] テスト通過（`<テストコマンド>`）
- [ ] lint / format 通過（`<lint コマンド>`）
- [ ] `/code-review` でレビュー、指摘を全て解消
- [ ] 動作確認（`<確認手段>`）
- [ ] `/create-pr` で PR 作成
- [ ] 親 issue がある場合 `epic-worker pr`
```

計画を見せて承認を得る。

## Step 4: 実装する

承認された計画に従う。ロジックが変わればテストを足し、`<テストコマンド>` で通す。

## Step 5: レビューと動作確認

`/code-review low --fix` を回し、指摘を全て解消する。動作確認は `<確認手段>` で行う。どちらも PR 作成の前。

## Step 6: checklist を順に消化する

1. テスト → 2. lint → 3. レビュー → 4. 動作確認 → 5. commit と push → 6. `/create-pr` → 7. 親 issue があれば `epic-worker pr`（Verification の 3 節・merge gate・epic への書き戻し）→ 8. `/watch-ci`。

ブランチ名が `issue-<N>` なら `/create-pr` が `close #<N>` を本文に入れ、merge 時に Issue が閉じる。
````

## 埋める値

| 置き換え           | 例                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------- |
| `<テストコマンド>` | `just test`、`pnpm test`、`cargo test`                                                |
| `<lint コマンド>`  | `just check`、`pnpm lint`                                                             |
| `<確認手段>`       | `just dev` で起動して操作、`agent-browser` でブラウザ確認、CLI なら該当コマンドの実行 |
