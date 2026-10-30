---
name: translate-docs
description: ディレクトリ配下の Markdown をすべて日本語に訳し、隣に `.ja.md` として置く。1 ファイルにつき haiku の subagent を 1 つ立てる。
argument-hint: "<directory>"
disable-model-invocation: true
---

引数のディレクトリ配下の Markdown ファイルを、それぞれ日本語に訳して隣に置く: `guide/01-setup.md` → `guide/01-setup.ja.md`。元のファイルには手を付けない。

1. **元のファイルを並べる。** `find <dir> -name '*.md' ! -name '*.ja.md'`。隣にすでに `.ja.md` がある元のファイルがあれば、それを上書きしてよいかユーザーに聞いてから進む。元 → 出力の組の一覧が決まったら完了。

2. **1 ファイルにつき subagent を 1 つ立てる。** 並列に走るよう、すべて 1 つのメッセージで送る: `model: haiku`、`effort: high`、`subagent_type: general-purpose`。各 prompt は次だけにする:

   ```text
   <この skill のディレクトリ>/BRIEF.md を読んで従って。
   元ファイル: <X.md の絶対パス>
   出力: <X.ja.md の絶対パス>
   翻訳ルート: <引数のディレクトリの絶対パス>
   ```

   ルールは [`BRIEF.md`](BRIEF.md) に置き、prompt には書かない。どのファイルにも同じルールを当てるため。すべての subagent が報告を返したら完了。

3. **数を照らし、アンカーを直す。** `python3 <この skill のディレクトリ>/check.py <dir>` を走らせる。各組の行・リンク・コードフェンスの数を比べ、翻訳ルートの中の `.md` を指したままのリンクを挙げ、`#anchor` のリンクが指す訳した見出しの末尾に `<a id="<英語の slug>"></a>` を足す。訳した見出しは英語の slug を失うため。直したら走らせ直す。すべての組で `OK` が出て、残ったリンクが無くなったら完了。

   数が合わない組は、そのファイルの subagent に食い違いを伝えて差し戻す（SendMessage）。新しい agent は立てない。

4. **見本を読む。** 一番大きい `.ja.md` を 2 つ開き、[`BRIEF.md`](BRIEF.md) と照らしてざっと読む: 文体、prompt の例が訳されているか、英語で残す語が英語のままか、コード中の名前に日本語の注釈が付いているか。ところどころのずれは自分で Edit で直す。2 つとも問題なく読めたら完了。

5. **報告する。** 書いたファイル、`check.py` が直したもの、わざと英語で残したものを書く。
