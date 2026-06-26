# page frontmatter リファレンス

`guides` スキルが notebook の各ページ（`.md`）に書く frontmatter とファイル名の詳細。
ここに書く内容は Monica CLI の lint（`monica notebooks lint <slug>`）を必ず green で通すこと。

## frontmatter スキーマ

各ページの先頭に `---` で囲んだ frontmatter を置く。lint が presence を検査するのは `title` / `order` / `created` の 3 つ。
`parent` は lint 上は任意だが、階層を表すための唯一の手段なので子ページでは必ず書く。

| key       | lint 必須 | 値                                                                                     |
| --------- | --------- | -------------------------------------------------------------------------------------- |
| `title`   | ✅        | 非空。**日本語可**。値に `:` を含むなら値全体をダブルクオートで囲む。                  |
| `order`   | ✅        | 正の整数。同じ親を持つ兄弟ページの間でのみ順序比較に使われる。                         |
| `created` | ✅        | 非空。ISO-8601 UTC。`date -u +%Y-%m-%dT%H:%M:%SZ` で得られる。                         |
| `parent`  | 任意      | top-level は省略 or 空。子は `"[[<親ページのファイル名>.md]]"`（wikilink）を必ず書く。 |

- `parent` キーは欠落でも空でも lint は落ちない（どちらも root 扱い）。**ただし子ページで省略すると親子関係が消える**ので、子では必須と考えてよい。
- `kind` などその他のキーは**書かない**。lint も内部モデルも参照しない dead metadata で、
  top-level / 子の区別は `parent` の有無だけで足りる。
- **インラインコメント（`# ...`）禁止。** パーサは `key:` の後ろを丸ごと値にする。
  特に `parent: # ...` は値が `# ...` になり「must be a wikilink」で lint が落ちる。

## テンプレート

### top-level ページ（ステップ本体・`parent` は空）

```
---
title: "認証フローの概要"
order: 1
parent:
created: 2026-06-25T10:00:00Z
---

本文…
```

### 子ページ（質問への回答・`parent` に親のファイル名）

```
---
title: "トークンの有効期限は？"
order: 1
parent: "[[auth-flow-overview.md]]"
created: 2026-06-25T10:05:00Z
---

本文…
```

## ファイル名規約

- ファイル名 = タイトルから導いた**英語の内容スラッグ** + `.md`。
  kebab-case ASCII（`^[a-z0-9]+(-[a-z0-9]+)*$`）、40 文字以内、NB_DIR 内で一意（衝突したら `-2` 等で回避）。
- 位置情報（`step-1.md` / `-q1` 等）を名前に入れない。**順序は `order`、階層は `parent`** が単一の真実源として持つ。
  これにより並べ替え・間への挿入でファイルを rename しなくて済み、ネストの深さもファイル名に出さなくてよい。
- ファイル名は **ASCII に限定**する。lint の `parent` 実在チェックはファイル名（stem）のバイト完全一致で行うため、
  日本語ファイル名は macOS の Unicode 正規化（NFC / NFD）差で照合が崩れ、lint を落とすことがある。

例（日本語タイトル → 英語ファイル名）:

| タイトル             | ファイル名              |
| -------------------- | ----------------------- |
| 認証フローの概要     | `auth-flow-overview.md` |
| トークンの有効期限   | `token-expiry.md`       |
| リフレッシュトークン | `refresh-token.md`      |

## ネスト（階層）

階層は `parent` だけで決まる。子の子は、親のファイル名を `parent` に置くだけでよい。
`monica notebooks show <slug>` の outline は `parent` チェインを再帰的にたどって採番する（深さに上限はない）:

```
auth-flow-overview.md   order:1  parent:(空)                   → 1
  token-expiry.md       order:1  parent:[[auth-flow-overview.md]] → 1.1
    refresh-token.md    order:1  parent:[[token-expiry.md]]       → 1.1.1
  scope.md              order:2  parent:[[auth-flow-overview.md]] → 1.2
```

同じ親を持つ兄弟は `order` の昇順（同値ならファイル名昇順）で並ぶ。

## lint ルール

`monica notebooks lint <slug>` の判定:

- **fatal（exit ≠ 0・必ず直す）**:
  - frontmatter のパース失敗（閉じ `---` が無い 等）。
  - 必須キー（`title` / `order` / `created`）の欠落、`title` / `created` が空、`order` が正の整数でない。
  - `parent` が wikilink 形式（`[[...]]`）でない / 実在しないページを指す / 親子チェインが循環している。
    （`parent` の欠落・空それ自体は fatal ではない。）
  - 本文中の mermaid フェンスが不正な図。
- **warning（exit 0 のまま・直さなくても green）**: markdown スタイル（rumdl）。
- **無視**: 上記キー以外の frontmatter（`kind` 等）。

ページを書いたら必ず lint し、fatal が 0 になってからユーザーに提示する。
