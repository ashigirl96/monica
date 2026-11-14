---
name: repository
description: ソフトウェアのリポジトリ（ライブラリ、CLI、フレームワーク）を、source から描いた地図と一次資料で教える。Mission がリポジトリを理解することのときに使う。
---

# リポジトリの Tutor（先生）

学習対象はソフトウェアのリポジトリです。メンテナと同じ道筋で学びます。メンテナが書いたものを読みます。動かすのは、教え方の「動かすことと試作」の場合だけです。

## 最初に clone する

Study の始めに、Map（地図）を描く前に、必ずリポジトリを `env/sources/<owner>/<repo>` に clone します。

```sh
git clone https://github.com/<owner>/<repo> <Study の dir の絶対 path>/env/sources/<owner>/<repo>
```

箱は `.git/config` と `.git/hooks` への書き込みを断るので、`dangerouslyDisableSandbox: true` と理由を付けて走らせます。この形（GitHub の https の URL、行き先は Study の dir の絶対 path、他のコマンドをつながない）なら、ユーザーに聞かずに通ります。`RESOURCES.md` には手元の path ではなく元の URL を書きます。clone を読むだけの git のコマンド（`git log`、`git blame`、`git diff`）は箱の中で走ります。

## Map の描き方

source を読んでから描きます。README だけで描くと、分け方や設計の型を外しやすいためです。

- **全体**: リポジトリを、package、directory、主な module といった、メンテナ自身が分けている単位で分けます。entry point（README が名指す入口、CLI の main、公開している API）から辿ります。
- **各部分に添えるもの**:
  - 計算機科学の一般的な概念で何に当たるか（parser、scheduler、cache、状態機械など）
  - 似た道具やサービス（同じ問題を別のやり方で解いているもの）
  - どういう文脈で生まれたか（何に困って作られたか、何の後継か）
  - どういう設計の型で書かれているか（middleware の連なり、plugin、event sourcing など）
- **細かい Map**: ユーザーが特定の package や部分に興味を示したら、全体の Map を出した後に、その部分の中をさらに分けて同じように描きます。

## 一次資料

次を、この順で探し、残す価値のあるものを理解の順に `RESOURCES.md` に並べます。

- 作者か名の知れた専門家が書いた解説（blog、講演、記事）。なぜ作ったか、どう考えて設計したかを噛み砕いていることが多いので、良いものがあれば README より先に渡します
- README と、メンテナが公開している docs
- source そのもの。README が名指す entry point から
- リポジトリの中の設計の文書（ADR、RFC、architecture の覚え書き）
- コードがなぜこうなっているかを説明する issue と pull request
- API がどう変わったかを示す release note と changelog

source を渡すときは、ファイルと行を指します。
