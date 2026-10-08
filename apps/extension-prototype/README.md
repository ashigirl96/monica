# PROTOTYPE: side panel のチャット画面

捨てる prototype で、main には merge しない。「side panel のチャット画面を fluid-functionalism で組む」の問い（side panel で違和感が無いか、どの部品をどこまで写すか）に答えるために組んだ。agent には繋がず、回答は用意した markdown を数文字ずつ流す。

## 起こし方

```sh
bun run --cwd apps/extension-prototype dev     # dist/ に dev の拡張を書き出す（port 5198）
bun run --cwd apps/extension-prototype brave   # 捨てる profile（.brave-profile/）の Brave に dist/ を読み込ませる
```

Brave の拡張のアイコン（パズルの中にある「monica (prototype: side panel chat)」）を押すと side panel が開く。MV3 の CSP の下で見るときは、`dev` の代わりに `build` してから `brave` を起こす。

## 見るもの

- 上端の黒い bar: ←→（キーの ←→ でも）で variant を、`fluid`/`monica` で字と色を、`auto`/☀/☾ で light と dark を切り替える。「消す」で会話を消す。会話は variant をまたいで残る。
- variant
  - **A 本家そのまま**: fluid の token と Inter Variable。ChatMessage の吹き出しは幅 80%、InputMessage は queue・history・suggestions 付き、ThinkingIndicator は英語のまま。
  - **B monica の字と色**: 部品は A と同じ。apps/web の色、ヒラギノ、14px と広い行。回答は幅いっぱい。ThinkingIndicator は写して日本語にした。
  - **C 吹き出しなし**: ChatMessage を使わず、質問を引用の形、回答を `.typeset` の文書として流す。InputMessage は compact で queue なし。
- 質問に「長」を含めると長い回答（下端に張り付くスクロールと「最新へ」を見る）、「短」を含めると長い URL の混ざった短い回答が返る。それ以外は見出し・太字・箇条書き・コード・表・引用・リンク・画像の混ざった回答と短い回答が交互に返る。
- 回答の画像は読み込まず、alt と URL を文字で出す。

## 写した範囲

`src/sidepanel/fluid/` に、fluid-functionalism（`bf9ece4`、MIT、`fluid/LICENSE`）の registry から部品と lib を写し、`@/` の import を相対 path に直した。`fluid.css` は本家の `app/globals.css` の token・base・type scale・typeset・focus・scrollbar・shimmer。file-thumbnail は pdfjs-dist を読まない stub にした。Button と Tooltip は Base UI 版。
