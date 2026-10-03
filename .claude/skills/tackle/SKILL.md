---
name: tackle
description: "spec または ticket 群に基づいて作業を実装し、PR を merge まで運ぶ。"
disable-model-invocation: true
---

spec または ticket でユーザーが記述した作業を実装する。

可能な限り、事前に合意した seam（振る舞いを差し替えられる場所）で /tdd を使う。

型チェックと単一テストファイルの実行は定期的に、テストスイート全体の実行は最後に 1 回行う。

完了したら `mattpocock-skills:code-review` で、Standards と Spec の 2 軸のレビューを受ける。

作業を /create-pr でコミットし、PR を出す。

/watch-ci で codex review の指摘に対応する。

/watch-ci が終わったら、/retro で今後に活かすものがあるか確かめる。直したものはコミットして push する。

最後に、merge してよいかをユーザーに尋ね、了承を得たら merge する。ユーザーに尋ねるのはこの 1 回だけで、それまでの判断は自分で下す。
