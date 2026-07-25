---
name: add-ambient
description: 画像を Monica web の ambient（notes 画面の背景写真）として追加する。`/add-ambient <画像パス>`、または画像を貼って「ambient に追加して」「背景に足して」のように示したときに使う。名前・blur・opacity は画像を見て自分で決める。
---

# add-ambient

画像 1 枚を `AMBIENTS`（`web/src/ambient.ts`）のエントリとして生きた状態にする。

`AMBIENTS` が single source of truth で、右下の switcher も `AMBIENT_NAMES` 経由でここから導出される。したがって触るのは **画像ファイルと `ambient.ts` の 2 つだけ** — UI 側に手を入れる必要はない。

引数は画像パス。ユーザーがチャットに画像を貼った場合は `~/.claude/image-cache/<session>/N.jpeg` の形でパスが提示されているので、それを使う。

## 手順

1. **画像を見る** — Read で実際に開く。ファイル名やユーザーの言葉から推測しない。名前も blur も opacity も、これから見るものだけを根拠に決める。あわせて `sips -g pixelWidth -g pixelHeight <path>` と `ls -lh <path>` を取る。

2. **名前を決める** — 写っているものを指す英単語 1 語（`universe` / `sakura` / `rain`）。キーは lowercase、`label` はその Capitalize。

3. **縮める** — 長辺が 2000px を超えるなら `sips -Z 2000 <in> --out <out>`。勝手に画質を落として潰さない。

   サイズは基本気にしなくていい。画像が焼き込まれるのは release ビルドの `dist-web` だけ（debug は実行時にディスクを読む）で、.app 17MB に対し 1 枚 200〜500KB。**ambient 画像の合計が 5MB を超えたときだけ**手順 9 で伝える。

4. **配置** — `web/public/ambient-<name>.jpg` へコピーして `chmod 644`。PNG なら `sips -s format jpeg <in> --out <out>` で変換してから置く。

5. **blur を決める** — 背景は**静か**でなければならない。本文の裏で形が形として読めた瞬間、それは文字と競合する。文字サイズで眺めて輪郭が判別できなくなる値を選ぶ:
   - 滑らかなグラデーション（星雲・空・霧）→ `2px`。JPEG のバンディングを均すだけで足りる
   - 中間（雨粒・玉ボケ）→ `4px`。粒が粒として残る上限
   - 高周波な輪郭（枝・建物・人・提灯）→ `8〜10px`

   迷ったら強い方を取る。静かすぎる背景は退屈なだけだが、うるさい背景の上では書けない。

6. **opacity を決める** — `{ dark, light }` の 2 値。根拠は `ambient.ts` 冒頭の doc comment にあるので、それを読んでから決める。
   - `dark`: 画像が暗くパレット（紺 hue 264 + 水色）と同系色なら `0.85` まで取れる。明るい画像や暖色が主役の画像は `0.5〜0.8`
   - `light`: `0.5〜0.6`。dark より必ず低くする

7. **登録** — `AMBIENTS` に追記する。既存エントリの形と、値を選んだ理由がコメントとして要るかの判断は、周りに揃える。

8. **通す** — `just fmt` → `bunx tsc --noEmit -p web/tsconfig.json` → `just lint`。3 つとも通ること。

9. **ユーザーに渡す** — **自分で画面を見に行かない**（agent-browser も tauri-mcp も起動しない）。決めた name / blur / opacity を、それぞれ画像の何を見てそう決めたかとセットで伝え、`just dev-web` → http://localhost:5174 の右下 switcher で light・dark 両方を確認してもらう。数値の調整は `AMBIENTS` の該当エントリ 1 箇所で効くことを添える。
