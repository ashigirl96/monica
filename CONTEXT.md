# Monica

私と AI エージェントが一緒に仕事を進めるための個人用 Agent OS。GitHub issue を Task として取り込み、coding agent の Run を起動・監視し、成果物へ変換する。

## Language

### Task と Run

**Task**:
Monica が追跡する作業単位。多くは GitHub issue を track して生まれる。
_Avoid_: work item, ticket, issue（GitHub 側の実体を指すときだけ issue と呼ぶ）

**Run**:
Task に対して起動された coding agent のセッション 1 回。worktree と terminal tab を持つ。
_Avoid_: session, execution, job

**Track**:
GitHub issue を Monica の Task として取り込む操作。
_Avoid_: import, sync（sync は track 済み Task の状態更新を指す）

### Worker flow と Epic flow

**Worker**:
issue を track した Task の Run で動き、その issue を実装して PR にする agent。issue は単独のものでも Epic の sub-issue でもよい。
_Avoid_: implementer, sub-agent, coding agent（総称としてのみ使う）

**Worker flow**:
1 つの issue を Task 化し、Run を起こして Worker が PR を作り、merge して Task を閉じるまでの流れ。Monica のすべての運用の土台。
_Avoid_: 通常フロー, 通常運用, normal flow, 単発運用

**Epic**:
sub-issue を束ねる親 issue。それ自体は実装対象ではない。
_Avoid_: parent issue, umbrella issue, 親 issue

**Sub-issue**:
Epic の子 issue。Worker flow の対象であり、1 sub-issue が 1 PR に対応する。
_Avoid_: child issue, 子 issue, ticket

**Epic flow**:
Epic を sub-issue に分解し、Orchestrator が着手順と文脈の共有を駆動しながら sub-issue ごとに Worker flow を起動し、Epic を閉じるまでの流れ。
_Avoid_: Epic 運用, orchestrator flow, epic operations

**Orchestrator**:
Epic を track した Task の Run で動く agent。sub-issue の着手順を判断し、Worker を起動する。コードは書かない。
_Avoid_: coordinator, supervisor, manager agent

**Tick**:
Orchestrator の 1 回分の実行。GitHub を読み直して Frontier を計算し、次の 1 手を打ち、待たずに終わる。記憶を持たず、何度実行しても同じ判断に至る。
_Avoid_: loop, iteration, poll, run（Run は Task の Run を指す）

**Epic Brief**:
Epic issue そのものに置かれる共有ドキュメント。Discovery・Human Action・Merge Gate を保持し、Orchestrator と Worker の双方が GitHub 上で読み書きする。Monica は写しを持たない。
_Avoid_: Epic Ledger, Epic Context, epic doc, 共有ドキュメント

**Discovery**:
Epic Brief に記録される事実の 1 項目。Worker が実装中に判明させたもの、または Human Action の完了で得られたもので、他の sub-issue にも効く。例: 鍵の保管場所、外部サービスの制約。
_Avoid_: finding, note, learning, メモ

**Human Action**:
Epic Brief に記録される、人間にしかできない作業の 1 項目。どの sub-issue のどの時点までに要るかを示す Gate を持ち、完了すると多くの場合 Discovery を生む。完了の記録は人間の報告を受けた Orchestrator が行う。例: クライアントへの確認、鍵の発行。
_Avoid_: TODO, manual step, blocker, human task

**Gate**:
依存の関門。下流の sub-issue が上流のどの状態を待つかを表し、2 種類ある。**start-after-merged** は上流が merge されるまで着手しない（デフォルト）。**merge-after-released** は並行して実装してよいが上流が Released になるまで merge しない。
_Avoid_: dependency type, phase, checkpoint

**Merge Gate**:
merge-after-released の Gate を持つ依存の一覧。Epic Brief の節として「#B は #A の Released 後に merge」の形で書く。GitHub の辺は種類を持てず、張れば必ず start gate として効いてしまうので、この種類の依存は Blocked-by を張らず、この節だけで表す。
_Avoid_: Gate の例外, release gate, merge 制約

**Blocked-by**:
start-after-merged の依存の辺。GitHub ネイティブの issue 依存として張り、Monica の start gate がこれを読む。merge-after-released の依存は着手を止めてはならないので辺を張らず、Epic Brief の Merge Gate に書く。
_Avoid_: depends on, prerequisite, 前提 issue

**Fog**:
Epic Brief に置かれる、スコープ内だが今は問いを正確に述べられない作業。Discovery を受けて晴れ、sub-issue に昇格する。スコープ外とは区別する。
_Avoid_: 未確定, Unspecified, TODO, backlog, later, pending

**Frontier**:
今すぐ着手できる sub-issue の集合。open かつ blocker が解消済みかつ未 Claim のもの。
_Avoid_: ready set, ready queue, 着手可能リスト

**Claim**:
sub-issue が着手中であることの表明。Monica では Task の Run、GitHub では assignee で表し、Orchestrator が起動時に両方を立てる。
_Avoid_: lock, reservation, assign（操作を指すときだけ）

**Verification**:
sub-issue の成果を確かめる検証項目。pre-merge / post-merge / post-release の 3 区分を持ち、各項目は「いつ確認できるか」の条件を伴う。正本はその PR にあり、PR に属さない epic レベルの項目だけ Epic Brief が正本。Epic Brief は未完了項目の派生リストを持ち、そこへの記入は入力として PR に書き戻される。
_Avoid_: check, test, 動作確認（PR 本文の見出し名としてのみ使う）

**Released**:
sub-issue の変更が本番に出た状態。判定方法は repo ごとに定める。
_Avoid_: deployed, shipped, live
