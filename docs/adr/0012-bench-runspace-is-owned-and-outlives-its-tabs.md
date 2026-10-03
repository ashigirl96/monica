---
status: accepted
---

# Bench の Runspace は所有された Runspace にし、Tab が無くても Task の close まで残す

Workbench は最後の Tab を閉じたときや外へ移したときに Runspace ごと消す。monica では、それで Bench の runspace が layout から消えても `_TaskToRunspace` の行が残り、次に開くときに同じ id で作り直していた。tania の `bench.runspace_id` は workbench の `runspace` への NOT NULL の FK で（#15）、Runspace と Tab を書くのは Backend だけ（ADR-0011）。Workbench の操作で Bench の Runspace が消えると、FK 違反で操作が落ちるか、cascade なら Bench が黙って消えて worktree が孤児になる。そこで workbench に所有された Runspace を足す。他の domain が `createRunspace(tx, …)` で作った Runspace は、Tab が 0 でも残り、Workbench の操作（GUI の remove、最後の Tab の close や drag）では消えず、作った側の `removeRunspace` でだけ消える。workbench は誰が所有しているかを知らない（ADR-0005）。Work Board の無い v1 では、sidebar に並ぶ Bench が「いま開いている Task の一覧」を兼ねるので、close まで消えない方がよい。

## Considered Options

- **Runspace は消えてよく、Bench の行だけを残す**（monica 流。`bench.runspace_id` を nullable にして ON DELETE SET NULL、次の run か attach で作り直す）: Bench が「見えていない間もある作業場所」になり、Run の生まれ方（Bench の Tab）や Attach の行き先が Runspace の有無で場合分けになる。開いている Task が sidebar から消える。
- **Runspace は一律に Tab 0 でも残す**: 所有の概念は要らないが、Task と関係の無い Runspace まで手で消すことになる。
- **cascade で Bench も消す**: worktree と branch `issue-<n>` が孤児になり、reopen の `git worktree add -b issue-<n>` が branch の衝突で落ちる。

## Consequences

- `runspace` に所有の印を持たせ、`layout.get` に載せる。webview の `runspace.create` が作るのは普通の Runspace で、`createRunspace(tx, { cwd })` は常に所有された Runspace を作る。所有された Runspace には remove のメニューを出さず、procedure も `CONFLICT` で断る。空になっても sidebar に残り、新しい Tab を開ける。
- 消し方は `removeRunspace(tx, id, { spare? }) → terminalSessionId[]` の 1 つだけ。`spare` の Terminal Session の Tab が中にあれば、Runspace を消さずに所有を解いてその Tab だけを残し、ほかの Tab の session id を返す。所有を解く専用の method は作らない。
- Task の close は呼び手の Terminal Session を `spare` に渡す。close を頼んだ agent 自身に SIGHUP を送らないため。monica の close hold（table に書き、agent か shell が終わるまで呼び手の Tab を残す）は持たない。呼び手の Tab は所有を解かれた普通の Runspace に残り、最後の Tab を閉じれば普通に消える。ActiveRun guard は呼び手自身の Run を除く。
- close の順序は guard → worktree と branch の削除 → transaction（Task を closed、Bench の行を削除、`removeRunspace`）→ commit → 返った session の terminate。git が失敗したら何も変えずに止まる。
- close の後に残った Runspace の cwd は消えた worktree を指すことがある。`tab.open` は cwd が無ければ `$HOME` で開く。
