---
status: accepted
---

# Backend が Workbench の帳簿と ptyd の寿命を持ち、Shell は byte の中継だけを持つ

monica では Shell（Rust）が ptyd を spawn して 1 本の接続を持ち、Terminal Session の行・id の採番・reconcile・Exit の記録・layout を Rust から SQLite に書いていた。tania では DB の書き手は Backend だけ（ADR-0003）なので、これらを `packages/workbench` に移す。ptyd は 1 つの session の Output を attach した接続にだけ送り、Exit は全接続に送る。そのため、Backend が ptyd に自分の接続を持てば、誰も attach していない session の終了も Backend が記録できる。そこで ptyd への接続を 2 本にした。Backend の接続は帳簿のため（Hello / Create / List / Terminate / Reap と Exit の受信）、Shell の接続は byte のため（attach / write / resize と Output・Exit の中継）に使う。ptyd の spawn、protocol の版の確認、版違いの入れ替えも Backend が持つ。入れ替えで消えた session を lost にするのは帳簿の仕事で、spawn と同じプロセスに置けば直後の reconcile がそのまま拾うため。

Runspace と Tab（layout）も Backend だけが書く。webview は layout 全体の snapshot ではなく、`tab.open` や `tab.move` のように 1 操作ずつ送り、`workbench.changes` を購読して読み直す。task は Bench の Runspace の作成と破棄、Attach による Tab の移動を Backend の中で書くので、webview が snapshot を書き戻すとそれを上書きしてしまうため。

## Considered Options

- **monica どおり Shell が ptyd を spawn し、Backend は接続だけ持つ**: 入れ替えを決めるプロセスと、入れ替えで消えた session を lost にするプロセスが分かれる。Shell と Backend が同時に古い daemon を見つけると、両方が入れ替えに走る。
- **Shell の 1 本の接続から Exit と List を Backend に転送する**: Shell が Backend の procedure を知ることになり、Backend の再起動中に届いた Exit は失われる。
- **byte も Backend が中継する**（webview ↔ Backend ↔ ptyd）: Shell は Backend の監督だけで済むが、打鍵が Backend を通り、`bun --watch` の再起動のたびに端末が切れる。ADR-0001 は ptyd の中継を Rust に残すと決めている。
- **layout は webview の snapshot 保存のまま、revision で楽観ロックする**: 衝突時に webview が自分の変更を捨てるかマージし直すことになり、CLI から来た Attach と画面の操作が競う。

## Consequences

- Shell の terminal command は attach / write / resize の 3 本になる（Tab を閉じても detach しない。ADR-0023）。Shell は ptyd を spawn せず（Backend が起こすまで最大 2 秒待つ）、protocol が違っても入れ替えず、Reap もしない。Backend に知らせるのは spawn 時の env `TANIA_PTYD_PATH`（ptyd の場所）だけ。Exit は pane に stream の終わりを知らせるためにだけ webview へ流し、終了の正本は Backend の行にする。
- ptyd は `setsid` と SIGHUP の無視で自分を切り離すので、Backend が spawn しても Backend の再起動や ⌘Q では死なない。ただし、自分の socket が消えるか別のファイルに替わったら終了する（bind した socket の `(dev, ino)` を 2 秒おきに確かめる）。socket を失った ptyd には誰も繋げないので、home を消した後に shell を抱えたまま残さないため。ptyd は spawn した process の env を継いで全 tab に渡すので、Backend は自分専用の env を落としてから spawn する。
- Backend は `start()` で ptyd に繋ぎ（無ければ spawn、版違いは Shutdown → pid file で kill → spawn）、List で reconcile してから endpoint を公開する（ADR-0007）。ptyd への送り方と、procedure が ptyd を待たないことは ADR-0015。接続が切れたら backoff 付きで繋ぎ直し、もう一度 reconcile する。
- reconcile の規則: live な行が ptyd に無ければ lost にする（Create をまだ送っていない行は例外。ADR-0015）。tombstone は exit code 付きで exited にしてから Reap する。終わった行と同じ id で ptyd に live な session があれば terminate する。ptyd にだけある live な session と、Tab に指されていない live な行は terminate する（ADR-0023）。ptyd にだけある tombstone は Reap する。行が終わるときは、その Terminal Session の Agent Session も終了（terminal_exited）にする。Backend の起動直後の reconcile では、生きている Terminal Session で動作中だった Agent Session を未観測にする（ADR-0008）。ptyd に繋ぎ直したときの reconcile では未観測にしない。その間も Backend は hook を受けているため。
- Exit を受けた Backend は、行を exited にして commit してから Reap する。間で Backend が死んでも tombstone が残り、次の reconcile が拾う。create は `starting` で INSERT し、`WHERE status = 'starting'` で running / failed に更新する。即死した shell の Exit が Created の応答より先に届いても、running に戻さない。Created の応答の前に接続が切れたら、ptyd が作ったかは分からないので `starting` のまま残し、繋ぎ直した後の reconcile に決めさせる。
- Tab → Terminal Session の向きだけを持ち（Tab は常に 1 つの session を指す）、Tab id は env に渡さない（ADR-0005）。
- Terminal Session の id は Backend が `ts-<uuidv7>` で採番する。DB を消して ptyd だけが生き残っても、id が再利用されない。
- webview の 3 秒の polling は `workbench.changes` の購読に置き換わる。
