---
name: track-issue
description: >-
  GitHub issue を作成し、その issue を Monica に track（取り込み）する。
  `gh issue create` を自分で実行した直後・これから実行する場合も必ずこの skill で
  track まで行う。issue 作成が会話のメイン目的でなくても（調査や実装の締めくくり
  として立てる場合でも）、issue を作る以上は track をセットで行うこと。
  「issue 作って」「issue 作成して」「issue にして」「issue 立てて」「track して」
  「monica で track」など、issue 作成や track に関する表現すべてでトリガーする。
---

# track-issue

GitHub issue を作成し、その URL を Monica に track させるまでを一気通貫で行う。

## 手順

### 1. issue を作成する

対象リポジトリで `gh issue create` を使って issue を立てる。タイトル・本文は
ユーザーの依頼内容から組み立てる。リポジトリが曖昧なときだけ確認する。

```bash
gh issue create --repo <owner/repo> --title "<title>" --body "<body>"
```

`gh issue create` は作成した issue の URL を標準出力に返すので、それを次の
ステップにそのまま渡す。URL を取りこぼさないよう出力を控えておく。

### 2. Monica で track する

作成した issue の URL を `monica issue track` に渡す。`MONICA_HOME` は必ず
`$HOME/monica` を指定する（指定しないと別の data dir を見てしまう）。

```bash
MONICA_HOME=$HOME/monica /Users/1e0nhard96/.local/bin/monica issue track <issue url>
```

成功すると `Created MON-<id> from <owner/repo>#<number>` のように出力される。
その MON-ID と元の issue URL をユーザーに報告する。

### 3. track されたか確認する

正しく取り込まれたかは `monica issue status` で一覧を見て確認できる。ここでも
`MONICA_HOME=$HOME/monica` を付ける。

```bash
MONICA_HOME=$HOME/monica /Users/1e0nhard96/.local/bin/monica issue status
```

直前に作成した `MON-<id>` が一覧に出ていれば track 成功。

## 補足

- `monica issue track` は issue URL（`https://github.com/owner/repo/issues/123`）
  でも `owner/repo#123` 形式でも受け付ける。手元に URL があれば URL をそのまま渡す。
- 作成に失敗した場合は issue を track せず、エラーをそのまま報告する。
- track 後は「実装しましょうか」と誘導せず、次にどんな issue を作るかを相談する
  トーンで締める。実装は「実装して」「tackle して」と言われてから。
