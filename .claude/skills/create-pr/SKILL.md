---
name: create-pr
description: 未コミットの変更をコミットし、PR を作成して、その PR を browser で開く。ユーザーが /create-pr と打ったとき、または「PR 作って」「PR 出して」「commit して PR」「この変更で PR」のように、今ある作業差分をそのまま PR にしたいと示したときに必ず使う。コミットメッセージ・PR タイトル/本文は差分から自動生成する。
---

# create-pr

今ある未コミットの変更（unstaged / untracked 含む）をコミットし、PR を作成して、作成した PR を browser で開く。最小限のフロー。

## 手順

1. **変更を確認** — `git status` と `git diff`（および untracked）で全変更を把握する。変更が何も無ければ、その旨を伝えて終了する。

2. **ブランチを用意** — 現在のブランチがデフォルトブランチ（`main` など。`gh repo view --json defaultBranchRef -q .defaultBranchRef.name` で確認）なら、変更内容に基づいた名前で作業ブランチを切ってから進める。すでに作業ブランチ上ならそのまま使う。

3. **コミット** — `git add -A` で全変更をステージし、1 つのコミットにまとめる。メッセージはリポジトリの既存ログのスタイル（`git log --oneline -10` で確認。多くは Conventional Commits）に合わせ、差分の要点を要約する。

4. **push** — `git push -u origin <branch>`。

5. **PR 作成** — `gh pr create --base <default-branch>` で PR を作る。title はコミット要約。body は `.github/PULL_REQUEST_TEMPLATE.md` の構造に沿って `--body` で生成して渡す。
   - `## 概要` — この PR で何を・なぜ変えたかを簡潔にまとめる。
     - **現在のブランチ名が数字のみ（例: `15`）または `issue-<番号>`（例: `issue-116`）の場合は、その数値部分を issue 番号とみなし、概要の末尾に `close #<番号>`（例: `close #15`）を 1 行入れる。** マージ時にその issue が自動でクローズされる。
   - `## 主な変更` — 差分から読み取れる変更点を箇条書きにする。ファイル単位ではなく「何ができるようになったか」で書く。
   - `## 設計上のポイント` — なぜこの実装にしたか、検討した代替案やトレードオフ、レビュアに注意してほしい箇所を書く。差分から読み取れない・特筆すべき点が無ければ省略してよい。
   - `## 動作確認` — 差分から分かる範囲で、確認方法（test command / manual check / expected behavior）を書く。実行したコマンドがあれば ```bash フェンスに入れる。
   - テンプレートの HTML コメント（`<!-- -->`）はガイドなので body には含めない。

6. **開く** — `gh pr create` が出力した PR の URL を `open <url>` で browser で開く。最後に PR の URL をユーザーに伝える。
