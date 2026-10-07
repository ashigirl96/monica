---
name: tackle
description: "spec または ticket 群に基づいて作業を実装し、PR を merge まで運ぶ。"
disable-model-invocation: true
---

spec または ticket でユーザーが記述した作業を実装する。ticket は `docs/agents/issue-tracker.md` の「issue を読む」の形で取る。

作業は `issue-<番号>` の branch で行う。今の branch の名前が違えば、`git fetch origin main` してから `git switch --no-track -c issue-<番号> origin/main` で切る。worktree は前の ticket の branch のまま渡されることがあり、その branch は squash merge 済みでも origin/main に無い commit を残している。/create-pr も branch の名前から `Closes #<番号>` を書く。

可能な限り、事前に合意した seam（振る舞いを差し替えられる場所）で `mattpocock-skills:tdd` を使う。

型チェック、触った file の lint（`bunx oxlint <file>…`）、単一テストファイルの実行は定期的に、テストスイート全体の実行は最後に 1 回行う。lint だけが捕まえる違反（`no-shadow` など）で、全体の検査をやり直さないため。

完了したら `mattpocock-skills:code-review` で、Standards と Spec の 2 軸のレビューを受ける。この時点の変更はまだコミットしていないので、diff は `git diff $(git merge-base origin/main HEAD)` で渡す。worktree のローカルの `main` は古いことがあり、他の PR の変更が diff に混ざるため。新しいファイルはこの diff に出ないので、先に `git add -N` で載せる。Spec 軸には、受け入れ条件ごとに、それを破る変異を入れるとテストが落ちるかも確かめさせる。競合や量で決まる経路は、テストが通っていてもその経路を通っていないことがあるため。変異の前に、作業ツリーで `bun test --coverage` を 1 回走らせ、受け入れ条件を担う file が表に無いか、その行が Uncovered Line #s に並ぶなら、その条件には変異を入れずに「どのテストも通らない」と報告させる。どのテストも実行しない行への変異は、worktree を用意しても必ず生き残るため。変異は、merge-base から `git worktree add --detach` で作った一時の worktree に、`git diff <merge-base> --binary` を `git apply` して `bun install` してから入れさせ、終わったら worktree を消させる。同じ作業ツリーを Standards 軸の agent が並行して読むため。

作業を /create-pr でコミットし、PR を出す。

/watch-ai で codex review の指摘に対応する。

/watch-ai が終わったら、/retro で今後に活かすものがあるか確かめ、直したものはコミットして push する。

`gh pr view --json mergeable` で PR が `MERGEABLE` であることを確かめる。`CONFLICTING` なら origin/main を merge して衝突を解き、`bun run check` が通ったら push する。衝突している PR では CI が走らず、`gh pr checks` は古い commit の結果を返すため。

最後に、`gh pr checks --watch` で CI が通ったのを確かめてから、merge してよいかをユーザーに尋ね、了承を得たら merge する。
