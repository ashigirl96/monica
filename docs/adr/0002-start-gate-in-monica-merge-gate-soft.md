# 着手の gate は Monica が機械的に止め、merge の gate は GitHub 上の soft な信号に留める

sub-issue 間の依存は GitHub ネイティブの blocked-by で張り、gate は start-after-merged（デフォルト）と merge-after-released（Epic Brief の Merge Gate 節に明記）の 2 種類とする。着手は `monica task run` しか通らない経路なので、上流が未 merge の Task は Monica が拒否し、明示フラグでのみ突破できる。merge は人間も通る経路で Monica は関与できないため、Worker が draft + `merge-gate` ラベルで出し、解除は Orchestrator だけが行う、という所有権のルールで守る。CI の required check による硬い merge gate は、事故が起きた時点で検討する。

## Consequences

- Monica の GitHub sync は `blockedBy` を取り込み、上流の issue を閉じる PR が merged かで start gate を判定する。
- GitHub の辺は種類を持てず、張れば必ず start gate として効く。そのため blocked-by を張るのは start-after-merged の依存だけで、merge-after-released は辺を張らず Merge Gate 節だけで表す。辺を張ってしまうと「並行して実装してよい」という Gate の定義と矛盾し、毎回 `--force` が要ることになる。
- draft と `merge-gate` ラベルは剥がせば通る。意味を持たせるのは機構ではなく「解除は Orchestrator のみ」という運用。
- チームメイトが gate を無視して merge した場合は、CI 昇格の判断材料として扱う。
