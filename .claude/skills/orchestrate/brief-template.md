# Epic Brief テンプレート

epic issue 本文の形。節の順は「人が最初に知りたい順」。HTML コメントの区切りで囲まれた 2 節は Tick が毎回置き換える。

```markdown
## ゴール
<1〜2 行。この epic が終わった時に何ができるか>

<!-- orchestrate:status:begin -->
## Status
| sub-issue | 状態 | Worker | blocked by |
|---|---|---|---|
| #A <title> | Released | - | - |
| #B <title> | PR draft（merge gate 待ち） | MON-42 Running | #A |
| #C <title> | 着手可 | - | - |

最終 Tick: <YYYY-MM-DD HH:mm>
<!-- orchestrate:status:end -->

## Human Action
- [ ] <内容> — Gate: <#N 着手前 | #N merge 前> — 結果:
- [x] <内容> — Gate: <…> — 結果: <得た事実>

<!-- orchestrate:verification:begin -->
## Verification（未完了）
- [ ] [PR #N](<url>) <項目> — 条件: <いつ確認できるか>
- [ ] epic レベル: <項目> — 条件: <…>
<!-- orchestrate:verification:end -->

## Discovery
- <事実 1 行>（#N）

## Merge Gate
- #B は #A の Released 後に merge（<理由>）

## Fog
- <作業> — <何が分かれば切れるか>

## スコープ外
- <扱わないこと。別 issue があればリンク>

## 分解方針
<順序制約で切る | PoC を 1 本先に通す | 単独で検証・着地できる単位で切る>

## 経緯
<任意>
```

## 書き手

| 節 | 書き手 | 更新の仕方 |
|---|---|---|
| ゴール・スコープ外・経緯・分解方針 | 人 | GitHub UI で直接編集してよい。Orchestrator は plan モードで初期値を置くだけ |
| Discovery・Human Action・Merge Gate・Fog | Orchestrator | コメントの畳み込みと対話入力で末尾に追記。既存行は消さない |
| Status・Verification（未完了） | Tick | 区切りの内側を全て置き換える |

## Status の「状態」欄

`着手可` / `blocked` / `Human Action 待ち` / `着手中` / `PR open` / `PR draft（merge gate 待ち）` / `merged` / `Released` / `done` のいずれか 1 つ。判定順は SKILL.md 手順 7。

## Verification（未完了）の集め方

全 PR の本文から、repo の見出し 3 つ（pre-merge / post-merge / post-release）の下にある未チェックの行を集め、PR へのリンクと元の `条件:` を付けて並べる。epic レベルの項目は本文のこの節に人か Orchestrator が直接書き、PR に属さないので集め直しても消えない。

この節の箱にあなたがチェックを入れた場合、次の Tick はそれを入力として扱い、元の PR 本文の同じ項目を `[x]` にしてから節を再生成する。

## Worker の書き戻しコメント

形は書き手である [epic-worker](../epic-worker/SKILL.md) の「書き戻しコメント」が定める。Tick が読むのは、先頭行の `<!-- epic-worker: #<sub-issue> -->` と、見出し `### Discovery` / `### Human Action` / `### 依存` の 3 つ。
