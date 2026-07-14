---
name: explain-diff
description: "`monica explain new` で Monica の explanation エントリを作成し、コード変更の rich で interactive な HTML 解説を explanations ディレクトリに書き出す。"
disable-model-invocation: true
---

# Explain Diff

指定されたコード変更について、rich で interactive な解説を作ってください。

## Workflow

1. **変更を理解する** — 何を説明するか（working diff、現在の branch と default branch の差分、または特定の PR / range）を特定し、それを読み込む。周辺コードも広く探索すること。Background セクションはそれに依存する。

2. **explanation エントリを作成する** — 次を実行する:

   ```bash
   "${MONICA_BIN:-monica}" explain new --mode diff --title "<title>" --summary "<summary>"
   ```

   - title と summary の両方で、shell escape が必要な文字（quote・backtick・`$`・backslash）は避ける。
   - 成功すると stdout はちょうど 1 行で、scaffold 済み `index.html` の絶対 path が出力される（例: `/Users/you/monica/explanations/expl-12/index.html`）。以降のすべての step では、この literal な path を使うこと。
   - explanation の id は `index.html` を含むディレクトリの名前 — 上の例なら `expl-12`。

3. **scaffold を読む** — 作成された `index.html` を Read し、テンプレートの構造と既存 CSS を把握する（未読のファイルへの Write は失敗する）。

4. **執筆して書き込む** — 下記の Sections・Content・Format のルールに従って解説を執筆し、完全なファイルを同じ path に Write で書き戻す。

5. **届ける** — 実行: `!open http://monica.localhost:19280/explanations/<id>`

## Sections

以下のセクションを持つこと:

- Background: この変更に関係する既存システムを説明する。（そのために周辺コードを広く探索すること。）読者がどこまで知っているか分からないので、初心者向けの深い background を含めること（既に詳しい読者は読み飛ばせる旨を注記してよい）。その後に、変更に直接関係するより狭い background を書く。最後に、この変更の動機を明示する — 変更前は何ができなかったのか・何に困っていたのか、そしてこの変更で何ができるようになるのか。他の記述と重複しても構わない — 動機が伝わらない解説は、読者が「何が良くなったのか」を判断できない。
- Intuition: コード変更の核となる直感を説明する。ここでの焦点は本質を説明することであって、詳細を網羅することではない。toy データを使った具体例を用いる。図や diagram をふんだんに使う。
- Code: コード変更の high level な walkthrough を行う。変更を理解しやすい形でグループ化・順序付けする。
- Quiz: この PR の理解度を試す問題を 5 問作る。難易度は中程度 — PR の中身を実際に理解していないと答えられないが、ひっかけ問題ではない程度。目的は、読者が本当に理解できたかを自分で確かめられるようにすること。interactive な多肢選択式で提示し、クリックすると正誤判定と feedback が表示されるようにする。選択肢の見た目で正解が漏れないようにする — 正解だけが長く詳細になりがちなので、正解を厳密にするための限定条件や補足は選択肢に書かず、正解後の feedback に移す。全選択肢を同じ長さ・同じ粒度で書き、書き終えたら各問を見直して、最長の選択肢が正解になっていないことを確認する。

## Content

該当するものがある場合のみ適用する:

- データモデル（struct・テーブル・永続化される型）を追加・変更した場合は、既存モデルとの関係が分かる diagram を添え、初心者でも追える粒度で厚めに説明する。
- 新しく追加した library / crate は、本文の流れから独立した column 風の callout で「何をするものか・この変更でなぜ必要か」を解説する。読み飛ばせる位置づけでよいが、省略しない。

## Format

- CSS と JavaScript を含んだ、self-contained な単一の HTML ファイルを出力する。全体を、section header と table of contents 付きの 1 枚の長いページにする。top level の構造に tab を使わない。スマートフォンでも見られる程度の基本的な responsive styling があるとなお良い。
- Martin Kleppmann のような明晰さと流れを持った、classic style の engaging な文章で書く。セクション間の transition は滑らかにする。
- diagram の tips。理想的には、説明全体を通して様々なケースの説明に再利用できる、少数の diagram ファミリーを選ぶこと。有用な diagram の種類:
  - UI 変更の説明には、ユーザーがアプリで目にする UI をごく簡略化したもの。
  - コンポーネント間のデータフローや通信を示す system diagram。ここには必ず example データを含めること!
- ASCII diagram は使わない。diagram は常にシンプルな HTML デザインで作り、物の列挙には HTML の list を使う、など。
  - code block には `<pre class="code">` を使う（dark 背景、`<span class="cm|k|s">` による syntax highlight）。
    代わりに独自 style の div を使う場合は、その CSS に**必ず** `white-space: pre-wrap` を入れること。さもないと
    browser がすべての改行を 1 行に潰してしまう。ファイルを保存する前に、HTML ソース内の各 code block を確認し、
    その CSS に `white-space: pre` または `pre-wrap` が含まれることを確かめる。
- コード例は self-contained にする。例に登場する変数・引数は、それが何でどこから来たのかが例の中だけで分かるようにする（前提となるセットアップ行を含めるか、短い注記を添える）。`ws` や `mgr` のような、文脈がないと読めない略称の識別子は使わない。
- 重要な概念や定義、重要な edge case などには callout を使う。
