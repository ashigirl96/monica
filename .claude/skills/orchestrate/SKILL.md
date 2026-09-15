---
name: orchestrate
disable-model-invocation: true
---

# orchestrate

Epic を track した Task の Run で動き、GitHub を読んで **Frontier** を出し、次の一手を提案し、あなたの指示で実行し、Epic Brief を再生成して終わる。この 1 回分を **Tick** と呼ぶ。sub-issue の実装は Worker（`/tackle`）の仕事で、Orchestrator はコードを書かない。

sub-issue が 1 つも無い epic では Tick の代わりに **plan モード**に入り、分解して sub-issue を切る。

引数の読み方:

- **無し**: attach 済みの epic Task を対象に Tick を回し、次の一手を提案する。
- **`#N` / issue URL / `MON-n`**: その epic を対象に Tick。
- **自由文**（「田中さんから返事が来た。鍵は 1Password の X にある」）: 手順 6 の対話入力として Brief に反映してから Tick に入る。`#N` と併記できる。

## 用語

本文が使う語だけを 1 行で置く。

- **Epic Brief**: epic issue 本文。Discovery・Human Action・Merge Gate・Fog を持つ共有文書。書き手は Orchestrator のみ。
- **Discovery**: 他の sub-issue にも効く事実 1 行。
- **Human Action**: 人間にしかできない作業 1 項目。Gate（#N 着手前 / #N merge 前）を持つ。
- **Gate**: 依存の関門。`start-after-merged`（既定）と `merge-after-released`（Brief の Merge Gate 節に書かれたもの）。
- **Frontier**: 今すぐ着手できる sub-issue の集合。
- **Claim**: 着手中の表明。Monica の生きている Run で判定し、GitHub の assignee は起動時に立てる可視シグナル。
- **Fog**: スコープ内だがまだ問いを正確に述べられない作業。
- **Released**: 本番に出た状態。既定は default branch への merge。タグでリリースする repo は `.monica/epic-flow.md` に判定を宣言している。

## 手順

### 1. 対象の epic を確定する

- 引数に `#N` / issue URL / `MON-n` が含まれていればそれ。`MON-n` は `MONICA_HOME=$HOME/monica monica task status` の GH ISSUE 列で issue 番号に引く。
- 無ければ `MONICA_HOME=$HOME/monica monica task current` で、この tab に紐づく Task を引く。Run として起動した tab なら `MONICA_TASK_ID` から、`attach-task` で接続した tab なら tab ID から解決される（attach では `MONICA_TASK_ID` は設定されない）。
- どちらも無ければ、対象を尋ねる。
- 引数に自由文があれば、手順 6 で使うために控えておく。

完了条件: `owner/repo` と epic の issue 番号が確定している。

### 2. repo のルールを読む

repo ルートに `.monica/epic-flow.md` があれば、その「Released の判定」に従う。無ければ default branch への merge を Released とする。形式は [../setup-monica/epic-flow-template.md](../setup-monica/epic-flow-template.md)。

PR 本文の Verification の見出しは固定で、`## マージ前の確認` / `## マージ後の手順` / `## リリース後の確認`。Verification を実行する手段は repo の skill と CLAUDE.md に従う。

### 3. GitHub と Monica を読む

[gh-recipes.md](gh-recipes.md) の「読む」を使い、次を揃える。

- epic 本文と、minimize されていないコメント。
- 各 sub-issue の state・assignee・blockedBy・その issue を閉じる PR（state・isDraft・labels・mergeCommit）。
- 各 PR の本文。見出し 3 つの下のチェックボックス。
- merged な PR の Released 判定。
- `monica task status --project owner/repo` の各行。sub-issue ごとの Task と Run の状態、BLOCKED BY 列（Monica の start gate がまだ塞いでいる上流）。既定は active な Task しか返さないので、`--status closed` も併せて読む。済んだ sub-issue の Task は Worker flow の最後に閉じられており、片方だけでは行が消えて「Task が無い」と誤読する。

完了条件: sub-issue ごとに「issue の状態・PR の状態・Released か・Task と Run の状態・blockedBy」の 5 つが埋まった表が手元にある。1 つでも欠けた sub-issue があれば読み直す。Task の欄を「無し」と確定してよいのは、active と closed の両方に行が無いときだけ。

### 4. モードを決める

- sub-issue が 0 件 → **plan モード**（手順 P）。
- sub-issue が 1 件以上 → **Tick**（手順 5〜9）。
- 本文に `<!-- orchestrate:status:begin -->` が無く sub-issue も無い issue は、epic として扱ってよいかを尋ねてから plan モードに入る。

### 5. コメントを Brief に畳む

minimize されていないコメントのうち、先頭行が `<!-- epic-worker: #<sub-issue> -->` のものが Worker の書き戻し。コメント内の見出しごとに本文へ移す。

| コメントの見出し | 本文の節 | 書き方 |
|---|---|---|
| `### Discovery` | `## Discovery` | 1 行ずつ末尾に追記し、末尾に `（#<sub-issue>）` を付ける |
| `### Human Action` | `## Human Action` | `- [ ] <内容> — Gate: <…> — 結果:` の形で追記 |
| `### 依存` | `## Merge Gate` | `merge-after-released` の行だけ追記。blocked-by の辺は Worker が張っている前提で、無ければ `gh issue edit --add-blocked-by` で張る |

minimize はここでは行わない。本文への書き込みが成功してから（手順 8）畳む。書き込みが失敗した Tick や、途中で止まった Tick でコメントを先に畳むと、その内容は agent の手元にしか無いまま次の Tick から見えなくなり、Discovery と Human Action が消える。畳む対象のコメント node id は手順 8 まで控えておく。

先頭行に目印の無いコメント（人が書いたもの）は畳まず、手順 9 の報告で「未処理のコメント」として列挙する。

完了条件: 目印付きで未 minimize のコメント全件について、本文のどの節に何を移すかが決まっている。

### 6. 対話入力を Brief に反映する

引数の自由文、またはこの会話であなたが直前に伝えた内容に事実が含まれていれば、ここで本文に書く。前回の Tick 以降にあなたが Brief の箱に入れたチェックも、同じくあなたからの入力としてここで処理する。

- 「〜が終わった」「〜から返事が来た」→ 該当する Human Action にチェックを入れ、`結果:` に得た事実を書く。同じ事実を `## Discovery` にも 1 行追記する。
- 新しい事実 → `## Discovery` に追記。
- 新しい人間の作業 → `## Human Action` に追記。Gate はあなたに確認する。
- `## Verification（未完了）` でチェック済みの項目 → その項目の出どころの PR 本文の同じ行を `- [x]` にして書き戻す（[gh-recipes.md](gh-recipes.md) の「PR 本文のチェックボックスを入れる」）。手順 8 はこの節を PR 本文から作り直すので、先に PR を直さないとチェックが捨てられる。PR に属さない epic レベルの項目は書き戻し先が無いので、本文でチェック済みのまま残し、手順 8 の再生成でも消さない。

### 7. Frontier と提案を計算する

sub-issue ごとに状態を 1 つ決める。上から順に最初に当たったもの。

| 状態 | 条件 |
|---|---|
| done | issue closed、かつ merged PR の post-merge 項目が全てチェック済み。PR が無い、または merge されずに閉じた issue は closed だけで done |
| Released | PR merged、かつ Released の判定を満たす |
| merged | PR merged |
| PR draft（merge gate 待ち） | PR open かつ draft かつ `merge-gate` ラベル |
| PR open | PR open |
| 着手中 | Monica に生きている Run がある（STATUS 列が `setting_up` / `prepared` / `running` / `waiting_for_user`） |
| Human Action 待ち | `## Human Action` に「#N 着手前」の Gate で未チェックの項目がある |
| blocked | blockedBy の上流のうち、「closed」でも「閉じる PR が merged で `stateReason` が `REOPENED` でない」でもないものがある。Monica の start gate と同じ規則 |
| 着手可 | 上のどれにも当たらない open な sub-issue |

**Frontier** は「着手可」の集合。

提案は次の 5 種を、当てはまるものだけ列挙する。

1. **起動**: Frontier の各 sub-issue。Task が無ければ track と sync も含める。
2. **merge gate の解除**: 「PR draft（merge gate 待ち）」のうち、`## Merge Gate` に書かれた上流が全て Released で、かつ Gate が `#<sub-issue> merge 前` の Human Action が全てチェック済みのもの。gate は上流と人の作業の両方を持つので、片方だけで外さない。
3. **Verification の実行**: 全 PR の未チェック項目のうち、`条件:` が今満たされているもの。post-merge は merged で、post-release は Released で、日時指定はその時刻を過ぎていれば満たす。agent が確認できるものは実行を、人にしかできないものは Human Action への変換を提案する。
4. **追加の分解**: `## Fog` の各行について、「何が分かれば切れるか」が `## Discovery` で満たされたもの。
5. **close**: PR merged かつ post-merge 項目が全てチェック済みの sub-issue Task。全 sub-issue が done、Verification（未完了）が空、Human Action が全てチェック済み、Fog が空なら epic そのもの。

完了条件: 全 sub-issue に状態が付き、5 種の提案それぞれについて「該当あり（列挙）」か「該当なし」が言える。

### 8. Brief を再生成し、提案して止まる

[brief-template.md](brief-template.md) の区切りに従い、`## Status` と `## Verification（未完了）` を手順 7 の結果で置き換える。区切りの外は手順 5・6 で追記した分以外は触らない。本文の書き込みは、直前に本文を読み直してから行う。`## Verification（未完了）` を置き換える前に、手順 6 の PR への書き戻しが済んでいること — 済んでいれば、その項目は PR 本文でチェック済みになっているので再生成で自然に消える。

本文の書き込みが成功したら、そこで初めて手順 5 で控えたコメントを `RESOLVED` で minimize する。失敗したら畳まずに止め、何が書けなかったかを報告する（コメントは未 minimize のまま残るので、次の Tick が同じものを読み直せる）。

続けて報告を出し、あなたの指示を待つ。

```
## Tick — #<epic> <title>

Frontier: #C, #E
Worker 生存: MON-42（#B）Running

提案
1. #C に Worker を起動（MON-45）
2. PR #123 を ready にする（#A は Released 済み）
3. PR #120「翌日 14:00 の cron 結果を確認」を実行する（条件到達）
4. Fog「請求書の再送 UI」を切る（#A の Discovery で形が決まった）
5. MON-40（#A）を閉じる

人間待ち
- Human Action: 田中さんに API interface を確認（Gate: #D 着手前）

未処理のコメント: 1 件（@someone、目印なし）
```

該当が無い見出しは省く。

### 9. 指示されたものを実行し、報告して終わる

| 指示 | 実行 |
|---|---|
| 起動 | `MONICA_HOME=$HOME/monica monica task run MON-n`、続けて `gh issue edit <sub-issue> --add-assignee @me`。Task が無ければ先に `monica task track`（track が対象 Task を sync する）。`task run` は直前に sync して start gate を通すので、`is blocked by` で拒否されたら assignee は立てず「拒否された（理由）」で報告する。`--force` はあなたの明示指示があるときだけ |
| merge gate の解除 | `gh pr ready <pr>`、`gh pr edit <pr> --remove-label merge-gate` |
| Verification の実行 | `条件:` に従い、repo の skill と CLAUDE.md にある手段で確認し、PR 本文の該当チェックボックスを `[x]` にする。本番に対する読み取り以外の操作は、実行前にコマンド全文を示して許可を得る |
| 追加の分解 | 手順 P の P2〜P4 を、その項目だけに対して行う |
| close | `printf 'y\n' \| MONICA_HOME=$HOME/monica monica task close MON-n`。`task close` は stdin で `[y/N]` を聞き、非対話では `Canceled.` を出して exit 0 で終わるので、`y` を流して出力に `Closed task` があることを確認する。epic なら `gh issue close <epic>` の後に自分の Task を close |

実行で Status が変わったら、もう一度 `## Status` を再生成する。最後に、実行した内容と次に Tick を呼ぶ目安（「#A の PR が merge されたら」など）を 3 行以内で報告し、ターンを終える。待つ処理はここに含めない。

完了条件: 指示された提案が全て「実行した」か「拒否された（理由）」のどちらかで報告されている。

## 手順 P: plan モード

P1. epic 本文を読み、ゴールとスコープ外を把握する。無い節はあなたに聞いて埋める。

P2. 分解方針を 1 つ提案する。

| 方針 | 選ぶとき |
|---|---|
| 順序制約で切る | migration・破壊的変更・feature flag のように「先に本番へ出さないと次に進めない」ものがある |
| PoC を 1 本先に通す | 形が見えていない。最初の 1 本の Discovery で残りの切り方が決まる |
| 単独で検証・着地できる単位で切る | 形は見えている。書き込み集合が交わらない独立した成果物に分けられる |

P3. 今、問いを正確に述べられるものだけを sub-issue の案にする。1 案につき: タイトル、実現する振る舞い、受け入れ条件、blockedBy、Gate（既定は start-after-merged）。述べられないものは `## Fog` の案にし、「何が分かれば切れるか」を添える。案の数が 8 を超えるなら epic を分けることを提案する。

P4. 案の一覧をあなたに示し、修正を受けて確定する。確定前に issue は作らない。

P5. 確定したら [gh-recipes.md](gh-recipes.md) の「作る」で、blocker から順に `gh issue create --parent` し、2 パス目で `--add-blocked-by` を張る。辺を張り終えてから各 sub-issue を `monica task track` する（track が直後にその Task を sync し、blocked-by の上流まで写す）。

P6. [brief-template.md](brief-template.md) で本文を組み直す。既存の本文はゴール・スコープ外・経緯に振り分けて残す。分解方針・Merge Gate・Fog を書き、Status と Verification は空の区切りで置く。

P7. 作った sub-issue と Brief の URL を報告して終わる。Worker の起動は次の Tick で提案する。

完了条件: 全ての案が sub-issue か Fog のどちらかになり、Brief の全節が存在する。
