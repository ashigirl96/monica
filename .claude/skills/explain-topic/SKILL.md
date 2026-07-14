---
name: explain-topic
description: "`monica explain new --mode topic` で Monica の explanation エントリを作成し、トピックの rich で interactive な HTML 解説を explanations ディレクトリに書き出す。引数があればそのトピックを調査して書き、なければ直前の会話内容を整理して書く。"
disable-model-invocation: true
---

# Explain Topic

指定されたトピックについて、rich で interactive な解説を作ってください。

## Workflow

1. **トピックを理解する** — 何を説明するかを特定し、材料を集める:
   - **引数がある場合**: そのトピックを調査する。記憶だけで書かない — 実物（コードベース・リポジトリ・公式ドキュメント・web）に必ず当たり、確認できた事実に基づいて書く。手段はトピックに応じて選ぶ。
   - **引数がない場合**: ここまでの会話で扱った内容を骨格として整理する。会話に登場しない前提知識・背景は補完調査して埋める。補完調査の結果が会話中の結論と食い違う場合は会話側を優先する。

2. **explanation エントリを作成する** — 次を実行する:

   ```bash
   "${MONICA_BIN:-monica}" explain new --mode topic --title "<title>" --summary "<summary>"
   ```

   - title と summary の両方で、shell escape が必要な文字（quote・backtick・`$`・backslash）は避ける。
   - 成功すると stdout はちょうど 1 行で、scaffold 済み `index.html` の絶対 path が出力される（例: `/Users/you/monica/explanations/expl-12/index.html`）。以降のすべての step では、この literal な path を使うこと。
   - explanation の id は `index.html` を含むディレクトリの名前 — 上の例なら `expl-12`。

3. **scaffold を読む** — 作成された `index.html` を Read し、テンプレートの構造と既存 CSS を把握する（未読のファイルへの Write は失敗する）。

4. **執筆して書き込む** — 下記の Sections・Content・Format のルールに従って解説を執筆し、完全なファイルを同じ path に Write で書き戻す。

5. **届ける** — 実行: `!open http://monica.localhost:19280/explanations/<id>`

## Sections

章立てはトピックに合わせて自由に設計する。ただし次の 3 つは必須:

- **導入章**（冒頭）: このトピックが存在する文脈を説明する。読者がどこまで知っているか分からないので、初心者向けの深い background から始める（既に詳しい読者は読み飛ばせる旨を注記してよい）。その後にトピック固有の狭い background、最後に「なぜこのトピックを知る価値があるか」を明示する。
- **本文の章**（中間）: トピックを構成要素・動作フロー・設計判断に分解した章を並べる。各章は浅い紹介で終わらせない — 動作はステップごとに分解し、「なぜそう設計されているのか」まで踏み込む。
- **Quiz**（末尾）: このトピックの理解度を試す問題を 5 問作る。難易度は中程度 — 本文を実際に理解していないと答えられないが、ひっかけ問題ではない程度。目的は、読者が本当に理解できたかを自分で確かめられるようにすること。interactive な多肢選択式で提示し、クリックすると正誤判定と feedback が表示されるようにする。

## Content

- 前提知識を省略しない。本文で使う用語・概念は、初出時に必ず導入する。
- 抽象的な説明には必ず具体例か toy データを添える。例なしの段落が続いたら書き直す。
- 図解をふんだんに使う。データフロー・状態遷移・構成要素の関係は、文章だけで済ませず diagram にする。
- 登場するツール・ライブラリ・外部システムは、本文の流れから独立した column 風の callout で「何をするものか・このトピックでなぜ登場するか」を解説する。読み飛ばせる位置づけでよいが、省略しない。

## Format

- CSS と JavaScript を含んだ、self-contained な単一の HTML ファイルを出力する。全体を、section header と番号付き table of contents 付きの 1 枚の長いページにする。top level の構造に tab を使わない。スマートフォンでも見られる程度の基本的な responsive styling があるとなお良い。
- Martin Kleppmann のような明晰さと流れを持った、classic style の engaging な文章で書く。セクション間の transition は滑らかにする。
- diagram の tips。理想的には、説明全体を通して様々なケースの説明に再利用できる、少数の diagram ファミリーを選ぶこと。有用な diagram の種類:
  - UI に関わる説明には、ユーザーが目にする UI をごく簡略化したもの。
  - コンポーネント間のデータフローや通信を示す system diagram。ここには必ず example データを含めること!
- ASCII diagram は使わない。diagram は常にシンプルな HTML デザインで作り、物の列挙には HTML の list を使う、など。
  - code block には `<pre class="code">` を使う（dark 背景、`<span class="cm|k|s">` による syntax highlight）。
    代わりに独自 style の div を使う場合は、その CSS に**必ず** `white-space: pre-wrap` を入れること。さもないと
    browser がすべての改行を 1 行に潰してしまう。ファイルを保存する前に、HTML ソース内の各 code block を確認し、
    その CSS に `white-space: pre` または `pre-wrap` が含まれることを確かめる。
- コード例は self-contained にする。例に登場する変数・引数は、それが何でどこから来たのかが例の中だけで分かるようにする（前提となるセットアップ行を含めるか、短い注記を添える）。`ws` や `mgr` のような、文脈がないと読めない略称の識別子は使わない。
- 重要な概念や定義、重要な edge case などには callout を使う。
