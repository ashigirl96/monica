# Worker flow

1 つの GitHub issue を 1 つの Task として取り込み、Run を起こして Worker に PR を作らせ、merge して閉じるまでの流れ。Monica のすべての運用の土台で、[Epic flow](./epic-flow.md) では Orchestrator が sub-issue ごとにこの流れを起動する。用語は [CONTEXT.md](../../CONTEXT.md) に従う。

## 流れ

```
issue ─track→ Task(Ready) ─run→ Run(SettingUp→Running) ─/tackle→ PR ─merge→ issue closed ─close→ Task(Closed)
```

1. **issue がある。** 自分で書くか、agent との会話の締めに `track-issue` skill で立てる。skill は `gh issue create` と track をまとめて行い、track が直後の sync まで伴う。
2. **track する。** `monica task track owner/repo#N` で Task が生まれ、`MON-n` の ID と Ready の状態を持つ。track は直後に対象 Task を 1 回 sync し、issue の state・PR・親子・blocked-by の上流を写す（GitHub 未認証やオフラインなら黙って飛ばし、次の sync まで待つ）。
3. **Run を起こす。** board の Run か `monica task run MON-n`。issue に blocked-by の上流があり、それが closed でも「閉じる PR が merged（reopen されていない）」でもなければ、Monica は worktree を作らずに拒否する（start gate。`--force` で突破。CLI は直前に対象 Task を sync してから判定する）。通れば Monica は worktree を切り、repo の `.monica/setup.sh` を走らせ、terminal tab を開き、`.monica/prompt.md` の内容を初期プロンプトにして agent を起動する。hook はこの時点で注入される。
4. **agent が働く。** 初期プロンプトは通常 `/tackle` で、issue を読み、計画を立てて承認を求め、実装し、テストとレビューを通し、検証し、`/create-pr` で PR を作り、`/watch-ci` で CI とレビューの往復を回す。手順の中身は各 repo の `/tackle` が規定する。
5. **あなたが応える。** agent が質問したり計画の承認を求めたりすると、カードが WaitingForUser になる。tab を開いて答える。
6. **PR を merge する。** PR 本文の `close #N` で issue が閉じる。Monica は branch と「issue を閉じる PR」の両方から PR を見つけ、状態をカードに映す。
7. **Task を閉じる。** issue が閉じても Task は自動では閉じない。board か `monica task close MON-n` で閉じると、worktree と branch が削除される。閉じるまでは Run を再開できる。

## Monica が各段階でしていること

| 段階  | Monica の仕事                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| track | issue の title と state を写し、project（`owner/repo`）に紐づける。sub-issue なら親 Task も記録し、blocked-by の上流とその状態も写す。                                                                    |
| run   | start gate を通す（未完の上流があれば拒否）。worktree と branch を作る。`setup.sh` を実行し、失敗ならログの場所を返す。tab を開き、`MONICA_TASK_ID` などの環境変数と hook 設定を載せた agent を起動する。 |
| 観測  | hook から session id、イベント名、待ち理由を受け取り、Run の状態を更新する。質問待ちになれば通知を出す。                                                                                                  |
| PR    | sync のたびに PR の Draft / Open / Closed / Merged を写す。                                                                                                                                               |
| close | worktree と branch を消し、この Task を親としていた sub-issue Task の親リンクを外す。                                                                                                                     |

## board のカードが示す状態

| 状態           | 意味                                             | あなたがすること           |
| -------------- | ------------------------------------------------ | -------------------------- |
| Ready          | track されたが Run が無い                        | Run を押す                 |
| SettingUp      | worktree と setup.sh の実行中                    | 待つ。長引けばログを見る   |
| Prepared       | 起動待ち。desktop が tab を開くと Running になる | 待つ                       |
| Running        | agent が動いている                               | 放置してよい               |
| WaitingForUser | 質問、計画承認、権限確認、または入力待ち         | tab を開いて答える         |
| Stopped        | agent のセッションが終わった。再開できる         | 続きがあれば Run で再開    |
| Failed         | setup.sh などの失敗                              | ログを見て直し、Run し直す |
| Closed         | Task を閉じた                                    | なし                       |

## 途中から乗る、あとから戻る

- **attach**: 普通に開いていた tab の会話を、既存の Task の Run として登録したいとき。`attach-task` skill が `monica task attach MON-n` を打つ。issue を先に調べていて、そのまま実装に入りたい場合に使う。
- **resume**: Stopped の Run に `monica task run` すると、前回のセッションを `--resume` で再開する。初期プロンプトは渡らないので、続きの指示は自分で打つ。
- **1 Task 1 Run**: Task に生きている Run があるうちは、新しい `monica task run` は拒否される。attach は拒否されず、attach した tab の Run が Main Run になり、元の Run は Main から外れる（元の Run が SettingUp / Prepared のときだけ Main が据え置かれる）。

## あなたの接点

Worker flow であなたが手を動かすのは 5 箇所だけである。issue を書く、Run を押す、WaitingForUser に答える、PR をレビューして merge する、Task を閉じる。それ以外は agent と Monica が進める。

## 検証の置き場所

- PR を作る前の検証は `/tackle` の手順に含まれ、agent が行う。
- merge 後にやることは PR 本文に書く。見出し名は repo の PR template に従う。
- 複数の issue にまたがって検証の順序や文脈を管理したくなったら、それは Worker flow の外で、[Epic flow](./epic-flow.md) の領分である。

## 今は無いもの

- issue が閉じたときに Task を自動で閉じる仕組み。閉じるのは常に明示的な操作。
- Task ごとに初期プロンプトを変える口。`.monica/prompt.md` は repo に 1 つ。
- Run を再開するときに指示を渡す口。
