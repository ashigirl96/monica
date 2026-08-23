---
name: watch-ci
description: PR に "@codex review" コメントを投げ、返却を 5 分間隔でポーリングし、指摘対応 → 再レビュー依頼まで自動で回す（上限 3 往復）。「codex レビュー回して」「codex に見てもらって」「レビュー対応ループ」「watch-ci」、または PR 作成後にレビュー対応まで面倒を見てほしいと示されたときに使う。
---

# watch-ci

PR の codex review を**往復**で回す: 依頼 → 5 分待ち → 指摘対応 → 再依頼。往復は最大 3 回。
状態（PR・round・依頼時刻）は wakeup prompt に verbatim で載せて持ち回る — 次の wakeup はこの prompt だけを頼りに再開する。

## 1. PR を特定する

引数に PR 番号 / URL があればそれを使う。なければ `gh pr view --json number,url` で現在ブランチの PR。どちらも無ければその旨を伝えて終了。

## 2. レビューを依頼する（round N 開始）

```bash
gh pr comment <PR> --body "@codex review"
```

投稿したら ScheduleWakeup(delaySeconds: 300, noop: false) で再開を予約する。prompt:

```
/watch-ci PR=<url> round=<N> requested_at=<この依頼コメントの createdAt>
```

## 3. 結果を確認する（wakeup 後）

codex（author: `chatgpt-codex-connector`）の `requested_at` より新しい出力を両方確認する:

```bash
gh pr view <PR> --json comments,reviews          # 指摘ゼロは issue comment で返る
gh api repos/<owner>/<repo>/pulls/<PR>/comments  # 指摘は inline review comment
```

- **未返却** → noop: true で 300s 再スケジュール（prompt は同一）。
- **指摘ゼロ**（"Didn't find any major issues" 等）→ 手順 5 へ。
- **指摘あり** → 手順 4 へ。

## 4. 指摘に対応する

1. 妥当な指摘は working tree で修正し、1 コミットにまとめて push。妥当でない指摘は修正せず、理由を該当コメントへ返信する。返信に `@codex` を含めないこと — フォローアッププロンプトとして Codex が作業を開始し、local の修正と競合する。
2. 対応を終えた codex コメント全件に 👍 リアクションを付ける:
   ```bash
   gh api repos/<owner>/<repo>/pulls/comments/<id>/reactions -f content='+1'   # inline 指摘
   gh api repos/<owner>/<repo>/issues/comments/<id>/reactions -f content='+1'  # issue comment
   ```
   完了基準: 今回の指摘コメント全件が「修正 or 返信」+ 👍 済み。
3. round < 3 なら round+1 で手順 2 に戻る（push 済みの新コミットが次のレビュー対象になる）。round = 3 なら手順 5 へ。

## 5. 終了する

指摘ゼロで終わった場合はその codex コメントに 👍 を付ける。ScheduleWakeup(stop: true) でループを止め、PushNotification で一行報告した上で、結果（往復数・修正内容・round 3 で残った未解決の指摘）をユーザーに報告する。
