# Upstream の Skill を写し、Skill Patch を保ったまま新しい版を反映する仕組み

issue #241（map #239）の調査。Upstream（mattpocock/skills）の `skills/engineering` と `skills/productivity` を monica の `skills/` に写し、Skill Patch を当てたまま Upstream Update する仕組みの候補を並べ、ticket の「各候補で確かめること」1〜5 を候補ごとに埋める。どれを選ぶかは後続の「Upstream Update の手順」で決めるので、推奨は書かない。

調査日 2026-10-08。調べた版:

- git 2.54.0（手元は Apple Git-157。ソースと docs は git/git の tag v2.54.0、commit `94f0577`）
- mattpocock/skills の v1.2.3（`6acc160`）、v1.3.0（`984a2c0`）、v1.3.1（`24fe0ef`）、main（`f3fc563`）
- skills CLI（npm の `skills`）1.7.1 = vercel-labs/skills の `958f4b7`
- gh 2.102.0（cli/cli `fc4b137`）、copier（`04a8619`、最新 tag v9.18.2）、vendir 0.46.2（`fede212`）、git-subrepo 0.4.9（`5e0f401`）、peru 1.3.5（`c50be01`）、skiletto 0.4.0（`e0bf1a8`）、skills-lock 0.1.0（`4e37719`）
- Claude Code の docs（code.claude.com、2026-10-08 に読んだもの）

git の挙動は scratchpad の使い捨て repo で試した。skills.sh（`npx skills`）は `~/.claude/skills` などに書き込むので実行せず、ソースと docs だけを読んだ。候補 5 の道具も実行していない。docs やソースで確かめず、試した結果や読んだコードから導いた主張には「推論」と付ける。

## 試し方

scratchpad に Upstream の checkout を clone し、v1.2.3 の 25 個の Skill を monica 役の repo へ写して、Skill Patch を 4 つ当てた。そこから v1.3.1 へ Upstream Update し、続けて Upstream に合成の commit を 1 つ足して（grilling を productivity から engineering へ移し、本文を 1 行変える）、そこへもう一度 Upstream Update した。monica 自身の Skill の代わりに `skills/run-task/` を 1 つ置いた。

| Skill Patch | 当てた所 | v1.2.3 → v1.3.1 で Upstream がしたこと |
|---|---|---|
| P1 | grilling の frontmatter に `disable-model-invocation: true` を足す。本文の「Finding _facts_」の段落の 1 文を、`~/.claude/PATCH-SKILL.md` の grilling の上書き（事実調査が返るまで最初のラウンドを出さない）に置き換える | frontmatter は変えない。同じ段落の em dash を `;` と `:` に直す |
| P2 | tdd の末尾に節を足す | 本文の別の行の em dash を直す |
| P3 | domain-modeling の `CONTEXT-FORMAT.md` の 1 行 | file を `GLOSSARY-FORMAT.md` へ rename し（類似度 70%）、中身も直す |
| P4 | resolving-merge-conflicts の description | Skill ごと消す |

## Upstream の版の間で起きていること

- v1.2.3 → v1.3.1 の間に、`skills/engineering` と `skills/productivity` の中で 56 file が変わった（追加 7、削除 2、変更 46、rename 1、+838 / −573 行）。plugin.json の `skills` は 25 個から 27 個になった。
  - `git -C ~/.ghq/src/github.com/mattpocock/skills diff --name-status -M v1.2.3 v1.3.1 -- skills/engineering skills/productivity` の結果
  - https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/.claude-plugin/plugin.json#L21-L49
- 足された Skill は implement-spec、pr、retro。3 つとも Upstream では in-progress から engineering へ「Graduate」したもので、retro（`R100`）と pr（`R096`）は `a7d038f`、implement-spec（`R100`）は `24f41cc` で rename として動いた。ただし in-progress は写さないので、写す範囲から見ると 3 つとも「追加」になる。retro は v1.2.3 の時点ではまだ無く（`8fa1886` で 2026-08-24 に in-progress へ足された）、どの tag でも in-progress に載っていない。
  - https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/CHANGELOG.md#L13 （implement-spec）、#L21（pr）、#L25（retro: "Graduate **`retro`** into the **Engineering** bucket, so it ships in the Claude Code plugin"）
- 消えた Skill は resolving-merge-conflicts（"Remove the **`resolving-merge-conflicts`** skill. ... nothing replaces it"）。
  - https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/CHANGELOG.md#L29
- Skill の中の file の rename がある。domain-modeling の `CONTEXT-FORMAT.md` が `GLOSSARY-FORMAT.md` になった（`d80fa0f`）。
  - https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/CHANGELOG.md#L31
- tag の間の commit では、Skill が現れて消えることがある。pr は `d75dcf1`（2026-09-17）で engineering に足され plugin.json にも載ったが、同じ日の `4cfa4cd` で in-progress へ移り plugin.json から外れ、`a7d038f` で engineering に戻った。tag ではなく main の commit を追うと、この往復を「追加 → 削除 → 追加」として受ける。
- bucket の中には Skill でない file がある（`skills/engineering/README.md`、`skills/productivity/README.md`）。各 Skill の directory には `SKILL.md` のほかに `agents/openai.yaml` などがある。写す範囲の file は `.md` 52、`.yaml` 27、`.sh` 2 で、すべて text、mode はすべて `100644`。
- Upstream の版は git の tag（`v1.3.1` など）と `.claude-plugin/plugin.json` の `version` に出る。`version` は `package.json` の値を `scripts/sync-plugin-version.mjs` が写す。main は v1.3.1 の 43 commit 先で、未 release の changeset が 15 個ある。
  - https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/scripts/sync-plugin-version.mjs#L1-L4

## 候補 1: `git merge-file` による 3-way merge

### docs から読めること

- `git merge-file <current> <base> <other>` は、`<base>` から `<other>` への変更を `<current>` に入れる。両側が同じ行の範囲を変えていれば conflict で、`<<<<<<<` と `>>>>>>>` で囲んで残す。結果は既定で `<current>` に書く（`-p` で標準出力）。
  - https://git-scm.com/docs/git-merge-file
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/Documentation/git-merge-file.adoc#L19-L42
- 終了コードは conflict の数（127 で頭打ち）、エラーなら負、clean なら 0。
  - 同 #L48-L50
- `--object-id` を付けると 3 つを blob の object ID で渡せ、`-p` が無ければ結果を object store に書いてその ID を出す。`--ours` / `--theirs` / `--union` は conflict を片側か両側の行で自動的に解く。`--diff3` / `--zdiff3` で base の行も conflict に出す。
  - 同 #L60-L66、#L83-L96
- 引数は 3 つの file（か blob）だけで、path、directory、rename、追加、削除を扱う option は無い。
  - 同 #L11-L14（SYNOPSIS）

### 試した結果

merge-file を呼ぶ使い捨ての script を書いた。script は lock file（`skills/upstream.lock`）に「写したときの Upstream の commit」と「Skill ごとの Upstream 側の path」を持つ。新しい版の plugin.json から Skill の一覧と path を取り、Skill ごとに Upstream の checkout で `git diff -M --name-status <古い commit>:<古い path> <新しい commit>:<新しい path>` を取り、変更（M）と rename（R）は merge-file に、追加（A）は写すだけに、削除（D）は base と同じなら消し違えば残して報告する。Skill の追加と削除は plugin.json の一覧の差で決める。monica 側は `skills/<name>/` の平らな形にした。

- v1.2.3 → v1.3.1: 変更された 44 file のうち 43 が clean（終了コード 0）。grilling だけが終了コード 1 で、conflict は P1 が書き換えた段落の 1 か所だけだった。P1 の frontmatter の行と、grilling のほかの段落の em dash の直しは自動で入った。P2 は残った。P3 は script が `git diff -M` で対にしたので、`GLOSSARY-FORMAT.md` に P3 が入った形で merge された。P4 は Upstream で消えた Skill に Skill Patch が当たっているので、script が残して報告した。implement-spec、pr、retro は写された。Skill Patch の無い 22 個の Skill は v1.3.1 と完全に一致した（`diff -r`）。
- 合成の commit（grilling を productivity から engineering へ移し、1 行変える）: monica 側が `skills/<name>/` の平らな形で、script が Skill を名前で対にするので、移動は lock の Upstream 側の path が変わるだけだった。1 行の変更は clean に入り、P1 は残った。

### 1〜5

1. **一部の directory だけを写せるか**: 写せる。merge-file は repo も directory も知らないので、何を写すかは周りの script が決める。試作では plugin.json の一覧（v1.2.3 で 25 個、v1.3.1 で 27 個）を写し、bucket の README.md は写さなかった。monica 側の形（平らにするか bucket を保つか）も script が決める。
2. **ぶつからない変更は自動で入り、ぶつかる所だけ残るか**: file ごとに、ぶつからない hunk は自動で入り、ぶつかる hunk だけが marker 付きで残る（試した）。conflict の数は終了コードで分かる。
3. **file の移動、Skill の追加と削除**: merge-file 自身は扱わない。Skill の中の rename は Upstream 側で `git diff -M` を取って対にすれば merge でき、Skill の追加と削除は plugin.json の差から script が決める（試した）。Skill Patch の当たった file が Upstream で消えたとき（modify/delete）の扱いも script が決める。bucket をまたぐ移動は、monica 側を平らな形にして名前で対にすると、monica 側の path が変わらない（試した）。
4. **Upstream が複数になったとき**: Upstream ごとに lock の項目と checkout を持てば、同じ script を Upstream ごとに回せる（推論）。平らな形では、別の Upstream や monica 自身の Skill と同じ名前の Skill が来たら、同じ directory を取り合うので script が検出する必要がある（試作の script は `ADD-COLLISION` として止めた）。
5. **Upstream の版をどこに記録するか**: merge-file は何も記録しない。base を作るには写したときの Upstream の commit が要り、試作では lock file に full SHA を書き、base は Upstream の checkout から `git show <commit>:<path>` で取り出した。base の commit が Upstream の checkout に残っている必要がある（tag なら残る）。

## 候補 2: git subtree

### docs とソースから読めること

- `git subtree` は git の contrib にある shell script で、手元の Apple Git にも `git-subtree` として入っている。docs は `git subtree add` / `merge` / `pull` / `split` を持つ。
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/contrib/subtree/git-subtree.adoc#L68-L134
- `add <repository> <remote-ref>` は、その commit の **tree 全体** を `--prefix` の下に読み込む（`git read-tree --prefix="$dir" $rev`）。`--prefix` の directory が既にあると `add` は止まる。
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/contrib/subtree/git-subtree.sh#L885-L923
  - 同 #L256-L259（"fatal: prefix '$arg_prefix' already exists."）
- docs には、相手の repo の一部の directory だけを `add` する option も手順も無い。`split --prefix=<dir>` は、その directory を root に置いた合成の履歴を作る command で、同じ履歴を同じ設定で split すれば同じ commit ID になると docs が保証している。試作では、これを Upstream の clone で走らせてから `add` / `merge` した。
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/contrib/subtree/git-subtree.adoc#L97-L116
- `--squash` は Upstream の履歴を持ち込まず、1 つの squash commit を作ってそれを merge する。squash commit の message には `git-subtree-dir: <dir>` と `git-subtree-split: <取り込んだ commit の full SHA>` が入る。
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/contrib/subtree/git-subtree.adoc#L165-L189
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/contrib/subtree/git-subtree.sh#L606-L627
- `merge --squash` は、`git log HEAD` から `^git-subtree-dir: <dir>/*$` に合う commit を新しい順に探し、その message の `git-subtree-split` を前回取り込んだ commit とみなす。新しい squash commit の親を見つけた commit にして、`git merge --no-ff -Xsubtree=<prefix>` で merge する。
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/contrib/subtree/git-subtree.sh#L406-L458 （`find_latest_squash`）
  - 同 #L678-L692（`new_squash_commit`）、#L1024-L1066（`cmd_merge`）
- `add` / `merge` / `pull` は、作業 tree か index に変更があると止まる（"fatal: working tree has modifications.  Cannot add."）。
  - 同 #L772-L782
- `-Xsubtree` の merge では、merge-ort が相手側の tree と merge base の tree の両方を prefix に合わせてずらす。ずらすかどうかは tree の一致の点数で決まり、両方が prefix を持つ tree はずらさないことがある。
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/merge-ort.c#L5247-L5252
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/match-trees.c#L326-L380

### 試した結果: merge commit を残す場合

Upstream の clone で bucket ごとに `git subtree split --prefix=skills/<bucket> <tag>` を走らせ、monica 役の repo で `git subtree add --prefix=skills/<bucket> --squash <clone> <split の branch>` を bucket ごとに 1 回ずつ行った。

- split は 542 commit の履歴に対して bucket と tag ごとに 7.7〜9.9 秒かかった。同じ tag を 2 回 split すると同じ SHA になり、v1.2.3 の split は v1.3.1 の split の祖先だった。
- `--prefix` が既にあると `add` できないので、2 つの bucket を 1 つの `skills/` に平らに並べることはできず、`skills/engineering/` と `skills/productivity/` の 2 つの subtree になった。bucket の README.md もついてくる。
- squash commit の message に残るのは `git-subtree-split: <split の SHA>` で、これは split が作った合成の commit。Upstream の tag や commit の SHA はどこにも残らない（`-m` で自分で書かない限り）。
- v1.2.3 → v1.3.1（`git subtree pull --squash` を bucket ごと）:
  - engineering: rename が検出され、P3 は `GLOSSARY-FORMAT.md` に merge された。P2 は自動で入った。resolving-merge-conflicts は `CONFLICT (modify/delete)` で止まった（Skill Patch の無い `agents/openai.yaml` は消えた）。
  - productivity: grilling が merge-file と同じ段落で `CONFLICT (content)`。P1 の frontmatter は自動で入った。
  - engineering の conflict を解く前に productivity を pull すると、`fatal: working tree has modifications.  Cannot add.` で止まった。bucket ごとに、merge して conflict を解いて commit することを繰り返す。
- 合成の commit（grilling が productivity から engineering へ移る）: engineering の pull は grilling を単なる追加として clean に入れ、そこには P1 が無い。productivity の pull は `grilling/SKILL.md` を modify/delete の conflict にした。conflict を解くまで `skills/engineering/grilling` と `skills/productivity/grilling` の 2 つがあり、P1 は手で新しい場所へ当て直すことになる。
- `git clone --no-local` で作った clone（前回の split の commit を持たない）からも pull できた。新しい split が前回の split を祖先に持つので、pull の fetch で前回の split も届いたため。

### 試した結果: GitHub の squash merge を挟む場合

monica の repo は squash merge しか許していない（`allow_merge_commit: false`、`allow_rebase_merge: false`、`squash_merge_commit_message: COMMIT_MESSAGES`）。GitHub の squash merge は PR の commit を base branch の 1 commit にまとめ、元の commit を base branch に残さない。`COMMIT_MESSAGES` では squash commit の本文が branch の commit の message になり、monica の履歴では各 commit の message が `* ` 付きで並ぶ（例 `0cc2448`）。

- https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges （"intermediate commits from the pull request are not preserved as separate commits on the base branch"）
- https://docs.github.com/en/rest/repos/repos#update-a-repository （`squash_merge_commit_message`: "COMMIT_MESSAGES - default to the branch's commit messages"）
- `gh api repos/ashigirl96/monica` の結果

これを手元で `git merge --squash` と、同じ形の message の commit で真似た。#1 で 2 つの bucket を `add`、#2 で Skill Patch、#3 で engineering を v1.3.1 へ pull、#4 で engineering を合成の commit へ pull し、それぞれを main へ squash した。

- #3: `find_latest_squash` は main の #1（squash した commit）を「前回の squash」として見つけた。#1 の本文には 2 つの bucket の `git-subtree-split` が並んでいたので、engineering の前回として productivity の split の SHA を拾った。それでも merge の結果は merge commit を残す場合と同じだった（P2、P3 は残り、resolving-merge-conflicts が modify/delete）。
- #4: `git subtree pull` は終了コード 0、`Merge made by the 'ort' strategy.` で終わり、**P2（tdd）と P3（`GLOSSARY-FORMAT.md`）が黙って消えた**。merge commit を残す場合の同じ pull では、P2 と P3 は残った。
- 推論（上のソースと結果から）: #4 の新しい squash commit の親は main の #3 で、merge base も #3 になる。#3 の tree は Skill Patch を含んだ monica 全体の tree で、merge-ort は prefix を持つこの tree をずらさない。相手側は Upstream の素の tree を HEAD の tree の prefix に差し込んだものになる。base と HEAD には Skill Patch があり相手側には無いので、3-way merge は「相手側が Skill Patch を消した」と読む。#3 で結果が正しかったのは、merge base になった #1 がまだ Skill Patch を含まない写しだったから。
- monica の main は保護されておらず、履歴に merge commit が無い（origin/main の 136 commit）。PR を通さない commit が main に直接 push されることがある（`9bc8c35`、`a1ad9c5`）。

### 1〜5

1. **一部の directory だけを写せるか**: Upstream の clone で `split` して合成の履歴を作れば写せる。subtree は 1 つの directory を 1 つの prefix に置くので、engineering と productivity は別の prefix になり、bucket の README.md のような Skill でない file もついてくる。split は Upstream の clone の object store に commit を作る。
2. **ぶつからない変更は自動で入り、ぶつかる所だけ残るか**: 前回の squash commit が HEAD の祖先にあれば、git の merge（ort）として自動で入り、ぶつかる所は index と作業 tree に conflict として残る（試した）。GitHub の squash merge を挟むと、2 回目の Upstream Update から Skill Patch が conflict も出さずに消えた（試した）。
3. **file の移動、Skill の追加と削除**: 1 つの subtree の中では、rename の検出、追加、削除（Skill Patch があれば modify/delete の conflict）を git の merge がする（試した）。bucket をまたぐ移動は、片方の subtree での削除ともう片方での追加になり、Skill Patch はついてこない（試した）。
4. **Upstream が複数になったとき**: Upstream と directory の組ごとに prefix を 1 つ持ち、それぞれ split と pull を繰り返す。`git-subtree-dir` の値（prefix）で前回を探すので、prefix ごとに独立する（ソースから）。
5. **Upstream の版をどこに記録するか**: commit message の `git-subtree-dir` と `git-subtree-split`。split を挟むと記録される SHA は合成の commit で、Upstream の tag や commit ではない。squash merge では、これらの行は GitHub の squash commit の本文に入る。

## 候補 3: skills.sh（`npx skills add`）

### 正体

- npm の `skills` の最新は 1.7.1（2026-10-06 公開）で、`repository` は vercel-labs/skills、`gitHead` は `958f4b7`（tag v1.7.1 と同じ commit）。skills.sh の docs も、この CLI のソースは vercel-labs/skills だと書く。以下のソースの行はこの commit のもの。
  - https://registry.npmjs.org/skills
  - https://skills.sh/docs

### ソースと docs から読めること

- **選び方**: `--skill <name>`、`owner/repo@skill`、`owner/repo/<subpath>`（`https://github.com/o/r/tree/<branch>/<path>` も可）、`#ref`（branch、tag、commit SHA）で選べる。directory を glob で指す機能は無い。
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/README.md#L89-L102
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/source-parser.ts#L528-L549 、#L284-L313
- **見つけ方**: 起点（か subpath）に SKILL.md があればそれだけを返す。無ければ root の直下、`skills/` の下を深さ 3 まで、各 agent の `.<agent>/skills` を探す。plugin.json と marketplace.json の `skills` は探す場所を足すだけで、絞り込みには使われない。frontmatter に `name` と `description` が無い SKILL.md は飛ばす。
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/skills.ts#L180-L329
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/plugin-manifest.ts#L51-L112
  - 推論: subpath も `--skill` も付けずに `add mattpocock/skills` すると、plugin.json に載っていない in-progress と misc も候補に出る。
- **置き場所**: project scope の正本は `./.agents/skills/<name>`、Claude Code 向けは `.claude/skills`（global は `~/.claude/skills`）。directory 名は frontmatter の `name` を sanitize したもので、平らに並ぶ。既定では正本へ copy して agent の directory へ symlink を張り、`--copy` なら直接 copy する。
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/installer.ts#L128-L131 、#L315-L330、#L366-L447
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/agents.ts#L155-L159
- **書き込み先を自由に選ぶ option は無い**。`AddOptions` は global、agent、yes、skill、metadata、list、all、fullDepth、copy、subagent、json だけ。例外として OpenClaw という agent の project 用 directory が `skills` なので、推論では `--agent openclaw` なら `./skills/<name>` に書く。ただし update が内部で走らせる add は `--agent` を渡さない。
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/add.ts#L563-L581
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/agents.ts#L166-L177
- **lock**: project では cwd の `skills-lock.json`（commit する前提）。entry は `source`、`sourceUrl`、`ref`、`sourceType`、`skillPath`、`computedHash` など。`computedHash` は Skill の folder の file を相対 path 順に並べ「相対 path + 中身」を SHA-256 にかけた値で、add のときに **取得元の clone** から計算する（写した先の file ではない）。`ref` は利用者が `#ref` を付けたときだけ入り、**commit SHA を入れる項目は無い**。
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/local-lock.ts#L15-L60 、#L145-L160
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/add.ts#L2066-L2084 、#L2141-L2177
- **update**: `check`、`update`、`upgrade` はどれも同じ `runUpdate` を走らせる（`check` も実際に更新する）。project scope では source と ref の組ごとに shallow clone し、clone の中の各 Skill の folder の hash を取り、移動が無く lock の `computedHash` と同じなら飛ばす。違えば `add <source>/<folder>#<ref> --skill <name> -y` を子 process で走らせる。add は書き込み先を `rm(path, { recursive: true, force: true })` で消してから copy する。
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/cli.ts#L398-L402
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/update.ts#L822-L831 、#L892-L969
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/installer.ts#L185-L200
- **移動、削除、追加**: lock の path が見つからなければ、正規化した同じ名前の Skill が 1 つだけあるときに移動とみなし、新しい path で入れ直す。消えた Skill は警告し、対話なら消すか聞き、`-y` や TTY でなければ消さない。git と GitHub の source では、update は lock にある Skill しか見ず、新しい Skill は入れも知らせもしない。
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/skill-relocation.ts#L20-L73
  - https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/update.ts#L244-L294
- skills.sh の docs には lock、ローカルの編集、更新の判定の説明が無い。FAQ は "Run `npx skills update` to pull the latest versions of your installed skills" とだけ書く。
  - https://skills.sh/docs/cli
  - https://skills.sh/docs/faq

### 1〜5

1. **一部の directory だけを写せるか**: subpath（`mattpocock/skills/skills/engineering` と `.../skills/productivity` の 2 回）や `--skill` で選べる（推論、ソースから）。ただし書き込み先は agent ごとの directory（`.agents/skills`、`.claude/skills` など）に決まっていて、repo 直下の `skills/` を選ぶ option は無い。bucket の階層は落ちる。
2. **ぶつからない変更は自動で入り、ぶつかる所だけ残るか**: 入らない。update は「今の Upstream」と「add したときの Upstream」の hash だけを比べ、写した先の file を読まない。Upstream が変わっていなければ Skill Patch は残り、変わっていれば Skill の directory ごと消して入れ直すので、Skill Patch は警告なしに消える（ソースから）。3-way merge、衝突の検出、ローカルの変更の警告に当たる処理は src/ にも tests/ にも見当たらなかった（推論、grep で探した）。
3. **file の移動、Skill の追加と削除**: 同じ名前の Skill が 1 つなら移動を追う。削除は警告し、非対話では消さない。追加は git と GitHub の source では入らず、知らせもしない（ソースから）。
4. **Upstream が複数になったとき**: 1 つの lock に source ごとの entry を並べられ、update は source と ref の組ごとに処理する。lock の key も directory 名も Skill の名前なので、別の source の同じ名前の Skill はぶつかる（推論、ソースから）。
5. **Upstream の版をどこに記録するか**: `skills-lock.json` の `ref`（`#ref` を付けたときだけ）と `computedHash`。commit SHA は記録しない。

## 候補 4: `git merge-tree --write-tree` による tree 単位の 3-way merge

ticket の候補には無いが、merge-file と同じく git だけで済み、rename を git が見つける形として試した。

### docs から読めること

- `git merge-tree --write-tree <branch1> <branch2>` は作業 tree と index に触らずに merge を計算し、結果の tree の ID と conflict の情報を出す。`--merge-base=<tree-ish>` で merge base を直接渡すと、`<branch1>` と `<branch2>` も commit でなく tree でよい。
  - https://git-scm.com/docs/git-merge-tree
  - https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/Documentation/git-merge-tree.adoc#L80-L92
- 終了コードは clean なら 0、conflict があれば 1、merge できなければそれ以外。
  - 同 #L211-L217

### 試した結果

monica 役の repo に Upstream の tag を `refs/upstream/*` として fetch し、`git mktree` で「Skill の名前 → その版の `skills/<bucket>/<name>` の tree」を並べた tree を v1.2.3 と v1.3.1 について作った。`git merge-tree --write-tree --merge-base=<v1.2.3 の tree> <HEAD:skills> <v1.3.1 の tree>` の結果は、merge-file の script と同じだった: P3 は rename を git が見つけて `GLOSSARY-FORMAT.md` に入り、grilling は `CONFLICT (content)`、resolving-merge-conflicts は `CONFLICT (modify/delete)`、tdd は clean、3 つの Skill が足され、`run-task` と lock file はそのまま残った。終了コードは 1。conflict の marker の見出しは tree の ID になった。

### 1〜5

1. 写せる。base と相手側の tree を `git mktree` で組むので、何を写しどう並べるかは組む側が決める（試した）。
2. git の merge（ort）として、ぶつからない変更は入り、ぶつかる所は結果の tree の file に marker 付きで残る（試した）。作業 tree へ書き戻すのは別の手順になる。
3. Skill の中の rename、追加、削除、modify/delete は git の merge が扱う（試した）。Skill の追加と削除は、組んだ tree の entry の差としてそのまま扱われる。
4. Upstream ごとに base と相手側の tree を組めば、同じ手順を並べられる（推論）。
5. merge-tree は何も記録しない。base の tree を組むには写したときの Upstream の commit が要り、その object が monica の repo に要る（試作では Upstream の checkout から fetch した）。

## 候補 5: ほかの道具

どれも実行せず、docs とソースを読んだだけ。

### Claude Code の plugin（mattpocock-skills を plugin のまま入れる）

- marketplace から入れた plugin は install のときに `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` へ copy され、そこから読まれる。update は version を計算し直し、変わっていれば新しい version の directory を作り、古い方は 14 日後に消す。version は manifest の `version`、marketplace の entry の `version`、source の commit SHA の順に決まる。mattpocock-skills は manifest に `"version": "1.3.1"` を書いている。
  - https://code.claude.com/docs/en/plugins/loading （Find plugins on disk、In-place and copied plugins、Versions and updates、Cleanup of previous versions）
  - https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/.claude-plugin/plugin.json#L3
- `${CLAUDE_PLUGIN_ROOT}` は「changes when the plugin updates, so don't write state there」。update を越えて残るのは `${CLAUDE_PLUGIN_DATA}` だけ。
  - https://code.claude.com/docs/en/plugins-reference （Environment variables）
- local の path から足した marketplace の relative-path の plugin だけは、その場所から直接読まれ、編集は次の session か `/reload-plugins` で効く（monica が `dawkinsuke` を配る形がこれ）。
  - https://code.claude.com/docs/en/plugins/loading （In-place and copied plugins）
- marketplace の entry の source に `git-subdir`（`url`、`path`、`ref`、`sha`）を使うと、git repo の一部の directory を plugin として指せる。
  - https://code.claude.com/docs/en/plugins/marketplace-reference （Plugin sources）
- 1〜5: (1) 利用者が入れる単位は plugin 全体。`git-subdir` で directory は指せる（推論: Skill ごとに entry を書けば一部だけ入るが、1 Skill が 1 plugin になる）。(2) cache の SKILL.md を直しても、version の変わる update で新しい directory に替わる（推論、docs から）。update を越えて Skill Patch を残す仕組みは docs に無い。(3) update 後は新しい version の中身そのもの（推論）。(4) marketplace は並べられる。(5) `~/.claude/plugins/installed_plugins.json` の `version`。repo に commit する lock は無い。

### GitHub CLI の `gh skill`

- v2.90.0（2026-04-16）で Public Preview として入った。subcommand は install、list、preview、publish、search、update。
  - https://github.com/cli/cli/releases/tag/v2.90.0
  - https://cli.github.com/manual/gh_skill
- install は名前、`author/skill`、repo の中の path で Skill を選べ、`--dir`（"Install to a custom directory (overrides --agent and --scope)"）で任意の directory に `<dir>/<name>/` の形で置ける。version を指定しなければ最新の release tag、tag が無ければ default branch の HEAD から入れる。
  - https://cli.github.com/manual/gh_skill_install
  - https://github.com/cli/cli/blob/fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd/pkg/cmd/skills/install/install.go#L133-L145 、#L244
- install は **写した SKILL.md の frontmatter の `metadata` に** `github-repo`、`github-ref`、`github-tree-sha`、`github-path`、`github-pinned` を書き込む。
  - https://github.com/cli/cli/blob/fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd/internal/skills/frontmatter/frontmatter.go#L65-L98
- update は frontmatter の `github-tree-sha` と remote の tree SHA を比べ、違えば staging に新しい版を作って directory の中身を入れ替える。`--force` は tree SHA が同じでも入れ直し、manual は "This overwrites locally modified skill files with their original content" と書く。`--dry-run` と `--pin` がある。
  - https://github.com/cli/cli/blob/fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd/pkg/cmd/skills/update/update.go#L98-L136 、#L290-L312、#L418-L508
- 1〜5: (1) 選べ、`--dir` で repo 直下の `skills/` にも置ける（平らな形）。(2) Skill Patch は Upstream が変わった update で入れ替わって消える。merge は無い。(3) `github-path`、無ければ名前で探す。推論: path が変わった Skill や消えた Skill は飛ばされ、新しい Skill は入らない。(4) 出所は Skill ごとに frontmatter にあり、repo ごとにまとめて update する。(5) 各 SKILL.md の frontmatter（commit SHA ではなく tree SHA）と `~/.agents/.skill-lock.json`。

### copier

- `copier update` は、旧版の template で project を作り直して今の project との差分を取り、新版を描画してから、その差分を `git apply --reject` と `git merge-file` で当て直す。衝突は既定で conflict marker（`--conflict inline`）か `.rej` で残す。作業 tree が dirty なら拒む。
  - https://github.com/copier-org/copier/blob/04a8619f3b083bc278b70e556bd085551a2b3f79/docs/updating.md#L39-L52 、#L192-L200
  - https://github.com/copier-org/copier/blob/04a8619f3b083bc278b70e556bd085551a2b3f79/copier/_main.py#L1574-L1690
- 版は回答 file（`.copier-answers.yml`）の `_commit` と `_src_path` に残る。ただし回答 file は template 自身が `{{ _copier_conf.answers_file }}.jinja` を持つときにしか出ず、無ければ update は "Cannot update because cannot obtain old template references" で止まる。mattpocock/skills はこの file を持たない。
  - https://github.com/copier-org/copier/blob/04a8619f3b083bc278b70e556bd085551a2b3f79/docs/configuring.md#L1911-L1924 、#L1963-L1966
  - https://github.com/copier-org/copier/blob/04a8619f3b083bc278b70e556bd085551a2b3f79/copier/_main.py#L1364-L1368
- 1〜5: (1) `_subdirectory` は template 側の copier.yml にしか書けず、CLI の `--exclude` で絞っても path は Upstream と同じ形で置かれる。(2) 3-way で当て直し、衝突だけを残す。ただしこの Upstream では回答 file が出ないので update が成り立たない。(3) 追加は描画で入り、旧版にだけある file は消える。rename は追わない（推論）。(4) template ごとに回答 file を分ける（`-a`）。(5) 回答 file の `_commit`。

### vendir（Carvel）

- `vendir.yml` の git の contents に `includePaths`、`excludePaths`、`newRootPath` があり、一部の directory を取れる。sync は管理する directory を `os.RemoveAll` して丸ごと差し替え、merge も衝突の提示も無い。`ignorePaths` の file だけがローカルのまま残る。解決した `sha` と `tags` は `vendir.lock.yml` に残る。
  - https://github.com/carvel-dev/carvel/blob/f74708a8be6a170a072abfdd43c305c950ef5364/site/content/vendir/docs/v0.46.x/vendir-spec.md#L254-L273
  - https://github.com/carvel-dev/vendir/blob/fede2120ba80535c5820db64abe095c01afbc632/pkg/vendir/directory/staging_dir.go#L131-L166
  - https://github.com/carvel-dev/carvel/blob/f74708a8be6a170a072abfdd43c305c950ef5364/site/content/vendir/docs/v0.46.x/vendir-lock-spec.md#L20-L28
- 1〜5: (1) 取れる。(2) Skill Patch は消える（`ignorePaths` に入れた file は Upstream の変更も入らない、推論）。(3) 毎回作り直すので Upstream のまま（推論）。(4) 並べられる。(5) `vendir.lock.yml`。

### git-subrepo

- Upstream の tree 全体を subdir に置き、pull は git の merge か rebase で行い、衝突すると "stop and tell you to finish this by hand"。版は `<subdir>/.gitrepo` の `subrepo.commit` と `subrepo.parent` に残る。
  - https://github.com/ingydotnet/git-subrepo/blob/5e0f401f877cb54c4462766eec88e3c5f23d39a6/ReadMe.pod#L131-L142 、#L179-L204
  - https://github.com/ingydotnet/git-subrepo/blob/5e0f401f877cb54c4462766eec88e3c5f23d39a6/lib/git-subrepo#L1466-L1512
- 1〜5: (1) 取れない（repo 全体）。(2) git の merge なので残り、衝突は手で直す。(3) git の merge に従う（推論）。(4) subdir ごとに並べ、`--all` でまとめて操作できる。(5) `.gitrepo`。`subrepo.parent` は monica 側の commit を指すので、squash merge で効くかは確かめていない。

### peru

- `pick`、`export`、`move` と `imports:` で、Upstream の一部を好きな場所に置ける。取り込んだ file が編集されていると "Imported files have been modified (use --force to overwrite)" で止まり、merge はしない。版は `peru.yaml` の `rev` で、`peru reup` が書き換える。
  - https://github.com/buildinspace/peru/blob/c50be018ed40ac56edd11bd9e78fa8467b992e15/README.md#L74-L131 、#L156-L211、#L203-L205
  - https://github.com/buildinspace/peru/blob/c50be018ed40ac56edd11bd9e78fa8467b992e15/peru/cache.py#L394-L399
- 1〜5: (1) 取れる。(2) Skill Patch があると止まり、`--force` なら消える。(3) 前回の tree から新しい tree へ更新し、消えた file も片付ける。(4) 並べられる。(5) `peru.yaml` の `rev`。

### agent skill 専用の道具

- kumekay/skiletto 0.4.0: `<repo>//subdir@ref` と `--skill` で選ぶが、置き場所は `.agents/skills/<name>` に固定。ローカルの編集（drift）を検出すると、`--force` が無ければ飛ばして非 0 で終わる。merge は無い。版は `skiletto.lock` の `commit` と `hash`。
  - https://github.com/kumekay/skiletto/blob/e0bf1a84f5d475d88dde90df49fa8f6b9e534d7b/README.md#L52-L64 、#L119-L129
  - https://github.com/kumekay/skiletto/blob/e0bf1a84f5d475d88dde90df49fa8f6b9e534d7b/internal/lockfile/lockfile.go#L14-L21
- luisalima/skills-lock 0.1.0: `--path` で置き場所を選べるが、install のたびに `rmSync` してから `cpSync` するのでローカルの編集は上書きされる。版は `skills-lock.json` の `commit` と `integrity`。
  - https://github.com/luisalima/skills-lock/blob/4e37719a163b6022d4a2828850567421f9de7825/README.md#L60-L105
  - https://github.com/luisalima/skills-lock/blob/4e37719a163b6022d4a2828850567421f9de7825/src/install.mjs#L89-L128

## 比較表

「試した」は scratchpad で確かめたこと、それ以外は docs とソースから読んだこと（推論を含む）。

| 候補 | 1. 一部の directory だけ | 2. Skill Patch を当てた file に Upstream の変更が来たとき | 3. 移動、Skill の追加と削除 | 4. Upstream が複数 | 5. 版の記録 |
|---|---|---|---|---|---|
| `git merge-file` + 自前の script | script が選ぶ。monica 側の形（平ら / bucket）も自由。README.md は外せた（試した） | file ごとに、ぶつからない hunk は自動で入り、ぶつかる hunk だけ marker で残る。終了コードが conflict の数（試した） | merge-file は扱わない。Skill の中の rename は `git diff -M` で対にし、追加と削除は plugin.json の差で script が決める。平らな形なら bucket の移動は見えない（試した） | Upstream ごとに lock の項目と checkout。平らな形では名前の衝突を script が検出する | 何も記録しない。base の commit を script が持つ（試作は lock file に full SHA） |
| git subtree（`split` + `--squash`） | Upstream の clone で bucket ごとに `split`。prefix ごとに 1 subtree で、平らにはできず README.md もつく（試した） | 前回の squash commit が HEAD の祖先なら git の merge で自動、衝突は index に残る（試した）。GitHub の squash merge を挟むと、2 回目から Skill Patch が conflict なしに消えた（試した） | subtree の中は rename の検出、追加、削除（modify/delete）を git がする。bucket をまたぐ移動は削除 + 追加で、Skill Patch はついてこない（試した） | Upstream と directory の組ごとに prefix | commit message の `git-subtree-dir` / `git-subtree-split`（split の合成 commit の SHA。Upstream の commit ではない） |
| skills.sh（`npx skills`） | subpath と `--skill` で選べるが、書き込み先は agent ごとの directory で repo 直下の `skills/` は選べない | Upstream が変わると Skill の directory ごと消して入れ直し、Skill Patch は警告なしに消える | 同じ名前 1 つなら移動を追う。削除は警告、追加は入らない | 1 つの lock に source ごと。同じ名前はぶつかる | `skills-lock.json` の `ref`（任意）と `computedHash`。commit SHA は無い |
| `git merge-tree --write-tree` + 自前の tree | 組む側が選ぶ（試した） | git の merge として自動、衝突は結果の tree に marker で残る（試した） | Skill の中の rename、追加、削除、modify/delete を git がする（試した） | Upstream ごとに tree を組む（推論） | 何も記録しない。base の commit と object が要る |
| Claude Code の plugin | plugin 全体。`git-subdir` で directory を指せる | cache の copy は version が変わると新しい directory に替わる。Skill Patch を残す仕組みは無い | 新しい version の中身そのもの | marketplace を並べられる | `installed_plugins.json`（repo の外） |
| `gh skill` | 選べ、`--dir` で repo 直下の `skills/` にも置ける（平ら） | Upstream が変わると中身を入れ替え、Skill Patch は消える | path か名前で探す。移動・削除は飛ばし、追加は入らない（推論） | Skill ごとの frontmatter に出所 | 各 SKILL.md の frontmatter に tree SHA を書き込む |
| copier | template 側の `_subdirectory` だけ。path は Upstream と同じ形 | 3-way で当て直し衝突だけ残すが、この Upstream は回答 file を出さないので update できない | 追加は入り、旧版にだけある file は消える。rename は追わない | template ごとに回答 file | 回答 file の `_commit` |
| vendir | `includePaths` / `newRootPath` | 丸ごと差し替えで Skill Patch は消える | Upstream のまま | 並べられる | `vendir.lock.yml` |
| git-subrepo | 取れない（repo 全体） | git の merge で残り、衝突は手で直す | git の merge に従う | subdir ごと | `<subdir>/.gitrepo` |
| peru | `pick` / `export` / `move` | 編集があると止まり、`--force` で消える | 前回の tree から更新し、消えた file も片付ける | 並べられる | `peru.yaml` の `rev` |
| skiletto / skills-lock | 選べる（skiletto は置き場所が固定） | skiletto は drift を検出して飛ばす、skills-lock は上書き。merge は無い | skiletto は SKILL.md が消えると失敗 | entry ごとに source | lock の `commit` |

## 後続の判断に効く、monica 側の事実

- monica の repo は squash merge しか許さず、main の履歴は線形。git subtree の `--squash` は前回の squash commit が HEAD の祖先にあることを前提にしていて、GitHub の squash merge を挟むと 2 回目以降の Upstream Update で Skill Patch が消えた（候補 2）。
- Claude Code の plugin は、既定で `skills/` の下の `<name>/SKILL.md` を 1 段だけ探す。plugin.json の `skills` は「`<name>/SKILL.md` の folder を並べた directory か、`SKILL.md` を直接持つ folder」を足すもので、既定の `skills/` の走査に加わる。`skills/<bucket>/<name>/` の形にするなら、`skills` に `./skills/<bucket>/` を並べることになる。
  - https://code.claude.com/docs/en/plugins-reference （Fields の `skills`、Standard layout の Skills、"Adds to the default: `skills`"）
- frontmatter（P1 の `disable-model-invocation`）は、どの候補でも本文と同じ text の行として merge され、Upstream が frontmatter を変えなければ clean に入った（候補 1、2、4 で試した）。

## 確かめていないこと

- GitHub 上の本物の squash merge。手元の `git merge --squash` と、monica の履歴にある squash commit と同じ形の message で真似ただけ。
- Upstream が履歴を書き換えたとき（force push）に、写したときの commit が Upstream の checkout から消える場合。
- 同じ bare name の Skill を 1 つの plugin に 2 つ置いたとき（subtree で bucket をまたぐ移動の途中に起きる）に Claude Code がどちらを読むか。
- skills.sh、`gh skill`、copier、vendir、git-subrepo、peru、skiletto、skills-lock の実際の動き。どれもソースと docs を読んだだけ。
- merge-file の `--diff-algorithm` を変えたときの conflict の出方の違い。試したのは既定（myers）だけ。
