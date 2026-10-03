---
name: watch-ai
description: "PR の codex review を依頼し、指摘への対応と再依頼を往復で回す。PR の codex review を頼まれたとき、PR を出した後のレビュー対応まで任されたときに使う。"
---

PR の codex review を往復で回す。1 往復は「依頼 → 返却を待つ → 指摘に対応して push」で、round 1 から始めて round 3 で打ち切る。

往復の状態（PR・round・依頼時刻）は wakeup の prompt にだけ載せる。次の wakeup はその prompt から再開するので、prompt は次の形を verbatim で書く。

```
/watch-ai PR=<url> round=<N> requested_at=<依頼コメントの created_at>
```

## 1. PR を決める

引数の PR 番号か URL を使う。無ければ `gh pr view --json number,url` で現在の branch の PR を取る。どちらも無ければ、そう伝えて終える。

## 2. 依頼する

```bash
gh pr comment <PR> --body "@codex review"
```

出力される URL の `#issuecomment-` の後ろがコメントの id で、`gh api repos/<owner>/<repo>/issues/comments/<id> --jq .created_at` が requested_at になる。ScheduleWakeup(delaySeconds: 150, noop: false) で、上の形の prompt を予約する。codex の返却は早くても 2.5 分、多くは 3〜6 分かかる。

## 3. 返却を確かめる（wakeup 後）

codex の出力のうち、requested_at より新しいものを 2 箇所とも見る。author の login は `gh pr view` では `chatgpt-codex-connector`、`gh api`（REST）では `chatgpt-codex-connector[bot]` になる。`<!-- codex-pull-request-review-summary -->` で始まる issue comment は依頼の直後に作られる進み具合の表で、返却には数えない。

```bash
gh pr view <PR> --json comments,reviews          # 指摘ゼロは issue comment で返る
gh api repos/<owner>/<repo>/pulls/<PR>/comments  # 指摘は inline の review comment で返る
```

- 未返却: 同じ prompt で ScheduleWakeup(delaySeconds: 60, noop: true)。
- 指摘ゼロ（"Didn't find any major issues" など）: 手順 5 へ。
- 指摘あり: 手順 4 へ。

## 4. 指摘に対応する

1. 妥当な指摘は working tree で直し、`bun run check` が通ったら 1 コミットにまとめて push する。妥当でない指摘には、直さない理由だけを返信する。返信は `@codex` を付けずに書く。付けると Codex がフォローアップとして作業を始め、local の修正と競合する。
2. 対応した codex のコメントに 👍 を付ける。今回の指摘コメントがすべて「修正 or 返信」と 👍 を済ませたら次へ進む。

   ```bash
   gh api repos/<owner>/<repo>/pulls/comments/<id>/reactions -f content='+1'   # inline の指摘
   gh api repos/<owner>/<repo>/issues/comments/<id>/reactions -f content='+1'  # issue comment
   ```

3. push して round が 3 未満なら、round+1 で手順 2 へ戻る。push した commit が次のレビューの対象になる。round 3 のとき、または返信だけで push しなかったときは手順 5 へ。

## 5. 終える

指摘ゼロで終えたときは、その codex コメントに 👍 を付ける。ScheduleWakeup(stop: true) で往復を止め、PushNotification で 1 行知らせる。最後に、往復の数、直した内容、round 3 で残った指摘をユーザーに報告する。
