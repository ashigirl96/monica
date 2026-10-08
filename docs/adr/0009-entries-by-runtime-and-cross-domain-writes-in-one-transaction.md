---
status: accepted
---

# ドメイン package は実行環境ごとの entry を持ち、domain をまたぐ書き込みは同期関数で 1 つの transaction にする

ADR-0002 で `packages/<domain>` が schema・router・CLI・skill・UI を縦に持つと決めた。しかし 1 つの entry からすべてを export すると、webview の bundle に router 経由で `bun:sqlite` と `@orpc/server` が入る（stack prototype で起きた）。そこで entry を層ではなく、import してよい実行環境で切る。`schema`（どこでも）、`contract`（どこでも）、`server`（Bun）、`ui`（browser）、`cli`（Bun）の 5 つで、root の `"."` は置かない。domain をまたぐ書き込み（task が Bench を開く、Attach、close）は、workbench の router を in-process client で呼ぶのではなく、`@monica/workbench/server` の `Workbench` が持つ同期の method で行う。method は第 1 引数に transaction を取る。drizzle の bun:sqlite の transaction は同期関数しか包めず、async 関数を渡すと throw しても rollback されない（await より前の書き込みも残る。実測）。oRPC の呼び出しは必ず async なので、procedure をつなぐ形では 2 つの domain にまたがる書き込みを原子的にできない。

## Considered Options

- **root の entry 1 つ**（stack prototype）: webview は型だけを import すれば済むが、domain の UI を package に置くと UI のコードが実行時に contract と schema を import する。その経路で server の依存が bundle に入る。
- **workbench の router を `createRouterClient` で in-process に呼ぶ**: workbench の interface が contract 1 つで済み、webview・CLI・task・テストが同じ seam を通る。ただし上の理由で transaction に入らない。
- **実行環境ごとに tsconfig を分けて型で守る**: 実際に起きた事故は bundle の解決で、`vite build` が捕まえる。UI のコードで Bun の API を呼ぶ事故は起きにくく、contract を両方の program に入れる設定の手間に見合わない。

## Consequences

- 依存の向きは task → workbench だけ。bun の isolated linker では package.json に書いていない依存を解決できないので、向きは package.json が守る。
- 書き込みは相手の domain の method を通す。読み出しは相手の table を `schema` entry で直接 SELECT してよい。Agent Session と Run の join を procedure 経由にすると N+1 になるため。
- fs への副作用は transaction に入らないので、別の async method にし、呼び手が commit の後に呼ぶ。ptyd への副作用は workbench が transaction の後に自分で送る（ADR-0015）。
- event は「変わった」の合図で、購読側は DB を読み直す。transaction は同期なので、tx の中で publish しても購読側が動くのは commit 後になる。rollback されても読み直すだけなので、commit 後に publish する仕組みは作らない。
- domain を持たない UI 部品は `packages/ui` に置く。package は apps を import できないので、apps/desktop の汎用部品を domain の UI から使えないため。
- browser 側の安全性は CI の `vite build` で確かめる。型だけの import は消えるので対象外。
- 5 つの entry とは別に、テストだけが import する `testing`（Bun）を置く。workbench はここから fake の ptyd を出し、他の package のテストは Workbench の method を spy で差し替えずに、本物の手順を fake の ptyd に通す。テストと `testing.ts` 以外からの import は lint が止める。
