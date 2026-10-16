---
name: tackle
description: "spec または ticket 群に基づいて作業を実装し、PR を merge まで運ぶ。"
disable-model-invocation: true
---

spec または ticket でユーザーが記述した作業を実装する。ticket は `docs/agents/issue-tracker.md` の「issue を読む」の形で取る。

作業は `issue-<番号>` の branch で行う。今の branch の名前が違えば、`git fetch origin main` してから `git switch --no-track -c issue-<番号> origin/main` で切る。worktree は前の ticket の branch のまま渡されることがあり、その branch は squash merge 済みでも origin/main に無い commit を残している。切ったら `bun install` する。worktree には依存が入っていないことがあり、`bun test` は通っても `tsc` は module を解決できずに落ちるため。PR の本文の `Closes #<番号>` も branch の名前から書く。

可能な限り、事前に合意した seam（振る舞いを差し替えられる場所）で `mattpocock-skills:tdd` を使う。

型チェック、触った file の lint（`bunx oxlint <file>…`）と整形（`bunx oxfmt <file>…`。prettier は repo の設定を読まず、関係の無い行まで折り返す）、単一テストファイルの実行は定期的に、テストスイート全体の実行は最後に `bun run check:brief` で 1 回行う。lint だけが捕まえる違反（`no-shadow` など）で、全体の検査をやり直さないため。テストを足すか消したら、全体の検査が通った後に `bun run test:timings` で `scripts/test-timings.json` を更新し、同じコミットに入れる。check は timings を読むだけで書き換えず、古い timings は CI の並列の配分を崩すため。

完了したら `mattpocock-skills:code-review` で、Standards と Spec の 2 軸のレビューを受ける。この時点の変更はまだコミットしていないので、diff は `git merge-base origin/main HEAD` で出した SHA を使い、`git diff <SHA>` で渡す。worktree のローカルの `main` は古いことがあり、他の PR の変更が diff に混ざるため。`$(...)` を含む git は worktree の session の guard が拒むので、SHA は先に出しておく。新しいファイルはこの diff に出ないので、先に `git add -N` で載せる。Spec 軸には、受け入れ条件ごとに、それを破る変異を入れるとテストが落ちるかも確かめさせる。競合や量で決まる経路は、テストが通っていてもその経路を通っていないことがあるため。変異の前に、作業ツリーで `bun test --coverage` を 1 回走らせ、受け入れ条件を担う file が表に無いか、その行が Uncovered Line #s に並ぶなら、その条件には変異を入れずに「どのテストも通らない」と報告させる。どのテストも実行しない行への変異は、worktree を用意しても必ず生き残るため。テストが子 process として起こす file（`apps/backend/src/main.ts`、hook の CLI の `apps/cli/src/main.ts`）は表に出ないので、変異を入れて確かめさせる。変異は、merge-base から `git worktree add --detach` で作った一時の worktree に、`git diff <merge-base>` を file に書き出して `patch -p1` で当て（`git apply` は guard が一時の worktree への git として拒む）、`bun install` してから入れさせ、終わったら worktree を消させる。同じ作業ツリーを Standards 軸の agent が並行して読むため。変異は `cp` で取った控えから戻させる。`git checkout -- <file>` は、一時の worktree に当てた diff ごと merge-base の内容に戻すため。Rust の file を戻したら、`touch` してから次のテストを流させる。cargo は mtime で build し直すかを決め、`mv` で戻した控えの mtime は変異より古いので、変異入りの binary のまま走るため。

作業を 1 コミットにまとめて push し、`gh pr create` で PR を出す。本文は `mattpocock-skills:pr` で書き、`Closes #<番号>` を入れる。コミットメッセージと PR の本文は scratchpad の file に書き、`git commit -F <file>` と `gh pr create --body-file <file>` で渡す。worktree の session の guard は、heredoc やつないだコマンドで打つ git を拒むため。

/watch-ai で codex review の指摘に対応する。

/watch-ai が終わったら、/retro で今後に活かすものがあるか確かめ、直したものはコミットして push する。

`gh pr view --json mergeable` で PR が `MERGEABLE` であることを確かめる。`CONFLICTING` なら origin/main を merge して衝突を解き、`bun run check:brief` が通ったら push する。衝突している PR では CI が走らず、`gh pr checks` は古い commit の結果を返すため。

最後に、`gh pr checks --watch --required` で CI が通ったのを確かめてから、merge してよいかをユーザーに尋ね、了承を得たら merge する。`--required` を付けないと、必須でない CodeQL の完了まで待つため。

merge したら、`git fetch origin main` をして merge 後の main に移る。本体の checkout では `git switch main` と `git merge --ff-only origin/main` で `main` の branch に戻し、worktree では `git switch --detach origin/main` にする（`main` は本体の checkout が握っていて、worktree では switch できない）。移ったら`install-app` skill で release の Monica を入れ直す。merge の了承が入れ替えの了承を兼ねる。PR の branch のまま build すると、先に main に入った他の PR の変更が抜けるため。整形だけの PR を merge したら、main に入った commit の SHA を `.git-blame-ignore-revs` に足す PR を続けて出す。squash merge なので、branch の commit の SHA は main に残らないため。
