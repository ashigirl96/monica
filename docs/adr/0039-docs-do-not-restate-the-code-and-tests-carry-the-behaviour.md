---
status: accepted
---

# docs に今のコードを書き写さず、振る舞いはテストが持つ

`docs/packages.md` と `docs/packages/` は、domain ごとの contract・deps・振る舞いと、その理由を約 2,300 行で書いてきた。振る舞いを変える PR はそのたびに文書も直した（code を変えた commit の 83%）。それでも、もう無い directory の記述のような古い行が残った。文書が今のコードと合っているかを確かめる仕組みが無いため。

そこで、docs には今のコードを書き写さない。中身は次の置き場に分ける。

- 振る舞いと、振る舞いを守る理由はテストが持つ。テストの名前に規則を書き、その振る舞いを戻すと落ちるようにする。
- 戻しにくく、文脈なしでは意外な決定は ADR に書く。
- review で当てる判断の規則は `CODING_STANDARDS.md` に書く。機械で判定できる規則は lint・型・テストに置く。
- 手順は project skill に、実機で確かめた事実は `docs/research/` に置く。
- repo 全体の形（配置、entry、依存の向き、server entry の形、domain の package の足し方）だけを `docs/packages.md` に残す。lint に止められる前に、どこに何を置いてよいかを知るため。
- code の comment は最後の手段にする。上のどこにも置けず、読んだ人が「直して」しまう行にだけ 1 文で書く。

どこにも当たらない理由の文は捨てる。書いた時の文書と commit は git の履歴に残る。

## Considered Options

- **domain ごとの文書を残し、同期を続ける**: 1 か所で読めるが、振る舞いを変える PR のほとんどが直し続け、それでも漏れる。
- **package ごとの README に移す**: 置き場は code に近づくが、書く量と同期の負担は変わらない。mattpocock-skills のどの skill も package の README を読まない。
- **理由の文を code の comment に移す**: code の隣で読めるが、comment も誰も確かめないまま増え続け、docs と同じく古くなる。
- **`docs/packages.md` も消す**: 置き場は最も少ないが、実装の前に配置と entry の規則を 1 か所で読む手段が無くなる。entry の表は ADR-0009 にもあるが、ADR を読むのは触る領域のものだけなので、package を足す作業で辿られるとは限らない。

## Consequences

- agent は振る舞いを、docs ではなく code とテストから読む。テストの名前が規則を書いていなければ、その規則はどこにも書かれていない。
- bun test は DOM の環境を持たないので、DOM が要る画面の振る舞い（キーや drop の扱いなど）はテストで持たない。その理由の文は、テストのために判断を切り出さずに捨てる。
- `CODING_STANDARDS.md` は review で読む file なので、テストを書く前に要る注意（Bun や oRPC の gotcha）は、CLAUDE.md の pointer が「テストを書くときに `CODING_STANDARDS.md` の「テスト」を読む」と指す。中身は `CODING_STANDARDS.md` の 1 か所にだけ置く。
- 振る舞いを変える PR は docs を直さない。docs を直すのは、package か entry を足すとき（`docs/packages.md`）、規約を変えるとき（`CODING_STANDARDS.md`）、決定を覆すとき（ADR）だけになる。
- ADR と `docs/research/` の中にある `docs/packages/` への path は、記録なので直さない。消した文書は、消した commit より前の履歴で読む。
- 置き場の調べは `docs/research/mattpocock-docs-layout.md` にある。
