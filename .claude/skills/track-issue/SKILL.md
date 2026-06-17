---
name: track-issue
description: >-
  GitHub issue を作成し、その issue を Monica に track（取り込み）する。
  「issue 作って」「○○リポジトリに issue 立てて」のように issue を新規作成する
  ときは、作成に続けて Monica への track まで行う。track-issue を明示しない依頼でも、
  会話の中で GitHub issue を作ったら作りっぱなしにせず必ずこの skill で track する。
  「track して」「monica で track」のように track の語が出たときも使う。
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
その MON-ID と元の issue URL をユーザーに報告して完了。

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
