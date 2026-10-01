---
name: setup-monica
description: この repo を Monica の Worker flow と Epic flow で使えるように点検し、足りないものを揃える。初回に 1 度、以後は点検したいときに実行する。
disable-model-invocation: true
---

# setup-monica

`/tackle`・`/orchestrate`・`epic-worker` が前提にしている repo 側と手元側の状態を点検し、欠けているものを、あなたの確認を取ってから揃える。決め打ちのスクリプトではなく、探索して報告し、確認して書く。

## 点検項目

| #   | 項目                                                     | 確認                                                                                                                                                                                                                          | 直し方                                                                                                                                      |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `gh` が 2.94 以降                                        | `gh --version`。`--parent` と `--blocked-by` を使うため                                                                                                                                                                       | `brew upgrade gh` を案内                                                                                                                    |
| 2   | `gh` が認証済み                                          | `gh auth status`                                                                                                                                                                                                              | `gh auth login` を案内                                                                                                                      |
| 3   | repo が Monica に登録済み                                | `MONICA_HOME=$HOME/monica monica project list` にこの repo の行がある                                                                                                                                                         | `MONICA_HOME=$HOME/monica monica project init`                                                                                              |
| 4   | 登録の default branch が実際と一致                       | `monica project list` の BRANCH 列と `gh repo view --json defaultBranchRef`                                                                                                                                                   | `monica project set`                                                                                                                        |
| 5   | `.monica/` が git で追跡されている                       | `git check-ignore -v .monica` が何も返さず、`git ls-files .monica` に `prompt.md` と `setup.sh` が並ぶ。`project init` の直後は ignore されていなくても未追跡のことがあり、その場合 Run の worktree にファイルが降りてこない  | ignore されているなら `.gitignore` から除く。未追跡なら `git add .monica` してコミットを促す                                                |
| 6   | `.monica/prompt.md` が `/tackle`                         | 中身が `/tackle` の 1 行。`project init` は空で作る                                                                                                                                                                           | `/tackle` を書く                                                                                                                            |
| 7   | `.monica/setup.sh` が実行可能で冪等                      | `test -x`、先頭に `set -euo pipefail`。中身は repo 固有なので目視で報告                                                                                                                                                       | `chmod +x`、雛形は `project init` が作る                                                                                                    |
| 8   | Released の判定が既定と違うなら宣言がある                | 既定は default branch への merge で、その repo にはファイルは要らない。タグでリリースする repo には `.monica/epic-flow.md` に「Released の判定」の節があり、タグのパターンが書かれている                                      | 質問して [epic-flow-template.md](epic-flow-template.md) から書く。既定で済むなら書かない                                                    |
| 9   | `.claude/skills/tackle/SKILL.md` がある                  | repo 固有の `/tackle`                                                                                                                                                                                                         | [tackle-template.md](tackle-template.md) から雛形を置き、repo 固有部分をあなたが埋める                                                      |
| 10  | `/tackle` が `epic-worker` を 2 箇所で呼ぶ               | 本文に `epic-worker` の `start`（親の確認の直後）と `pr`（`/create-pr` の直後）がある                                                                                                                                         | 該当行の追加を差分で示す                                                                                                                    |
| 11  | `issue-<N>` ブランチを `/tackle` と `create-pr` が扱える | Monica は Run のブランチを必ず `issue-<N>` と名付け、`/tackle` を引数無しで起動する。`/tackle` が引数無しのとき `issue-<N>` から番号を取れること、到達できる `create-pr` が `issue-<N>` から `close #N` を推定することの 2 点 | 足りない側の skill を直す差分を示す                                                                                                         |
| 12  | `create-pr` に到達できる                                 | repo の `.claude/skills/create-pr` か `~/.claude/skills/create-pr`                                                                                                                                                            | 無ければ monica repo のものを symlink                                                                                                       |
| 13  | PR template が 3 節を持つ                                | `.github/PULL_REQUEST_TEMPLATE.md`（大文字小文字どちらか）に、固定の見出し `## マージ前の確認` / `## マージ後の手順` / `## リリース後の確認` がチェックボックス形式で並ぶ                                                     | 3 節を追記する差分を示す                                                                                                                    |
| 14  | `merge-gate` ラベルがある                                | `gh label list`                                                                                                                                                                                                               | `gh label create merge-gate --color D93F0B --description "Waiting for the upstream sub-issue to be Released. Removed by the Orchestrator."` |
| 15  | sub-issue と依存が使える                                 | 任意の issue に対し `gh issue view <n> --json parent,blockedBy` がエラーなく返る                                                                                                                                              | 使えない場合は Epic flow が成立しないと報告する                                                                                             |
| 16  | 手元の汎用 skill が揃っている                            | `~/.claude/skills/{orchestrate,epic-worker,track-issue,attach-task}` が存在し、symlink なら先が実在する                                                                                                                       | 切れている symlink は報告して削除を提案。無いものは monica repo から symlink                                                                |
| 17  | issue template がある                                    | `.github/ISSUE_TEMPLATE/` に 1 つ以上。`/tackle` が自由文から issue を作るときに使う                                                                                                                                          | 任意。無ければ報告のみ                                                                                                                      |

## 手順

### 1. 探索する

点検項目を上から順に確かめ、結果を「OK / 要修正 / 任意」の 3 値で持つ。読んで分かることは読み、推測で埋めない。

完了条件: 17 項目すべてに 3 値のどれかが付いている。

### 2. 報告して、節ごとに聞く

まず表で結果を見せる。次に「要修正」のうち、あなたの判断が要るものだけを節に分けて聞く。各節は推奨を先頭に置き、一言で受けられる形にする。探索で決まっていれば節ごと飛ばす。

**A. Released の判定**（タグでリリースしている形跡があり、`.monica/epic-flow.md` が無いとき）

> 推奨: 「merge commit を含む `<パターン>` タグ」。既定の「default branch への merge」で正しい repo には何も書かない。

`git tag --list | tail` と CI やデプロイ設定を見て、タグでリリースしている形跡があるときだけ聞く。形跡が無ければ既定で確定し、この節は飛ばす。

**B. `/tackle` の雛形**（項目 9 が要修正のとき）

> 推奨: [tackle-template.md](tackle-template.md) を `.claude/skills/tackle/SKILL.md` に置き、`<…>` の箇所をこの repo のテストコマンド・lint・ブランチ規約で埋める。

埋める値は探索で見つけたもの（`justfile`、`package.json` の scripts、`Makefile`）から提案する。

### 3. 下書きを見せる

書く予定のファイルと差分を全部並べる。`.monica/epic-flow.md` の全文、PR template への追記、`/tackle` への追記行、作るラベル、実行するコマンド。あなたが直してから進む。

### 4. 書く

確認された分だけ書く。既存ファイルへの追記は、該当の節や行だけを足し、周りの文は動かさない。`/tackle` の既存 SKILL.md がある場合は雛形で置き換えず、`epic-worker` の呼び出し行だけを足す。

### 5. 完了を報告する

3 値の表をもう一度出し、「要修正」が残っていれば理由（あなたが見送った、手元で直す必要がある）を添える。以後 `/tackle` と `/orchestrate` がこの repo で動く前提が揃った、と伝える。

完了条件: 全項目が「OK」か「見送り（理由）」のどちらかになっている。
