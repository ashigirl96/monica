---
status: accepted
---

# Chrome Extension の Chat は Agent Session にせず、Workbench・通知・未読に出さない

Chrome Extension の side panel の Chat は、Backend が Agent SDK で起こす claude に答えさせる（map #254）。この agent は Tab の外で動き、Terminal Session も hook も持たない。Agent Session は Tab の中で動く agent が名乗るセッションで、状態は hook event だけから導く（ADR-0005・0008）ので、Chat の agent を Agent Session として観測する手段が無い。そこで Chat は Agent Session にせず、Workbench・通知・未読に出さない。ADR-0005 の「agent の状態の正本は Agent Session だけ」は Tab の中の agent についての決まりで、Chat の agent が答えている最中かどうかは、Chat が生きている間だけ Chat の側が持つ。

## Considered Options

- **Chat の agent も Agent Session にする**: agent が Workbench の 1 か所に並ぶ。代わりに、Agent Session は Terminal Session に属し、1 つの Terminal Session に live な Agent Session は 1 つという Workbench Ledger の不変条件（ADR-0008）に例外ができる。状態も hook ではなく SDK の message から導く 2 本目の経路が要る。

## Consequences

- Chat は side panel を開いた window ごとに 1 つで、新しい Chat を始めるか side panel を閉じると終わり、保存しない（#255。Backend が居なくなっても終わらないことは ADR-0031）。Agent SDK の session の jsonl も残さないので、Tab の `claude --resume <id>` で Chat を開き直して Agent Session にする道も無い。
- Chat の答えが終わっても macOS の通知は出さず、Dock の数にも入らない。通知と未読は Agent Session からだけ決める（ADR-0013・0021）。
- Chat の agent を起こす数、止める時機、Backend の終了時の始末は、Workbench Ledger ではなく chat の `ChatAgent` が決める（ADR-0031）。
