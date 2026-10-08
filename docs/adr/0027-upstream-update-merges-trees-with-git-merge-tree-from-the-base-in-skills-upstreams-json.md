---
status: accepted
---

# Upstream Update は `skills/upstreams.json` に記録した base から tree を組み、`git merge-tree` で 3-way merge する

Upstream Update は、写した Skill に Skill Patch を残したまま Upstream の新しい版を反映する（ADR-0026）。monica は Upstream の fork ではない。Upstream の plugin が載せる Skill の directory だけを、平らな `skills/<name>/` に写す。main は PR の squash merge しか受けないので、前回の Upstream Update の commit は main の履歴に残らない。そこで base（前回写した Upstream の commit）を履歴から探さず、Upstream ごとに tag と full SHA で `skills/upstreams.json` に記録する。開発 skill `/update-upstream-skills` の script は、base と新しい版のそれぞれで「Skill の名前 → Upstream の Skill の tree」を並べた tree を組む。それを `git merge-tree --write-tree --merge-base` に渡し、今の `skills/` と 3-way merge する。

## Considered Options

- **git subtree（`split` + `--squash`）**: 前回の squash commit を HEAD の履歴から探す。GitHub の squash merge を挟むと、merge base が「Skill Patch を含んだ main の commit」になる。そのため 2 回目の Upstream Update で、Skill Patch が conflict も出さずに消えた。Upstream Update だけは merge commit を main に直接 push すれば残る。ただし prefix ごとに 1 subtree なので `skills/engineering/` と `skills/productivity/` に割れ、記録される SHA も split の合成 commit になる。
- **repo 全体を fork として merge する**（nanoclaw の `/update-nanoclaw` の形）: monica は Upstream の一部だけを写すので、merge すると Upstream の docs や in-progress まで root に入ってくる。base を merge commit の履歴に任せるところも、squash merge と組み合わせられない。
- **`git merge-file` を file ごとに呼ぶ script**: 結果は merge-tree と同じだった。ただし Skill の中の rename、Skill そのものの rename、追加と削除を、script が自分で対応づけることになる。merge-tree なら rename も directory の rename も git が見つけ、Skill Patch と Skill Patch Note は新しい directory に移る。
- **skills.sh、`gh skill`、vendir など**: Upstream が変わると、Skill の directory を丸ごと入れ替えるか、手元の変更を見つけて止まる。Skill Patch を残したまま merge する道具は無かった。
- **Skill ごとに base を持つ**: Skill ごとに進める版を選べるが、複数の Skill にまたがる Upstream の変更が片方だけ入ることがある。ある Skill への Upstream の変更を見送るなら、その変更を戻す Skill Patch と Skill Patch Note で表せる。

## Consequences

- 追うのは Upstream の最新の tag。引数で ref を渡せば、一度だけその commit へ進める。新しい版が base の子孫でなければ、merge せずに止める。古い版へ merge すると Upstream の変更を巻き戻してしまうため。
- 最初に写すのも Upstream Update で、base を空の tree にして merge する。
- 写すのは Upstream の manifest の `skills` に載る directory。`agents/openai.yaml`（Codex の UI 用）、bucket の README.md、Upstream の docs は写さない。
- monica 自身の Skill も写した Skill も、平らな `skills/<name>/` に並べる。名前の衝突は merge の前に検査して止める。重なったまま merge すると、Upstream の file が monica の Skill に黙って混ざるため。
- 1 回の Upstream Update を 1 つの PR にし、`skills/upstreams.json` の base の更新も同じ PR に入れる。
- base の commit は、Upstream の repo から full SHA か tag で fetch し直せる必要がある。Upstream が履歴を書き換えて base の commit が消えたときの扱いは、この決定の外。
