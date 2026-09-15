# Epic flow

Epic（親 issue）を sub-issue に分解し、Worker が [Worker flow](./worker-flow.md) で PR を作り、Orchestrator がその流れを駆動するための運用規定。Monica の立ち位置は [README](./README.md) を、用語は [CONTEXT.md](../../CONTEXT.md) を、決定の背景は [docs/adr](../adr/) を参照。2026-09-15 に grill セッションで確定。

## 全体像

1. 普通の Claude セッションで問題を洗練し、Epic Brief の骨格を持つ epic issue を切る。
2. epic issue を track して Task にし、そのセッションを `attach-task` で epic Task の Run として登録する。
3. `/orchestrate` を呼ぶ。sub-issue が無ければ plan モード、あれば tick として動く。
4. Orchestrator の提案に従ってあなたが指示し、Orchestrator が `monica task run` で Worker を起動する。
5. Worker は `/tackle` → `epic-worker` で Epic Brief を読み、実装し、書き戻し、PR を作る。
6. PR の merge・Released・Verification を tick が追い、条件が揃ったら epic を閉じる。

## 正本と所在

| 情報                                                   | 正本                                                                                              | 備考                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Epic Brief（Discovery・Human Action・Merge Gate・Fog） | epic issue 本文                                                                                   | Monica は写しを持たない（ADR-0001）                                                 |
| sub-issue 間の依存                                     | start-after-merged は GitHub ネイティブの blocked-by、merge-after-released は Brief の Merge Gate | 辺は種類を持てず必ず start gate として効くので、merge-after-released に辺は張らない |
| Verification                                           | その PR の本文                                                                                    | epic レベルの項目だけ Brief が正本。Brief には派生リストを持つ                      |
| Claim                                                  | Monica の Run + GitHub の assignee                                                                | 起動時に両方を立てる                                                                |
| Released の判定                                        | 既定は default branch への merge。タグでリリースする repo だけ `.monica/epic-flow.md` に宣言する  | 宣言の形は setup-monica の雛形                                                      |
| PR 本文の Verification の見出し                        | 固定の 3 つ。`## マージ前の確認` / `## マージ後の手順` / `## リリース後の確認`                    | PR template に置く                                                                  |
| 検証の手段                                             | 各 repo の skill と CLAUDE.md                                                                     | Epic flow 用の設定は持たない                                                        |

## Gate と強制

- gate は 2 種類。**start-after-merged**（デフォルト。blocked-by の辺で表す）と **merge-after-released**（辺は張らず、Brief の Merge Gate 節だけで表す）。
- start gate は Monica が機械的に止める（ADR-0002）。sync が GitHub の blocked-by を写し、上流が「closed」か「閉じる PR が merged で、その後 reopen されていない」のどちらかなら通過、そうでなければ `monica task run`・board の Run・Prepare のいずれも `task MON-n is blocked by owner/repo#N; land them first or force the run` で拒否する。突破は `monica task run MON-n --force` だけ。CLI の `task run` は gate の直前に対象 Task を 1 回 sync するので、写しの古さで素通りしない（オフラインなら前回の写しで判定する）。`epic-worker start` と Tick の手順 7 が GitHub を直接読む判定は同じ規則で、`--force` や attach など Run を経ない着手に対する保険。
- merge gate は Worker が draft + `merge-gate` ラベルで出す。解除は Orchestrator のみ。gate が塞がる理由は 2 つあり、merge-after-released の上流が未 Released か、Gate が `#N merge 前` の Human Action が未完かのどちらか。両方が解けて初めて外す。
- CI による硬い merge gate は事故が起きてから検討する。

## Orchestrator（`/orchestrate`）

- `~/.claude/skills` に 1 つ。引数無しなら attach 済み tab の epic Task、`/orchestrate #N` で明示。
- **tick**: 記憶を持たず、毎回 GitHub を読み直して 1 手を打ち、待たずに終わる。
  1. epic 本文・未 minimize のコメント・sub-issue・blockedBy・PR・タグを読む。
  2. コメントを本文の各節へ畳み込み、畳んだコメントを Resolved で minimize する（ADR-0003）。
  3. Frontier を計算する。Human Action に阻まれた sub-issue は除く。
  4. 提案する: Worker の起動、merge gate の解除、確認条件を満たした Verification の実行、Fog からの追加分解、閉じられる Task と epic。
  5. あなたの指示で実行する。起動時は `monica task run` と assign を同時に行う。
  6. Status 節と Verification（未完了）節を再生成して終わる。
- **plan モード**: sub-issue が無いとき。分解方針（順序制約で切る / PoC を 1 本先に通す / 単独で検証・着地できる単位で切る）を選んで Brief に 1 行残し、今問いを正確に述べられるものだけ `gh issue create --parent --blocked-by` で切り、残りは Fog 節に置き、あなたのレビューで止まる。
- **対話入力**: あなたが「田中さんからこう返事が来た」と伝えたら、Human Action にチェックを入れ、得た事実を Discovery に書く。
- 自律度は「提案して止まる」。並列上限は固定せず、走っている Worker 数を報告に含める。
- tick はコメントを書かない。本文の再生成だけで済ませる。

## Worker（`/tackle` → `epic-worker`）

`epic-worker` は `~/.claude/skills` の model-invoked skill。各 repo の `/tackle` は「親 issue があれば呼ぶ」の 1 行だけ持つ。義務は 5 つ。

1. 着手時に親の Epic Brief を本文と未 minimize のコメントの両方で読む。
2. Human Action や未知の前提に当たった瞬間、epic issue にコメントする。
3. PR 作成時に Discovery と新たに判明した依存をコメントする。start-after-merged の依存だけ `gh issue edit --add-blocked-by` で辺も張る。コメントは sub-issue あたり原則 1 本、追記は自分のコメントの編集。
4. merge gate 未達なら draft + `merge-gate` ラベルで出し、自分では解除しない。
5. PR 本文に pre-merge / post-merge / post-release の見出しを書く。各項目はチェックボックスと「いつ確認できるか」の条件を持つ。

## Verification の実行主体

- pre-merge: Worker。
- post-merge（ステージング確認など）: Worker の tab が生きていればあなたがその tab で頼む。tick は生存を報告に含める。生きていなければ Orchestrator。
- post-release（本番確認、後日の cron 確認）: Orchestrator。Worker はここまで残さない。
- 記録は誰が確認しても PR 本文のチェックボックス。Brief の派生リストへの記入は入力として PR に書き戻される。

## 終わり方

- sub-issue の Task は post-merge の Verification が終わった時点で閉じてよい。
- epic は「全 sub-issue が閉じ、Verification（未完了）が空、Human Action が全チェック、Fog が空」で閉じられる。tick が判定して提案し、あなたの指示で `gh issue close` する。Fog が残る epic は閉じない。
- epic を閉じたら tick が自分の Task を `monica task close` する。

## 分解の粒度と閾値

- この運用に載せる閾値は「Worker 1 体が 1 Run で終えられない」または「順序制約がある」。
- 粒度は epic ごとに plan モードが選び、方針を Brief に残す。追加分解は同じ方針に従う。
- 複数 repo にまたがる依存はシステム側で扱わない。Worker が他 repo の PR を作り、pre-merge の Verification 項目に書く。

## Epic Brief テンプレート

```markdown
## ゴール

<1〜2 行。人間が書く>

<!-- orchestrate:status:begin -->

## Status

| sub-issue              | 状態 | Worker | blocked by |
| ---------------------- | ---- | ------ | ---------- |
| 最終 tick: <timestamp> |

<!-- orchestrate:status:end -->

## Human Action

- [ ] <内容> — Gate: <#N 着手前 / #N merge 前> — 結果: <完了時に Discovery を書く>

<!-- orchestrate:verification:begin -->

## Verification（未完了）

- [ ] [PR #N](url) <項目> — 条件: <いつ確認できるか>
- [ ] epic レベル: <項目> — 条件: <...>

<!-- orchestrate:verification:end -->

## Discovery

- <事実 1 行>（#N）

## Merge Gate

- #B は #A の Released 後に merge（<理由>）

## Fog

- <問いをまだ正確に述べられない作業。何が分かれば切れるか>

## スコープ外

- <扱わないこと。別 issue があればリンク>

## 分解方針

<順序制約で切る / PoC を 1 本先に通す / 単独で検証・着地できる単位で切る>

## 経緯

<任意>
```

書き手の分担: ゴール・スコープ外・経緯・分解方針は人間。Discovery・Human Action・Merge Gate・Fog は Orchestrator。Status・Verification は tick が区切り内だけを再生成。

## 最初に実装する範囲

今やる:

1. `/orchestrate` を `~/.claude/skills` に作る。plan モード・tick・対話入力・Brief テンプレートを含む。
2. `epic-worker` を `~/.claude/skills` に作り、各 repo の `/tackle` に呼び出しを 1 行足す。
3. 各 repo で `/setup-monica` を実行する。`merge-gate` ラベル、PR template の 3 節、`/tackle` の epic-worker 呼び出し、タグでリリースする repo の `.monica/epic-flow.md` が揃う。
4. （3 に含む）
5. Monica の GitHub sync に `blockedBy` を足し、`monica task run` に start gate の拒否と突破フラグを入れる。（2026-09-16 済。`monica task current` も同日に入り、attach した tab から `/orchestrate` を引数無しで呼べる）

後回し:

- `TaskKind::Epic` と board 表示。
- Stopped な Run を初期プロンプト付きで再開する機能。
- sync が merge や close を検知したら tick を自動起動する機能。
- CI による硬い merge gate。
- SessionStart hook での Brief 注入（skill が読むことを強制するので現時点では不要）。
