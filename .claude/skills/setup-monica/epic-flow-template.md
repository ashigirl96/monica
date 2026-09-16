# `.monica/epic-flow.md` の雛形

Released の判定が既定と違う repo だけが repo ルートに置く。既定は「default branch への merge が Released」で、その repo にはこのファイルは要らない。`/orchestrate` と `epic-worker` は、ファイルがあればこの節に従い、無ければ既定で動く。

```markdown
## Released の判定

merge commit を含む `v*` タグ
```

パターンはその repo のリリースタグの形を正確に書く。`/orchestrate` はこれを `git tag --contains <merge commit>` の結果と照らして、merge-after-released gate の解除と post-release の Verification の期限判定に使う。

## ここに書かないもの

- **PR 本文の見出し名**: 固定の規約。`## マージ前の確認` / `## マージ後の手順` / `## リリース後の確認`。PR template に置き、`/setup-monica` が検査する。
- **検証の手段**: repo の skill と CLAUDE.md がすでに持っている。Orchestrator と Worker はそれに従う。
