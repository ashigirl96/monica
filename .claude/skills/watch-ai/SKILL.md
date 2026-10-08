---
name: watch-ai
description: "PR の codex review を依頼し、指摘への対応と再依頼を往復で回す。PR の codex review を頼まれたとき、PR を出した後のレビュー対応まで任されたときに使う。"
---

PR の codex review を往復で回す。1 往復は「依頼 → 返却を待つ → 指摘に対応して push」で、round 1 から始めて round 3 で打ち切る。round 3 を越えても、直前の返却に P1 があれば続ける。

## 1. PR を決める

引数の PR 番号か URL を使う。無ければ `gh pr view --json number,url` で現在の branch の PR を取る。どちらも無ければ、そう伝えて終える。

## 2. 依頼する

```bash
gh pr comment <PR> --body "@codex review"
```

出力される URL の `#issuecomment-` の後ろがコメントの id で、`gh api repos/<owner>/<repo>/issues/comments/<id> --jq .created_at` が requested_at になる。

## 3. 返却を待つ

返却は skill の base directory にある `codex-return.sh` で見る。`wait` を background の subagent（`model: "haiku"`）に走らせて turn を終え、subagent の返りを待つ。monica は background の subagent を待つ間を動作中に数えるが、`run_in_background` の Bash と Monitor の間は手空きにして通知を出すため。subagent への prompt は次の形にする。

```
次のコマンドを Bash の timeout 600000 で 1 回だけ実行し、出力の最後の行だけをそのまま返す。
bash <base directory>/codex-return.sh wait <owner>/<repo> <PR> <requested_at>
```

- `returned`: `bash <base directory>/codex-return.sh show <owner>/<repo> <PR> <requested_at>` で返却を読む。指摘ゼロ（"Didn't find any major issues" など）は `issue` に、指摘は `inline` に返る。指摘ゼロなら手順 5、指摘ありなら手順 4 へ。
- `pending`（9 分返らなかった）: 同じ prompt でもう 1 度待つ。codex は長くても 8 分で返すので、2 度続いたら手順 5 へ。
- `error: …`: 手順 5 へ。

## 4. 指摘に対応する

1. 妥当な指摘は working tree で直し、検査が通ったら 1 コミットにまとめて push する。検査は、PR の diff に Rust の file（`.github/workflows/ci.yml` の `changes` job の filter が見る path）があれば `bun run check:brief`、無ければ `bun run check:brief check:ts`。CI も Rust の file の無い PR では Rust の job を飛ばす。妥当でない指摘には、直さない理由だけを返信する。返信は `@codex` を付けずに書く。付けると Codex がフォローアップとして作業を始め、local の修正と競合する。
2. 対応した codex のコメントに 👍 を付ける。今回の指摘コメントがすべて「修正 or 返信」と 👍 を済ませたら次へ進む。

   ```bash
   gh api repos/<owner>/<repo>/pulls/comments/<id>/reactions -f content='+1'   # inline の指摘
   gh api repos/<owner>/<repo>/issues/comments/<id>/reactions -f content='+1'  # issue comment
   ```

3. push して、round が 3 未満か、今回の指摘に P1 があったなら、round+1 で手順 2 へ戻る。push した commit が次のレビューの対象になる。それ以外のとき、または返信だけで push しなかったときは手順 5 へ。

## 5. 終える

指摘ゼロで終えたときは、その codex コメントに 👍 を付ける。PushNotification で 1 行知らせる。最後に、往復の数、直した内容、打ち切ったときに残った指摘、待ちで終えたときの返り（`pending` か `error: …`）と、codex を通っていない最後の commit をユーザーに報告する。
