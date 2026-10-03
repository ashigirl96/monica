---
name: tackle
description: "spec または ticket 群に基づいて作業を実装する。"
disable-model-invocation: true
---

spec または ticket でユーザーが記述した作業を実装する。

可能な限り、事前に合意した seam（振る舞いを差し替えられる場所）で /tdd を使う。

型チェックと単一テストファイルの実行は定期的に、テストスイート全体の実行は最後に 1 回行う。

完了したら /code-review を使って作業をレビューする。

作業を現在のブランチにコミットする。
