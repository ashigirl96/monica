# ドメインドキュメント

エンジニアリング系スキルがコードベースを探索するとき、このリポジトリのドメインドキュメントをどう読むかの規則。

## 探索の前に読むもの

- リポジトリ直下の **`GLOSSARY.md`**。または
- リポジトリ直下に **`GLOSSARY-MAP.md`** があればそれ。context ごとの `GLOSSARY.md` を指しているので、トピックに関係するものをすべて読む。
- **`docs/adr/`**: これから触る領域に関わる ADR を読む。multi-context のリポジトリでは `src/<context>/docs/adr/` にある context 固有の決定も確認する。

これらのファイルが無ければ **黙って進む**。無いことを指摘せず、先に作ることも提案しない。`/domain-modeling` スキル（`/grill-with-docs` と `/improve-codebase-architecture` から呼ばれる）が、用語や決定が実際に固まった時点で遅延的に作る。

## ファイル構成

single-context のリポジトリ（ほとんどのリポジトリ）:

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

multi-context のリポジトリ（直下に `GLOSSARY-MAP.md` がある）:

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← システム全体の決定
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context 固有の決定
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## 用語集の語彙を使う

出力にドメイン概念が出てくるとき（issue タイトル、リファクタ提案、仮説、テスト名）は、`GLOSSARY.md` で定義された用語を使う。用語集が明示的に避けている同義語に流れない。

必要な概念がまだ用語集に無いなら、それはシグナルである。プロジェクトが使っていない言葉を発明しているか（考え直す）、本当に穴があるか（`/domain-modeling` 向けにメモする）のどちらかだ。

## ADR との矛盾を表に出す

出力が既存の ADR と矛盾するなら、黙って上書きせず明示的に表に出す。

> _ADR-0007（event-sourced orders）と矛盾するが、再検討の価値があるのは…_
