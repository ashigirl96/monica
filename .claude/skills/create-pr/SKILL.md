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

5. **PR 作成** — `gh pr create --base <default-branch>` で PR を作る。title はコミット要約、body は変更点の簡潔なサマリ。
   - **現在のブランチ名が数字のみ（例: `15`）の場合は、その数字を issue 番号とみなし、body に `close #<番号>`（例: `close #15`）を 1 行入れる。** マージ時にその issue が自動でクローズされる。

6. **開く** — `gh pr create` が出力した PR の URL を `open <url>` で browser で開く。最後に PR の URL をユーザーに伝える。
