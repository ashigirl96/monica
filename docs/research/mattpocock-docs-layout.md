# mattpocock-skills が想定する docs の置き場と、docs/packages の移し先

2026 年 10 月 15 日時点で、次の 4 点を一次資料で確かめた。

- mattpocock-skills の各 skill が、作業の途中でどの path の文書を読み書きするか
- GLOSSARY・ADR・`docs/agents/`・CLAUDE.md・CODING_STANDARDS.md・skill のそれぞれに何を書き、何を書かないか
- 手元の 1.3.1 より新しい upstream で、置き場の想定が変わったか
- monica の `docs/packages.md` と `docs/packages/*.md` の中身がそのどれに当たるか、消すと壊れる参照、同期の負担

資料は次の 3 つ。

- 手元の plugin `~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.3.1/`。manifest の版は 1.3.1 だが、`~/.claude/plugins/installed_plugins.json` の `gitCommitSha` は upstream の `f3fc563`（2026-10-07）で、tag `v1.3.1`（`24fe0ef`、2026-10-04）より後の commit を含む。以下、plugin の file は plugin の root からの path に `mp:` を付けて `mp:skills/engineering/retro/SKILL.md:41` のように書く。`mp:docs/` は upstream が人向けに書いた各 skill の docs page。
- upstream の `mattpocock/skills` を scratchpad に clone したもの。HEAD は `49dd158`（2026-10-09）。
- monica の repo。数字と行番号はすべて main の `48c82ec`（2026-10-15）で取った。調べている間に #398 が main に入り、checkout が `dc3aaad` から進んだため。monica の file は repo の root からの path で書く。

## 結論

1. mattpocock-skills が名前で読み書きする置き場は 6 つある。`GLOSSARY.md`（または `GLOSSARY-MAP.md`）、`docs/adr/`、`docs/agents/*.md`、`CLAUDE.md` か `AGENTS.md`、`CODING_STANDARDS.md` か `CONTRIBUTING.md`、issue tracker（spec・ticket・wayfinder の map）。`docs/packages.md` と `docs/packages/` を名前で読む skill は無い。docs/packages が agent に届く経路は、monica の CLAUDE.md の 1 行（`CLAUDE.md:3`）、CODING_STANDARDS.md の 12 か所の括弧書き、code-review が「how code should be written」を書いた file を探す検索の 3 つだけになる（「1. skill ごとの読み書き」）。
2. skill が想定する書き分けは次のとおり。用語は GLOSSARY に書き、実装の詳細は書かない。理由のある決定は、戻しにくい・文脈なしでは意外・本当の trade-off、の 3 条件を満たすものだけ ADR にする。review で当てる判断の規則は CODING_STANDARDS.md に、機械で判定できる規則は lint・hook・CI に置く。手順は skill に、CLAUDE.md には navigation pointer だけを置く。spec は issue tracker に、調べた事実は repo が調査メモを置く場所に書く。今のコードの振る舞いを書き続ける文書の置き場は、どの skill にも無い。writing-for-agents は、環境（script・config・`--help`）を写した文書を cache と呼ぶ。そのうえで、見ても分からないもの（書かれていない慣習、選んだ理由、config が言わない gotcha）だけを書けと言う（「2. 置き場ごとに書くもの」）。
3. upstream の HEAD（`49dd158`）まで、置き場の想定は変わっていない。`CONTEXT.md` から `GLOSSARY.md` への rename は v1.3.0 で済んでいて（`d80fa0f`、2026-08-15）、monica は既に `GLOSSARY.md` を使っている。tag v1.3.1 より後の変更で docs に関わるのは、code-review が standards の file を repo から「探す」ようになったこと（`3da8c01`）だけ。CODING_STANDARDS.md があれば必ず読む（「3. upstream の新しい版」）。
4. docs/packages の 2,353 行を節ごとの主な種類で数えると、約 1,800 行（76%）が今のコードの説明になる。contract の一覧、関数の deps、file ごとの振る舞い、UI の振る舞いがこれに当たる。残りは、手順と dev の仕組みが約 130 行、判断の要る規約とテストの書き方が約 105 行、repo 全体の形（配置・entry・依存の向き・server entry の形）が約 100 行、実機で確かめた事実が約 90 行、節ごと ADR の言い直しのものが約 55 行。中の文には「ため」で終わる理由が 285 個、ADR の番号が 185 回出てくる（「5. 中身の種類と移し先」「6. file と節ごとの仕分け」）。
5. 同期の負担は大きい。2026-10-03 から `48c82ec` までに code を変えた commit は 158 本あり、そのうち 131 本（83%）が docs/packages も直した。docs/packages を触った commit は 145 本で、変わった行は合わせて 5,765 行になる。さらに `docs/agents/issue-tracker.md:11` が、issue を作る前に直す docs を挙げることを求めている。それでも `docs/packages.md:70` は、2026-10-08（`6106d23`）から 1 つも無い `packages/<d>/skills/` を今も載せている（「7. 同期の負担」）。
6. docs/packages を全部消すと、外の 22 file・80 行の参照が壊れる。このうち、agent が作業中に辿るもの（lint の message 28 行、CODING_STANDARDS.md 12 行、project skill 9 行、code の comment 4 行、CLAUDE.md 1 行）は 12 file・54 行で、必ず直す。残りの 26 行は ADR と docs/research の記録で、そのうち 5 行は commit 固定の URL なので壊れない（「8. 消すと壊れる参照」）。
7. 推奨は案 B にする。domain ごとの 16 本は消し、中身は GLOSSARY・ADR・CODING_STANDARDS.md・lint・テスト・project skill・docs/research のどれかに移すか捨てる。code の comment には移さない（結論 8）。repo 全体の形だけを `docs/packages.md` に 60〜80 行で残し、CLAUDE.md からは条件付きの pointer で指す。docs/ に置いた参照文書を CLAUDE.md の pointer で指す形は、retro が書く形そのままになる（`mp:skills/engineering/retro/SKILL.md:41-43`）。`docs/packages.md` の path と entry の節を残せば、lint の message 20 行はそのまま使える（「9. 方法の候補」「10. 推奨」）。
8. docs/packages の中の理由の文（「〜ため」）は、code の comment に移さない。comment は誰も確かめないまま増え続け、docs と同じく古くなるため。mattpocock-skills は code の comment について何も書いていない（`mp:skills` と `mp:docs` を grep して 0 件）。理由の文の行き先は、それが守るもので決める。振る舞いを守るものはテスト（無ければ足す。tdd の「A good test reads like a specification」、`mp:skills/engineering/tdd/SKILL.md:14`）、機械で判定できる形は lint、戻しにくく意外な決定は ADR、実機の事実は `docs/research/` に置く。どれにも当たらないものは捨て、git の履歴に任せる。ADR-FORMAT の「If a decision is easy to reverse, skip it: you'll just reverse it.」（`mp:skills/engineering/domain-modeling/ADR-FORMAT.md:37`）と同じ考え方になる。

## 1. skill ごとの読み書き

この表の「読む」「書く」は、各 SKILL.md が path か file 名で名指すもの。

| skill | 読む | 書く | 根拠 |
|---|---|---|---|
| setup-matt-pocock-skills | `git remote`、CLAUDE.md・AGENTS.md、GLOSSARY.md・GLOSSARY-MAP.md、`docs/adr/`、`docs/agents/`、`.scratch/` | CLAUDE.md（無ければ AGENTS.md）の `## Agent skills`、`docs/agents/issue-tracker.md`・`domain.md`・`triage-labels.md` | `mp:skills/engineering/setup-matt-pocock-skills/SKILL.md:21-30`、`:74-114` |
| domain-modeling | GLOSSARY.md（GLOSSARY-MAP.md）、`docs/adr/`、code | GLOSSARY.md、`docs/adr/NNNN-slug.md` | `mp:skills/engineering/domain-modeling/SKILL.md:10-40`、`:60-74`、`ADR-FORMAT.md:3` |
| grill-with-docs | grilling と domain-modeling を呼ぶだけ | domain-modeling と同じ | `mp:skills/engineering/grill-with-docs/SKILL.md:7` |
| improve-codebase-architecture | `git log`、GLOSSARY.md、`docs/adr/` | OS の temp に HTML。GLOSSARY と ADR は domain-modeling を通して書く | `mp:skills/engineering/improve-codebase-architecture/SKILL.md:14`、`:23-25`、`:39`、`:66-70` |
| codebase-design | 名指す file は無い（語彙の reference）。design-it-twice の brief に GLOSSARY.md の語を入れる | なし | `mp:skills/engineering/codebase-design/DESIGN-IT-TWICE.md:30` |
| code-review | issue tracker の文書。commit が挙げる issue。`docs/`・`specs/`・`.scratch/` の spec。how code should be written を書いた file すべてで、CODING_STANDARDS.md と CONTRIBUTING.md があれば必ず入れる | なし（報告だけ） | `mp:skills/engineering/code-review/SKILL.md:13`、`:27-32`、`:36-41` |
| implement | issue tracker の ticket | commit。tdd と code-review を呼ぶ | `mp:skills/engineering/implement/SKILL.md:9-17` |
| implement-spec | spec と ticket | repo の外の調査メモ、integration branch | `mp:skills/engineering/implement-spec/SKILL.md:9`、`:15`、`:23` |
| to-spec | GLOSSARY の語、触る領域の ADR | issue tracker の spec。file の path と code の断片は書かない | `mp:skills/engineering/to-spec/SKILL.md:9`、`:13`、`:19`、`:55` |
| to-tickets | GLOSSARY の語、ADR | issue tracker の ticket。local なら `.scratch/<feature>/issues/` | `mp:skills/engineering/to-tickets/SKILL.md:11`、`:21`、`:62-63`、`:105` |
| triage | issue、GLOSSARY、ADR、`.out-of-scope/*.md` | label と comment。GLOSSARY と ADR は domain-modeling を通して書く。断った要望は `.out-of-scope/` に書く | `mp:skills/engineering/triage/SKILL.md:43`、`:70`、`:76`、`:85` |
| wayfinder | issue tracker の文書の「Wayfinding operations」、map | map と child issue、research の branch | `mp:skills/engineering/wayfinder/SKILL.md:21-25`、`:115` |
| tdd | GLOSSARY.md、ADR | test | `mp:skills/engineering/tdd/SKILL.md:10` |
| research | 一次資料 | repo が既にそういうメモを置いている場所に Markdown を 1 本 | `mp:skills/engineering/research/SKILL.md:10-12` |
| diagnosing-bugs | GLOSSARY.md、ADR | | `mp:skills/engineering/diagnosing-bugs/SKILL.md:10` |
| pr | GLOSSARY.md | PR の本文 | `mp:skills/engineering/pr/SKILL.md:37` |
| retro | session の log、`package.json` の script と CI、CLAUDE.md・AGENTS.md、CODING_STANDARDS.md | 提案だけ（check、CODING_STANDARDS.md の規則、pointer、skill） | `mp:skills/engineering/retro/SKILL.md:13`、`:18-23`、`:41-44` |
| writing-for-agents | 書き方の reference | skill、AGENTS.md・CLAUDE.md、pointer で辿る文書 | `mp:skills/productivity/writing-for-agents/SKILL.md:6` |
| wait-what | GLOSSARY.md（GLOSSARY-MAP.md） | | `mp:skills/productivity/wait-what/SKILL.md:7` |
| handoff | spec・plan・ADR・issue を path か URL で指す | handoff の文書 | `mp:skills/productivity/handoff/SKILL.md:12` |

monica の `/tackle` は implement の代わりに使う project skill で、ticket の取り方として `docs/agents/issue-tracker.md` を読み（`.claude/skills/tackle/SKILL.md:7`）、tdd・code-review・pr を呼ぶ（`:11`、`:15`、`:17`）。docs/packages は名指さない。

この表から外れる置き場に置いた規則は、skill の手順からは見えない。docs/packages は CLAUDE.md の「全文を読み」（`CLAUDE.md:3`）で毎 session 読ませているので、届いてはいる。ただしこれは、writing-for-agents が context load と呼ぶ、毎 turn かかる費用になる（`mp:skills/productivity/writing-for-agents/SKILL.md:24`）。

## 2. 置き場ごとに書くもの

### GLOSSARY.md

- 単一の context なら repo の root に 1 本置き、無ければ最初の語が決まった時に作る（`mp:skills/engineering/domain-modeling/SKILL.md:12-22`、`:40`）。
- 「`GLOSSARY.md` should be totally devoid of implementation details. Do not treat `GLOSSARY.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.」（`mp:skills/engineering/domain-modeling/SKILL.md:64`）
- 定義は 1〜2 文で、何であるかを書き、何をするかは書かない。この context に固有の語だけを入れ、一般的なプログラミングの概念は入れない（`mp:skills/engineering/domain-modeling/GLOSSARY-FORMAT.md:28-29`）。

### ADR

- `docs/adr/` に通し番号で置く（`mp:skills/engineering/domain-modeling/ADR-FORMAT.md:3`）。本文は 1〜3 文でよい（`:12`、`:15`）。
- 戻しにくい・文脈なしでは意外・本当の trade-off の結果、の 3 条件がすべてそろうときだけ書く（`:29-37`）。当たる例は、architecture の形、context の間の連携、lock-in のある技術、境界と範囲の決定、ふつうの道から意図して外れたこと、code から見えない制約、外した候補（`:39-47`）。
- upstream の docs page は、ADR に書かないものとして「A diary of every choice made this session」を、GLOSSARY に書かないものとして実装の詳細・spec・scratch pad・一般的な概念を挙げる（`mp:docs/engineering/domain-modeling.md:40`）。

### docs/agents/

- setup が書くのは issue tracker・triage の label・domain docs の置き方の 3 つだけ（`mp:skills/engineering/setup-matt-pocock-skills/SKILL.md:9-13`）。
- upstream の docs page は「Those files are the only thing that varies between repos.」と書き（`mp:docs/engineering/setup-matt-pocock-skills.md:5`）、ほかの好みは CLAUDE.md に書けと言う（`:74`）。docs/agents はコーディング規約の置き場ではない。

### CLAUDE.md・AGENTS.md

- 「These files are pushed to the context window of any agent working in this repo. They should be used incredibly sparingly, usually only for **navigation pointers** to other files.」（`mp:skills/engineering/retro/SKILL.md:41`）
- 同じ行が繰り返すミスへの対処として CLAUDE.md に 1 行足すべきかには、「Usually not」と答える。機械で判定できるミスは失敗する check に、判断の要るものは reviewer が読む規約に回す（`mp:docs/engineering/retro.md:49-51`）。
- pointer の書き方は、何の文書かと、いつ辿るかの分岐を書く（`mp:skills/productivity/writing-for-agents/SKILL.md:12-18`）。毎 session 読むか、pointer の 1 行で済ませるかは、どちらの費用を払うかで決める（`mp:docs/productivity/writing-for-agents.md:49-50`）。

### CODING_STANDARDS.md

- review のときに読む file で、実装のときには読まない（`mp:skills/engineering/retro/SKILL.md:42`）。規約を課すのは、context の余裕がある reviewer の役目になる（`:29-35`）。
- code-review の Standards の軸は「every file that documents how code should be written」を探し、CODING_STANDARDS.md があれば必ず入れる（`mp:skills/engineering/code-review/SKILL.md:36`）。tooling が強制するものは見ない（`:41`、`:66`）。
- retro は違反をまず分ける。機械で判定できるもの（構文の形、禁じた API、import の形、file の置き場）は lint・pre-commit・CI の check にする。CODING_STANDARDS.md に書くのは、判断が要るものだけにする（`mp:skills/engineering/retro/SKILL.md:19`）。

### skill

- 「use skills for docs (since their description goes into the agent's context window), or for user-invoked commands」（`mp:skills/engineering/retro/SKILL.md:44`）。
- 環境（`package.json` の script、config、directory の形、`--help`）も正本で、それを写した文書は cache になる。cache してよいのは見ても分からないもの、つまり書かれていない慣習、選んだ理由、config が言わない gotcha だけ（`mp:skills/productivity/writing-for-agents/SKILL.md:79`）。

### spec と ticket

- spec は issue tracker に publish する（`mp:skills/engineering/to-spec/SKILL.md:19`）。spec にも ticket にも file の path と code の断片を書かない。すぐ古くなるため（`mp:skills/engineering/to-spec/SKILL.md:55`、`mp:skills/engineering/to-tickets/SKILL.md:105`、`mp:skills/engineering/triage/AGENT-BRIEF.md:13-17`）。
- 決めきれない先の見通しは、wayfinder の map の「Not yet specified」に書く（`mp:skills/engineering/wayfinder/SKILL.md:46-48`、`:82-93`）。map は index で、中身は持たない（`:23`）。
- 実装の後に振る舞いを書き続ける文書は、どの skill にも無い。tdd は、よい test は仕様のように読めると書く（`mp:skills/engineering/tdd/SKILL.md:14`）。

### 調べた事実

- research は「Save it where the repo already keeps such notes」と書く（`mp:skills/engineering/research/SKILL.md:12`）。monica では `docs/research/` がそれに当たる。
- upstream の docs page は、research が返すのは日付のある短命な事実で、ADR は残す決定だと分ける（`mp:docs/engineering/research.md:21`）。そのうえで「ADRs yes. Everything else archive or delete after done.」を community の見方として引く（`:41`）。

### module の interface と docs

- codebase-design は interface を「everything a caller must know to use the module correctly」と定義する。型の signature のほかに、不変条件、順序の制約、error の型、要る設定、性能の性質を含める（`mp:skills/engineering/codebase-design/SKILL.md:16`）。
- 文書をどこに置くかは言わない。不変条件を module の doc comment に書くのは、この定義からの推測で、skill の指示ではない。

### package の README

- shipped の skill は package の README を扱わない。
- 例外は in-progress の bucket の setup-ts-deep-modules で、package の root に README を置き、CLAUDE.md から 1 行で指させる。理由は「This is what makes an agent discover the boundary rule instead of tripping over it.」（`mp:skills/in-progress/setup-ts-deep-modules/SKILL.md:91-95`）。in-progress は plugin に載らず、予告なく変わる（`mp:skills/in-progress/README.md:3`）。

## 3. upstream の新しい版

- 手元の plugin（`f3fc563`）と upstream の HEAD（`49dd158`）は、`skills/` の中では `skills/engineering/wizard/template.sh` しか違わない（diff で確かめた）。HEAD 側の 2 commit（`8267225`、`49dd158`）は、wizard と `.out-of-scope/` の変更だった。
- tag v1.3.1（`24fe0ef`）から手元の plugin までの間に、docs に関わる変更は 1 つある。code-review の手順が「such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`」から「Search the repo for every file … When `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists, it must be on the list.」に変わった（`3da8c01`、PR #1208）。CODING_STANDARDS.md を読み落とした報告（issue #1065）への対応になる。同じ commit で、`docs/agents/issue-tracker.md` を名指す文が「the tracker doc」に変わった。
- `CONTEXT.md`・`CONTEXT-MAP.md` から `GLOSSARY.md`・`GLOSSARY-MAP.md` への rename は `d80fa0f`（2026-08-15）で、v1.3.0 から入っている（`mp:CHANGELOG.md:31-33`）。
- v1.3.1 から HEAD まで、domain-modeling、writing-for-agents、retro、codebase-design、research の各 skill の file は変わっていない。`docs/agents/` の扱いも、setup が label を作るようになったこと以外は同じ。
- 置き場の想定を変える open な issue は見つからなかった。`archive/` という置き場を足す提案（#1031）は「`research` already saves to wherever your repo keeps such notes」として閉じられた。

## 4. monica の今の形

- `CLAUDE.md:3` は、`docs/packages.md` の全文を読み、索引から作業の範囲の文書を開けと言う。`docs/packages.md` は 177 行。
- `docs/packages.md:3` は「規則を変える変更は、同じ PR でここと `docs/packages/` の文書を今の形に直す」と定める。`docs/agents/issue-tracker.md:11` も、issue を作る前に、直す docs を `docs/` と `CODING_STANDARDS.md` の `git grep` で挙げさせる。
- `CODING_STANDARDS.md:3` は、判断が要る規則だけを書き、決定の本文と理由は括弧の中の文書（ADR と docs/packages）に任せる、と定める。機械で判定できる規則は lint・型・テストに置く。これは retro の分け方（`mp:skills/engineering/retro/SKILL.md:19`）と同じ。
- GLOSSARY.md（260 行）は GLOSSARY-FORMAT の形（`**語**:`、1〜2 文、`_Avoid_`）に沿っている。
- ADR は 38 本。ADR-0026 は Upstream の Skill を repo 直下の `skills/` に写して Skill Patch を当てると決めたが、`48c82ec` に `skills/` はまだ無く、#239（wayfinder:map）が open のまま。`.claude-plugin/plugin.json` の `skills` は空。
- project skill は `.claude/skills/` に 10 本（add-job、backend-headless、desktop-dev、extension-dev、install-app、release-notifications、retro、tackle、teach-me、watch-ai）ある。
- docs/packages の始まりは 2026-10-03 の設計の commit 群（「パッケージ構成と dev loop を決める（#20）」など 12 本。どれも docs だけを変えた）で、wayfinder の判断の置き場だった。その後、2026-10-05 に節ごとの文書に分け（#92）、2026-10-08 にコードとずれた記述を直しながら `docs/packages/` に移した（#236）。今は code と一緒に直す、生きた仕様になっている。

## 5. 中身の種類と移し先

| 種類 | docs/packages での例 | 移し先 | 根拠 |
|---|---|---|---|
| 用語の定義 | ほとんど無い。GLOSSARY の語を使って書いている。GLOSSARY に無いまま多く使う語は、ブラウザの口（44 回）、token の口（30）、spare（49）、合図（39）、Pinned（26）、起動中の予約（13）、ActiveRun などの close の guard の名前 | GLOSSARY.md。入れるかは domain-modeling で決める。spare や合図のように実装の一般語に近いものは入れない | `mp:skills/engineering/domain-modeling/GLOSSARY-FORMAT.md:28-29` |
| ADR がある決定の言い直し | `docs/packages/migration.md:24-27` と ADR-0010:16-19。`docs/packages.md:130-137` と ADR-0009:12、:17-20。`docs/packages.md:57` と ADR-0002:13 と `CODING_STANDARDS.md:8` が同じ文を 3 か所で持つ | ADR だけに残し、言い直しは消す | 「Keep each meaning in a single source of truth」（`mp:skills/productivity/writing-for-agents/SKILL.md:78`） |
| ADR の無い決定 | note・chat・usage は他の domain を import しない（`.oxlintrc.json` の message が docs/packages を指す）。tsconfig に入れない option の理由（`docs/packages/dev-loop.md:99`）。xterm を 6.1 の beta に固定する理由（`docs/packages/desktop.md:9`） | 3 条件を満たすものだけ ADR にする。境界の決定（他の domain を import しない）は条件に当たりうる。戻しやすいものは消す（理由は git の履歴に残る） | `mp:skills/engineering/domain-modeling/ADR-FORMAT.md:29-47` |
| lint・test・型が強制する規則の言い直し | `docs/packages.md:99-108`（境界ごとに守り手の lint と test を並べた一覧）。contract の規約の 2 と 3（`apps/cli/src/contract.test.ts` などが見る）。`docs/packages/extension.md:82-86` | 規則の文は lint の message と test の名前が持つので消す。ただし、どこに何を置いてよいか（entry の表と依存の向き）は lint に当たる前に要るので、横断の参照文書に残す | `mp:skills/engineering/code-review/SKILL.md:41`、`mp:skills/engineering/retro/SKILL.md:19`、`mp:skills/productivity/writing-for-agents/SKILL.md:79`。残す側の根拠は in-progress だけ（`mp:skills/in-progress/setup-ts-deep-modules/SKILL.md:93`） |
| 判断の要る規約・テストの書き方 | `docs/packages.md:139-158`（テスト）、`:160-172`（contract の規約）。`docs/packages/workbench-ledger.md:51-60`（合図は行を書いた関数が出す）。`docs/packages/note-ui.md:5-16`（旧 Monica のコードを移すとき）。`docs/packages/cli.md:9-11`（command の名前、stderr の 1 行目、exit code） | CODING_STANDARDS.md。そのうち機械で判定できるもの（`jest.useFakeTimers` を使わない、`process.env.TZ` の戻し方、`oc.$meta` を contract.ts の外に書かない）は lint にする | `mp:skills/engineering/retro/SKILL.md:19`、`:42`、`mp:skills/engineering/code-review/SKILL.md:36` |
| 手順と dev の仕組み | `docs/packages/dev-loop.md`（dev の起動、release、install、check）、`docs/packages/extension.md:39-81`（鍵、読み込み方）、`docs/packages/job-ledger.md:66-86`（claude を呼ぶ Job の script） | agent が踏む手順は project skill に置く。desktop-dev、backend-headless、extension-dev、install-app、release-notifications、add-job が既に持っている。script の中の仕組みは script が正本 | `mp:skills/engineering/retro/SKILL.md:44`、`mp:skills/productivity/writing-for-agents/SKILL.md:79` |
| 今のコードの説明 | contract の一覧、`create<D>Ledger` の deps、file と関数の一覧、Run の起動の順、UI の振る舞い | 消す。code と test が正本。振る舞いを守る理由と module をまたぐ不変条件は、それを戻すと落ちるテストがあるかを確かめ、無ければテストを足してから消す | 消す側は `mp:skills/productivity/writing-for-agents/SKILL.md:79-80`（cache、sediment）と `mp:skills/engineering/to-spec/SKILL.md:55`。テストに持たせる側は `mp:skills/engineering/tdd/SKILL.md:14`。生きた仕様の置き場は、skill は扱わない |
| 実機で確かめた事実と、確かめていないこと | `docs/packages/chat.md:236-244`、`:346-375`、`:402-415`、`:503-524`。`docs/packages/dev-loop.md:55-58`（binary の大きさ）。`docs/packages/notifications.md:30`（手元の 87 件の transcript の計測） | `docs/research/` | `mp:skills/engineering/research/SKILL.md:12`、`mp:docs/engineering/research.md:21` |
| 未決 | `docs/packages.md:174-177`（設定、`$MONICA_HOME` のレイアウト、ログ、署名と notarization） | wayfinder の map の「Not yet specified」か issue | `mp:skills/engineering/wayfinder/SKILL.md:46-48` |
| 索引と pointer | `docs/packages.md:5-24`、`CLAUDE.md:3` | CLAUDE.md の pointer。いつ辿るかの条件を書く | `mp:skills/engineering/retro/SKILL.md:41`、`mp:skills/productivity/writing-for-agents/SKILL.md:12-18` |
| repo 全体の形 | `docs/packages.md:26-129`（配置、package の中、entry の表、依存の向き、server entry の形） | 横断の参照文書として残す。列挙（script の一覧、testing entry が出す関数の名前）は削り、規則だけにする | 「Docs: use docs as references files, pointed to by other files.」（`mp:skills/engineering/retro/SKILL.md:43`） |

「今のコードの説明」の中にも、ADR の言い直しと理由の文が混ざっている。例として、`packages/task/src/run-admission.ts:395` の comment は、`docs/packages/task-ledger.md:128-129` と同じ理由（Bench より前の Run と、transcript の無い Agent Session を resume しない）を既に持っている。code の非 test の comment で「ため」を含む行は 50 行あり、docs/packages の 285 個の「ため」の一部はすでに code にもある。どこまで重なっているかの全数は数えていない。理由の文を消すときは comment に写さず、結論 8 の行き先に振り分ける。

## 6. file と節ごとの仕分け

種類は節ごとの主なもの。行は `48c82ec` のもの。

| file（行数） | 節（行） | 種類 | 移し先 |
|---|---|---|---|
| `docs/packages.md`（177） | 冒頭と索引（1-25） | 索引 | 消す。同期の規則（:3）も消える |
| | 配置、ドメイン package の中（26-80） | 横断 | 残す。script の列挙（:34）と、無い `skills/`（:70）は削る |
| | entry（81-109） | 横断・強制済み | 表（:85-95）は規則だけにして残す。testing entry が出す関数の名前は削る。守り手の一覧（:99-108）は消す |
| | server entry の形（112-128） | 横断 | 残す。chat と systemJobs の細部は削る |
| | domain をまたぐ規則（130-137） | ADR 重複・強制済み | 消す。ADR-0009:12、:17-20 と lint の `monica/cross-domain-write`・`monica/sync-transaction` が持つ |
| | テスト（139-158） | 規約 | CODING_STANDARDS.md の「テスト」に移す。fake timers と TZ は lint の候補 |
| | contract の規約（160-172） | 規約・強制済み | 1・4・5・6・7 は CODING_STANDARDS.md に移す。6 は lint の候補。2・3 は contract の test が見るので消す |
| | ここで決めていないこと（174-177） | 未決 | 消す。要るなら map か issue にする |
| `backend.md`（61） | 全節 | 説明（ADR-0007・0017・0028・0034・0035 の言い直しを含む） | 消す。PATH を login shell から取ることのように振る舞いを守る理由は、それを戻すと落ちるテストがあるか確かめ、無ければ足す |
| `chat.md`（524） | 確かめていないこと、確かめたこと、実機で確かめたこと（236-244、346-375、402-415、503-524、計 75 行） | 事実 | `docs/research/` に 1 本で移す。SDK を上げるときにやり直す対象（`docs/packages/dev-loop.md:97` が指す）になる |
| | claude の options と env（40-79） | 説明 | 表の「理由」の列は、ADR-0033 にあるものは消す。無いものは、その option を外すと落ちるテストがあるか確かめ、無ければ足す。残りは消す |
| | ui の外部部品の写し（420-435） | 説明 | 写した元の commit と file の一覧は、写した directory の中に残す。置き場は skill は扱わない |
| | その他（contract、spare、Page Snapshot、失敗、ui、テスト） | 説明 | 消す |
| `cli.md`（37） | command の名前、stderr の 1 行目、exit code（9-11） | 規約 | CODING_STANDARDS.md に移す。Skill が読む interface（ADR-0003）になる |
| | skill-check の検査の中身（24-30） | 強制済み | 消す。`apps/cli/src/skill-check.test.ts` が正本 |
| | zsh の補完を手で確かめる方法（17） | 手順 | skill に移す |
| | その他 | 説明 | 消す |
| `desktop.md`（52） | Shell に置くもの（45） | ADR 重複 | 消す。ADR-0001 と `CODING_STANDARDS.md:26` にある |
| | xterm の版の固定と kitty（7-9） | ADR の無い決定 | 消す。版を戻すと kitty の keyboard が壊れるなら、それを見るテストがあるか確かめる |
| | Workbench の slot（28-41） | 説明 | 消す |
| | その他 | 説明 | 消す |
| `dev-loop.md`（100） | dev loop、release build と install（3-69） | 手順・説明 | agent の手順は desktop-dev・backend-headless・extension-dev・install-app にある。script の仕組みは script が正本なので消す |
| | binary の大きさ（55-58） | 事実 | `docs/research/` に移す |
| | 検査と CI（71-91） | 手順・規約 | テストで実行 file を exec する規則（80-83）は CODING_STANDARDS.md の「テスト」に移す。変異で確かめるときの控えと `touch`（88-89）は tackle の skill に移す。`check:brief` は tackle が既に書く。残りは消す |
| | 版（93-100） | ADR の無い決定 | 消す。理由は版を固定した commit に残る。`@orpc/*` と SDK の固定は ADR-0003・0032 にある |
| `extension.md`（86） | manifest と permission（5-15） | 説明 | 消す。permission を足すと落ちるテストがあるか確かめ、無ければ足す |
| | ID と鍵（39-55） | 説明・手順 | ID は `apps/desktop/src-tauri/src/native_host.rs` と `vite.config.ts` が持つ。鍵の作り直しは extension-dev の skill に移す |
| | 出力の dir（56-62） | ADR 重複 | 消す（ADR-0029） |
| | dev と release の読み込み方（64-80） | 手順 | extension-dev と release-notifications の skill に移す。reload 前の Brave の振る舞いが未確認であること（80）は research か issue にする |
| | `chrome` の型と lint（82-86） | 強制済み | 消す |
| `job-ledger.md`（113） | claude を呼ぶ Job の成否（66-86） | 手順 | add-job の skill に移す |
| | その他 | 説明 | 消す（ADR-0016、contract の description、`user-job.ts`・`command.ts`） |
| `migration.md`（27） | 全体 | ADR 重複・手順 | 消す（ADR-0010:15-20）。table の無い package の journal の置き方（23）は、横断の文書の「package を足すとき」に 1 行で残す |
| `note-ledger.md`（240） | 全節 | 説明 | 消す。画像の名前の照合、SVG を断ること、markdown の escape の規則は、それを見るテストがあるか確かめ、無ければ足す。「旧 Monica から変えた点」は経緯なので消す |
| | テスト（223-240） | 規約・説明 | GFM の読みを `gh api markdown` で突き合わせる方法は CODING_STANDARDS.md の「テスト」に移す。残りは消す |
| `note-ui.md`（279） | 旧 Monica のコードを移すとき（5-16） | 規約・手順 | 移植がまだ続くなら CODING_STANDARDS.md の 1 節に移す。`git diff --no-index` の取り方は skill に移す。続かないなら消す |
| | その他 | 説明 | 消す（ADR-0018 の言い直しを含む） |
| `notifications.md`（86） | 全節 | 説明・ADR 重複 | 消す（ADR-0013・0022・0025）。「87 件で 33 KiB 以内」（30）は research に移す |
| `tab-env-and-shim.md`（57） | 全節 | 説明 | 消す。payload の話（50-57）は `docs/research/hook-payloads.md` にある |
| `task-ledger.md`（205） | 全節 | 説明 | 消す。module をまたぐ不変条件（起動中の予約、close の予約）は、それを破ると落ちるテストがあるか確かめ、無ければ足す |
| | テスト（195-205） | 説明・規約 | fake の作り方は fake の code が正本なので消す。起動中の予約を外してから次の `run` を呼ぶ規則（204）は CODING_STANDARDS.md の「テスト」に移す |
| `usage.md`（45） | 全節 | 説明 | 消す（ADR-0037、`packages/usage/src`） |
| `workbench-ledger.md`（163） | 合図（51-60） | 規約 | CODING_STANDARDS.md に移す（`CODING_STANDARDS.md:24` と合わせる） |
| | 他の domain が呼ぶ書き込み（61-70） | 横断 | 横断の文書の server entry の形に 2〜3 行で残す |
| | その他 | 説明 | 消す（ADR-0008・0011・0012・0014・0015・0020・0021・0023） |
| `workbench-ui-state.md`（101） | 全節 | 説明 | 消す（`navigation.ts` の `navigate`、`keys.ts`、ADR-0014・0021・0022） |

行数の概算（節ごとの主な種類で数えたもの）:

| 種類 | 行 | 割合 |
|---|---|---|
| 今のコードの説明 | 約 1,800 | 76% |
| 手順と dev の仕組み | 約 130 | 6% |
| 判断の要る規約・テストの書き方 | 約 105 | 4% |
| repo 全体の形 | 約 100 | 4% |
| 実機で確かめた事実 | 約 90 | 4% |
| 節ごと ADR の言い直し | 約 55 | 2% |
| 強制済みの規則の言い直し、索引、未決 | 約 55 | 2% |

GLOSSARY と ADR に新しく足す候補は少ない。GLOSSARY は、上の表の未登録の語を domain-modeling で 1 語ずつ決める。ADR は、葉の domain（note・chat・usage・job）が他の domain を import しない決定が、ADR-FORMAT の「Boundary and scope decisions」（`mp:skills/engineering/domain-modeling/ADR-FORMAT.md:44`）に当たりうる。今は ADR が無く、`.oxlintrc.json` の 7 行の message が docs/packages を指している。

## 7. 同期の負担

`48c82ec` までの `git log` を数えた。code を変えた commit とは、`docs/`・`GLOSSARY.md`・`CODING_STANDARDS.md`・`CLAUDE.md`・`.claude/` の外の file を変えた commit を指す。

| 数えたもの | 数 |
|---|---|
| 2026-10-03 から `48c82ec` までの commit | 233 |
| そのうち code を変えた commit | 158 |
| そのうち docs/packages も直した commit | 131（83%） |
| docs/packages を触った commit（全期間） | 145 |
| そのうち code も変えた / docs だけ | 131 / 14（docs だけの 12 本は 2026-10-03 の設計、残りは分割の #92 と #236） |
| そのうち test も変えた | 105 |
| そのうち ADR・GLOSSARY・CODING_STANDARDS も変えた | 33・25・25 |
| docs/packages の 2 file 以上を直した commit | 64 |
| docs/packages で変わった行（足した行と消した行の和） | 5,765（commit ごとの中央値 12、最大 927 は #236 の分割） |

file ごとの変更回数は、`docs/packages.md` 90、`task-ledger.md` 33、`dev-loop.md` 23、`workbench-ledger.md` 21、`desktop.md` 21、`note-ui.md` 20、`workbench-ui-state.md` 18、`note-ledger.md` 15、残りは 11 以下だった。`docs/packages.md` は分割の後（2026-10-08 以降）も 25 回直されている。中身は script の一覧、entry の表の行、testing entry が出す関数の名前、テストの規約の追記だった（commit の題で見た）。

同期の負担は、規則の文が増えるほど増える。docs/packages は今の code の振る舞いを書くので、振る舞いを変える PR のほとんどが直すことになる。それでも漏れは出ている。`docs/packages.md:70` の package の中の図は、2026-10-08 に最後の Skill を消して（`6106d23`）から 1 つも無い `skills/<name>/SKILL.md` を今も載せている。writing-for-agents の言う sediment（`mp:skills/productivity/writing-for-agents/SKILL.md:80`）に当たる。

## 8. 消すと壊れる参照

`docs/packages.md` と `docs/packages/` の外で、`docs/packages` を含む行を `git grep` した（`48c82ec`）。22 file・80 行あった。docs/packages の中どうしの参照も 120 行あるが、一緒に消える。テストや script が docs を読むことは無い（`chat.test.ts:100` は comment）。

| 参照元 | 行 | 何が壊れるか | 直し方 |
|---|---|---|---|
| `.oxlintrc.json` | 26 | lint の message の括弧の中の pointer。文は 4 種類で、「cli entry を import するのは apps/cli だけ（docs/packages.md の entry）」が 19 行、note・chat・usage を他の domain から隔てる message が 7 行 | entry の節を `docs/packages.md` に残せば 19 行はそのまま使える。7 行は、新しい ADR か `docs/packages.md` の依存の向きの節を指すか、pointer を外す |
| `scripts/oxlint/monica.js:164`、`:199` | 2 | `monica/cross-domain-write`（「domain をまたぐ規則」を指す）と `monica/testing-entry`（entry の節を指す）の message | `:164` は ADR-0009 を指す。`:199` は entry の節を残せばそのまま使える |
| `CODING_STANDARDS.md` | 12 | 規則の理由の pointer（`:9-16`、`:21`、`:23-24`、`:34`） | 理由が文の中に既にある行は括弧を外す。ADR がある行は ADR だけを指す。`:24`（contract の規約 5）と `:34`（テスト）は、中身を CODING_STANDARDS.md に移す |
| `CLAUDE.md:3` | 1 | 毎 session の「全文を読み」 | 条件付きの pointer 1 行にする |
| `.claude/skills/release-notifications/SKILL.md` | 6 | 通知の経路、install-app が写すもの、native host、spare、release の ID、結果の書き先 | 要る事実を skill に 1 文ずつ書くか code を指す（ID は `native_host.rs` の定数）。結果の書き先は `docs/research/` にする |
| `.claude/skills/install-app/SKILL.md:8`、`extension-dev/SKILL.md:63`、`add-job/SKILL.md:6` | 3 | release の build の説明、dev の ID、Job の規則 | `scripts/install-app.ts`、`apps/extension/vite.config.ts` を指す。add-job には移した Job の script の節を足す |
| code の comment（`packages/task/src/run-admission.ts:73`、`packages/chat/src/chat.test.ts:100`、`apps/extension/vite.config.ts:9`、`apps/desktop/src-tauri/src/native_host.rs:11`） | 4 | 順、理由、鍵の作り方、ID の在りか | pointer を外す。決める順と理由は、それを見るテストがあるか確かめる。鍵の作り方は extension-dev に移す。ID の pointer は外す（定数が正本） |
| ADR（0003、0007、0013、0016、0021、0024） | 8 | 決めた時点の文書への言及 | ADR は記録なので直さない（#274 で改名したときの扱いと同じ） |
| `docs/research/`（bun-check、macos-notification-removal、hook-payloads、agent-sdk-model-effort-web-tools） | 18 | そのうち 13 行は path、5 行は commit 固定の URL | research も記録なので直さない。URL の 5 行は commit 固定で壊れない |

参照ではないが、同期の規則を持つ所が 2 つある。`docs/packages.md:3` は文書と一緒に消える。`docs/agents/issue-tracker.md:11` の「直す docs を挙げる」は、対象を GLOSSARY・ADR・CODING_STANDARDS.md・`docs/packages.md`・skill に読み替えるよう直す。

## 9. 方法の候補

| | A. 全部消して、各置き場へ移す | B. 横断の形だけを `docs/packages.md` に残し、domain ごとの 16 本は消す | C. package ごとの README に移す |
|---|---|---|---|
| やること | 2,353 行を仕分けて移すか捨て、`docs/packages.md` も消す | A と同じ仕分けをし、`docs/packages.md` を 60〜80 行に削る | 16 本を `packages/<d>/README.md` と `apps/<a>/README.md` に `git mv` し、`docs/packages.md` を root の README にする |
| 手間 | 大きい。参照 54 行（agent が辿るもの）をすべて直す | 大きい。仕分けは A と同じ。参照は、entry の節を指す lint の 20 行を除いた 34 行を直す | 小さい。参照の path を書き換えるだけ |
| 同期の負担 | 最小。振る舞いは code と test だけが持つ。ADR は記録なので、決定を覆すときしか書かない。CODING_STANDARDS.md は規約を変えるときだけ直す | 小さい。残る文書は package か entry を足すときに直す。列挙を削れば、振る舞いを変える PR は触らない（見込み） | 変わらない。同じ量の文書を同じ頻度で直す。PR の 83% が直す形が続く |
| skill から見えるか | GLOSSARY と ADR はほぼ全 skill が読む。CODING_STANDARDS.md は code-review が必ず読む。lint は違反した時に全員に見える。entry の表は ADR-0009 にしか残らず、ADR を「触る領域のもの」として読む skill（tdd、to-spec、to-tickets）が package を足す作業で辿るかは確実でない | A と同じに加え、`docs/packages.md` を CLAUDE.md の pointer が条件付きで指す。code-review の検索も拾う | どの shipped の skill も package の README を読まない。code-review の検索が拾うことはある。in-progress の setup-ts-deep-modules は packages の root の README 1 本だけを想定する |
| 失うもの | 実装の前に、配置・entry・依存の向きを 1 か所で読む手段。HEAD の文書から消える理由（git の履歴には残る） | domain ごとの振る舞いの一覧。agent は code と test を読む。code に移さなかった理由は HEAD から消える | ほぼ無い。ただし cache と sediment の問題も残る |

## 10. 推奨

案 B にする。理由は 4 つある。

- 中身の 76% は今のコードの説明で、どの skill にも置き場が無い。writing-for-agents は、こうした文書を環境の cache として退ける（`mp:skills/productivity/writing-for-agents/SKILL.md:79`）。code と test が正本なので、消しても振る舞いは失われない。
- 横断の形（どこに何を置き、どの entry をどこから import してよいか）は、lint に当たる前に要る。docs に置いた参照文書を CLAUDE.md の pointer で指す形は、retro が書く形そのままになる（`mp:skills/engineering/retro/SKILL.md:41-43`）。
- `docs/packages.md` の path と entry の節を残すので、lint の message の 20 行がそのまま使える。apps と crates まで含む repo 全体の形なので、packages の root より docs に置くほうが中身に合う。
- 同期の負担は、残る 60〜80 行に限られる。

### 残す `docs/packages.md` の形

1. 配置。apps は組み立てるだけで apps どうしは import しない。packages は domain と ui。crates。script の列挙は書かない。
2. entry の表。entry ごとに、実行環境と import してよい側を書く。関数の名前は書かない（ADR-0009）。
3. 依存の向き。task → workbench だけで、job・note・chat・usage は他の domain を import せず、他の domain からも import されない（ADR-0005・0016）。
4. server entry の形。Ledger、`internals`、他の domain が呼ぶ書き込みは transaction を取る同期の method、fs と ptyd の副作用の送り方（ADR-0009・0015）。
5. domain の package を足すとき。package.json の exports、`.oxlintrc.json` の override（`scripts/oxlint/entry-boundaries.test.ts` が書き忘れを落とす）、migrations の置き方（table の無い package の journal を含む）、Backend の組み立て。

CLAUDE.md の「構成」は次の 1 行にする。

> package を足すとき、package の entry をまたいで import するとき、domain をまたいで書くときは `docs/packages.md` を読む。

### file ごとの移し先

| file | 移し先 |
|---|---|
| `docs/packages.md` | 残して削る（上の 5 節）。テストと contract の規約は CODING_STANDARDS.md に、守り手の一覧と domain をまたぐ規則は消す |
| `backend.md`、`desktop.md`、`notifications.md`、`tab-env-and-shim.md`、`usage.md`、`workbench-ui-state.md` | 消す。振る舞いを守る理由は、テストがあるか確かめ、無ければ足す |
| `task-ledger.md`、`note-ledger.md`、`workbench-ledger.md` | 消す。module をまたぐ不変条件は、テストがあるか確かめ、無ければ足す。合図の規則（`workbench-ledger.md:51-60`）とテストの規則（`task-ledger.md:204`、`note-ledger.md` の GFM の突き合わせ）は CODING_STANDARDS.md に移す |
| `chat.md` | 事実の 75 行を `docs/research/` に移す。options の理由は ADR-0033 にあるものを消し、無いものはテストで持たせる。残りは消す |
| `cli.md` | command の名前、stderr、exit code の約束を CODING_STANDARDS.md に移す。残りは消す |
| `dev-loop.md` | テストの exec の規則を CODING_STANDARDS.md に、変異の確かめ方を tackle に、大きさの計測を research に移す。版の理由は消す（固定した commit に残る）。残りは消す |
| `extension.md` | 鍵の作り直しと読み込み方を extension-dev と release-notifications に移す。残りは消す |
| `job-ledger.md` | Job の script の例を add-job に移す。残りは消す |
| `migration.md` | 消す（ADR-0010）。journal の 1 行は `docs/packages.md` の「package を足すとき」に移す |
| `note-ui.md` | 移植の規則は、移植が続くなら CODING_STANDARDS.md に移す。残りは消す |

lint にする候補は 3 つある。`jest.useFakeTimers` を使わない（`docs/packages.md:150`）、`process.env.TZ` に `undefined` を入れない・`delete` しない（`:155`）、`oc.$meta` と `createSchemaFactory` を `contract.ts` の外に書かない（`:167`）。retro の分け方では、機械で判定できる規則は文より check にする（`mp:skills/engineering/retro/SKILL.md:19`）。

### 進め方

PR を次の順に分けると、途中で参照が壊れない。

1. 事実を `docs/research/` に移し、docs/packages の側は research を指す。
2. 規約を CODING_STANDARDS.md に、手順を skill に、lint の候補を lint に移す。
3. 消す file ごとに「ため」の文を拾い、結論 8 の行き先に振り分ける。振る舞いを守るものは、守るテストが無ければ足す。comment には写さない。
4. `docs/packages.md` を削り、`docs/packages/` を消し、8 の表の参照を直す（ADR と research の文中は記録なので直さない）。CLAUDE.md と `docs/agents/issue-tracker.md:11` も同じ PR で直す。
5. GLOSSARY の候補の語と、葉の domain の ADR を domain-modeling で決める。

## 確かめられなかったこと

- 6 の行数は節ごとの主な種類で数えた概算で、「今のコードの説明」の節の中にある ADR の言い直しと理由の文は分けて数えていない。285 個の「ため」のうちいくつが code の comment に既にあるかは、例（`run-admission.ts:395`）を見ただけで全数は数えていない。
- 案 B で同期が減るのは見込みで、確かめていない。分割の後の `docs/packages.md` の 25 回の変更の中身は commit の題で見ただけで、diff は読んでいない。
- agent が CLAUDE.md の「全文を読み」に従ってどれだけ docs/packages を読み、それが実装と review にどれだけ効いているかは、session の log を見ていないので分からない。code-review の Standards の検索が docs/packages/*.md を拾っているかも同じ。
- upstream の issue は、少数の語（CODING_STANDARDS、docs folder など）でしか検索していない。置き場の想定を変える議論を見落としている可能性がある。
- ADR-0026 の Skill Patch で tdd や to-spec に `docs/packages.md` を読ませる形は、`skills/` がまだ無い（#239）ので試していない。
