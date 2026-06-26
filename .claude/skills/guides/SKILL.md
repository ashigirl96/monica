---
name: guides
description: >-
  step by step（OK で次に進む）で何かを解説するときのスキル。repo・PDF・トピックを
  1 ステップ = 1 枚の Markdown に分けて $MONICA_HOME/notebooks/<slug>/ に書き出し、
  ユーザーの「OK」で 1 ステップずつ前進する逐次解説ループ。解説の途中で出た質問は
  子ページとしてその場に足す。発火語:「step by step で解説して」「ステップごとに説明して」
  「順を追って解説して」「OK で進める形で解説して」「rendered markdown で解説して」
  「この repo / PDF を段階的に解説して」「walk me through」「explain step by step」、
  および解説の途中で挟まれる「〇〇はどういうもの？」。
  Step-by-step explainer: break a repo / PDF / topic into one-Markdown-per-step pages
  under $MONICA_HOME/notebooks/<slug>/, advancing one step per user "OK", adding
  follow-up questions as child pages. Triggers on "explain step by step", "walk me
  through", "step by step で解説して", "ステップごとに説明して", "順を追って解説して".
---

# guides — step-by-step 解説ループ

何かを「順を追って」解説するためのスキル。解説を一気に全部チャットへ流す代わりに、
**1 ステップ = 1 枚の Markdown** を Monica の notebook に書き出し、ユーザーの「OK」で 1 枚ずつ進める。
書いたページは Monica の Library（Ctrl+Q の notebooks mode）で rendered markdown として読み返せる。

狙いは **厳密逐次の開示**: 次のステップは前のステップに OK が出てから初めて作る。先回りして全部並べない。

## CLI 呼び出し規約

notebook の操作は Monica CLI 経由。**常に**次の形で呼ぶ:

```bash
MONICA_HOME=$HOME/monica /Users/1e0nhard96/.local/bin/monica notebooks <subcommand> ...
```

- `MONICA_HOME=$HOME/monica` を省略すると dev のデータを見てしまう。必ず付ける。
- サブコマンド名は複数形 `notebooks`（`notebook` ではない）。
- 使うのは `new <slug>` / `lint <slug>` / `show <slug>` / `list`。

## ループ

### 1. Startup

1. 解説対象（repo / PDF / トピック）を確定する。曖昧なら 1 つだけ確認する。
2. notebook 全体の **slug** を kebab-case で導出する（`^[a-z0-9]+(-[a-z0-9]+)*$`、40 文字以内）。
3. notebook ディレクトリを作る。stdout に出るパスを `NB_DIR` として控える:

   ```bash
   MONICA_HOME=$HOME/monica /Users/1e0nhard96/.local/bin/monica notebooks new <slug>
   ```

4. **全体構成（何ステップに分けるか）は内部で先に設計する。** ただしユーザーには 1 ステップずつしか見せない。

### 2. Step を 1 枚書く

1. 次の top-level ページを `NB_DIR/<内容slug>.md` に直接書く。
   - frontmatter は `title`（日本語可）/ `order`（ステップ通番 1, 2, 3…）/ `parent:`（空）/ `created`（ISO-8601 UTC）。
   - ファイル名はタイトルから導いた**英語の内容スラッグ**（ASCII kebab-case）。位置ベース名（`step-1.md` 等）にしない。
   - frontmatter とテンプレートの詳細は `references/page-frontmatter.md` に従う。
2. lint する。fatal が出たら直して green になるまで再 lint:

   ```bash
   MONICA_HOME=$HOME/monica /Users/1e0nhard96/.local/bin/monica notebooks lint <slug>
   ```

3. 本文をチャットにも提示する（その場で読めるように）。本文に code fence を含むなら、
   **外側のフェンスは 4 連バッククォート**にする。
4. **停止して「OK」を待つ。** ここで次のステップを作らない。

### 3. 質問が来たら（Follow-up）

OK ではなく質問（「〇〇はどういうもの？」等）が来たら、現在のステップに**留まったまま**子ページを足す:

1. 子ページを `NB_DIR/<内容slug>.md` に書く。
   - `parent: "[[<質問対象ページのslug>.md]]"`、`order` はその親の子の中での順番（1, 2, 3…）。
   - 質問への質問は、さらにその子ページを `parent` にすればよい（`show` の outline が `1.1.1` のように深さ無制限で再帰採番する）。
2. lint して green を確認。
3. 答えをチャットに提示し、また OK を待つ。**ステップ通番は進めない。**

### 4. OK で前進

OK が出たら次の top-level ページ（`order` を +1）を書く。2 に戻る。

### 5. 完了

ユーザーが「done」「終わり」等と言ったら:

1. 最終 lint を green で確認する。
2. 何を何ステップで解説したかのサマリと、`$MONICA_HOME/notebooks/<slug>/` のパスを報告する。
   Library（Ctrl+Q の notebooks mode）で rendered markdown として読み返せる旨も添える。

## Gotchas

- コマンドは `monica notebooks`（複数形）。`monica notebook` ではない。
- 呼び出しは常に `MONICA_HOME=$HOME/monica`。省略で dev データを見る。
- バイナリは `/Users/1e0nhard96/.local/bin/monica`。
- 書き込みは `NB_DIR` 配下のみ。**書いたら必ず lint。** lint が通らないものを Library に出さない。
- **frontmatter にインラインコメント（`# ...`）を書かない。** 最小パーサは `key:` の後ろを丸ごと値として読むので、
  例えば `parent: # 子のみ` は値が `# 子のみ` になり「must be a wikilink」で lint が落ちる。
- 本文の code fence は外側 4 連バッククォート（CLAUDE.md 準拠）。mermaid 図も書ける。
- notebook ディレクトリ slug は slugify されない。`new` には `^[a-z0-9]+(-[a-z0-9]+)*$` の slug を直接渡す。
- ページのファイル名は**英語の内容スラッグ**（ASCII kebab-case）。タイトルは日本語でよいがファイル名は ASCII のみ
  （非 ASCII だと `parent` の照合が macOS の Unicode 正規化差でズレ、lint が落ちることがある）。

frontmatter スキーマ・テンプレート・ファイル名規約・ネスト・lint ルールの詳細は
[`references/page-frontmatter.md`](references/page-frontmatter.md) を参照。
