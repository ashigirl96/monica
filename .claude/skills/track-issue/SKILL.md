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

対象リポジトリで issue を立てる。タイトル・本文はユーザーの依頼内容から
組み立てる。リポジトリが曖昧なときだけ確認する。親 issue の有無でコマンドが分かれる。

**通常の issue:**

```bash
gh issue create --repo <owner/repo> --title "<title>" --body "<body>"
```

**子 issue（親 issue が決まっている・親子構成が前提の場合）:**

`gh issue create` ではなく **`gh sub-issue create --parent <親番号|URL>`**
（`yahsan2/gh-sub-issue` 拡張）を使う。作成と同時に GitHub の Sub-issues
リンクが張られ、子 issue から GraphQL の `Issue.parent` で親を逆引きできる
ようになる（body に `Part of #N` と書くだけではリンクされない）。

```bash
gh sub-issue create --parent <親番号> --repo <owner/repo> --title "<title>" --body "<body>"
```

フラグの罠（`gh issue create` と完全互換ではない）:

- `--body-file <path>` → **未サポート**。長文は
  `BODY=$(cat file.md) && gh sub-issue create ... --body "$BODY"` で渡す
- `--assignee @me` → 無視される。ユーザー名直指定か、作成後に
  `gh issue edit <N> --add-assignee <user>` で補完

既存 issue の事後リンクは `gh sub-issue add <親> <子>`、一覧は
`gh sub-issue list <親>`。親子とも作る場合は親 → 子の順で作成し、
親の本文のチェックリストに子の番号を反映する。

どちらのコマンドも作成した issue の URL を標準出力に返すので、それを次の
ステップにそのまま渡す。URL を取りこぼさないよう出力を控えておく。
子 issue も 1 本ずつ通常どおり track する。

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
