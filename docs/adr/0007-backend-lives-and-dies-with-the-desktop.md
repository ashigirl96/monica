---
status: accepted
---

# Backend は desktop と同寿命の sidecar にし、不在を正常系として扱う

ADR-0003 の反転で CLI は Backend が立っていないと動かなくなり、Backend の可用性が CLI と hook 受信の可用性そのものになった。ptyd のように app より長生きする daemon にする道もあったが、tania では Backend を Shell が起動して ⌘Q で止める desktop 同寿命の sidecar にし、desktop が閉じている間は agent を観測せず通知も出さない、を仕様とする。Backend の状態はすべて SQLite にあり、ptyd が daemon である理由（端末を app の再起動から守る）は Backend に当てはまらない。一方 daemon にすると、app を更新しても旧 Backend が走り続ける版ずれ（contract と router と migration の 3 つで食い違う）、spawn の所有者、dev と release の Backend の常時同居、ADR-0003 の「desktop 無しで CLI は動かない」の再検討を抱える。dev loop では `bun --watch` が Backend を頻繁に再起動しており、webview の再接続と CLI の毎回 probe で「Backend は居なくなるもの」として既に設計されていたので、その延長で決めた。

## Considered Options

- **app より長生きする daemon**（ptyd 方式）: desktop を閉じても hook と通知が途切れない。monica の ptyd は版ずれを protocol version の整数 1 つで判定し、不一致なら全 session を Lost にして入れ替える。Backend は router / contract / migration の 3 つで食い違うのでこれより重い仕組みが要り、誰が spawn するか（desktop か CLI か launchd か）も決めなければならない。
- **sidecar を基本に CLI からの headless 起動も許す**: CLI が立てた Backend を desktop 起動時に引き継ぐか殺すかという daemon の問題が戻ってくる。
- **CLI だけ Unix domain socket にして token を省く**: webview は TCP が要るので 2 口になり、配線と検査が増える。token は残して TCP 1 口にした。

## Consequences

- **不在は正常系**。desktop が閉じている間も Terminal Session の agent は動き続けるが、その hook は届かず捨てられ、Agent Session の状態はその間更新されない。再起動時に生きている Terminal Session の Agent Session をどう扱うか（未観測の状態を置くか）は Agent Session の状態機械で決める。hook の CLI は Backend 不在で retry せず即座に exit 0 で捨てる。通知も desktop 稼働中だけ出る。
- **探索**: Backend は `127.0.0.1` の port 0 で bind し、`$TANIA_HOME/backend.json` に `{port, token, pid, startedAt}` を 1 行で書く（mode 0600、`$TANIA_HOME` は 0700、tmp に書いて rename）。書き手は Backend だけで、Shell と CLI は消しも書きもしない。CLI は procedure を呼ぶ瞬間に毎回読み、キャッシュしない。
- **tab の env**: Workbench の tab の env に port と token は入れない（tab の env は `docs/packages.md` の「tab の env と shim」）。Backend が再起動すると port と token が変わるので、何日も生きる tab に焼くと tab 内の CLI が古い値を掴むため。
- **token**: Backend が起動ごとに `crypto.randomUUID()` で発行し、`backend.json` と stdout の endpoint 行に書く。守る相手は同一ユーザーの他プロセスではなく（file も読める）、ブラウザ経由の DNS rebinding と他ユーザー。`/health` だけ token 無しで `{name, pid, startedAt}` を返し、Shell の孤児掃除がこれで同定する。
- **stdout**: Backend の stdout は Shell 宛ての JSON 行だけを書く channel で、endpoint 行は `{"type":"endpoint","port","token"}`。通知の行（ADR-0013）も同じ channel に載る。Shell は解釈できない行を自分の log に流して捨てる。Backend の log は stderr に出す。
- **CLI の不在時**: `backend.json` が無い、または pid が死んでいるなら即 exit 2「desktop を起動してください」。file があり pid が生きていて接続拒否のときだけ（bind 前か再起動中）200ms 間隔で最大 3 秒 retry する。stale な file は CLI は消さない。
- **分離**: 1 つの `TANIA_HOME` に Backend は 1 つ。release は `~/.tania`、dev は dev script が process 内で `~/.tania-dev` を設定し、Backend → tab の env → CLI と継承される。desktop の二重起動は tauri-plugin-single-instance で 2 つ目を既存の窓に向ける。single-instance は identifier を鍵にするので、dev は identifier と vite の port を `TANIA_HOME` ごとに分ける。既定の home（`~/.tania-dev`）は `com.ashigirl96.tania.dev` と port 1420 で、release とも別 instance になる。こうして、別の home の desktop は並んで動き、1 つの home には desktop が 1 つだけになる。同じ home で desktop が 2 つ起きると、2 つ目の Shell の起動時掃除が 1 つ目の Backend を孤児として止め、DB の排他で 1 つ目は起こし直しに失敗し続ける。
- **終了**: Shell は `RunEvent::Exit` で SIGTERM を送り、2 秒待って抜けなければ SIGKILL し、`wait()` で回収する。Backend は SIGTERM で `backend.json` を unlink し、server を止め、SQLite を close して exit 0 する。通常は 50ms 以内に抜け、2 秒は固まった Backend のための上限。
- **孤児**: app が crash / SIGKILL / SIGINT で死ぬと `RunEvent::Exit` は踏まれない。残った Backend は生きた `backend.json` を持つので CLI が孤児に繋いで成功し、次に立った desktop の Backend と同じ SQLite を 2 プロセスで書く。これを 3 層で防ぐ。
  1. Backend の自殺: Shell は stdin を pipe で spawn し、write 側を握ったまま何も書かない。Backend は stdin の EOF（親死から約 2ms）で終了と同じ処理を走らせ、保険として `process.ppid` を 1 秒間隔で見て 1 になっていたら同じ処理をする。`Stdio::null()` だと起動直後に偽の EOF が来るので使わない。
  2. Shell の起動時掃除: spawn の前に `backend.json` を読み、pid が生きていて `/health` の pid が一致したら SIGTERM → 2 秒 → SIGKILL してから spawn する。同定に `ps -o comm=` を使わないのは dev では comm が `bun` だから。
  3. DB の排他: Backend は SQLite を `PRAGMA locking_mode=EXCLUSIVE` にしてから WAL にする（WAL-index が heap に載り `-shm` も要らない）。2 つ目の Backend は最初のクエリで `SQLITE_BUSY` になり exit 非 0 で落ちる。ADR-0003 の「書き手は 1 プロセス」は前提ではなく DB が守る不変条件になる。
- **respawn**: Shell は Backend の予期しない終了を検知したら、即 → 1 秒 → 2 秒 → 4 秒の間隔で再 spawn し、60 秒以内に 5 回失敗したら諦めて webview に error と再試行を出す（migrate 失敗のような決定的エラーで無限に回さないため）。自分が SIGTERM した終了では respawn しない。終了を検知したら保持している endpoint を捨て、webview は新しい endpoint が来るまで「再接続中」を出す。新しい port と token は stdout の endpoint 行 → `backend-endpoint` event → webview の再接続・再購読で伝わり、CLI は毎回 file を読むので追従する。dev の `bun --watch` の再起動（同じ pid で port だけ変わる）も同じ経路に乗る。
- Backend は起動のたびに ptyd に繋ぎ直して reconcile し、それを終えてから `backend.json` と stdout の endpoint 行を書く。webview と CLI が reconcile 前の Terminal Session を読まないため。ptyd が 3 秒で起きなければ待たずに公開する。接続形は ADR-0011。
