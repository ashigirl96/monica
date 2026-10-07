# 通知

Agent Session がユーザー待ちに入ったときに macOS の通知を出す（ADR-0013、語は `GLOSSARY.md` の通知）。判定と本文は workbench が持ち、OS に渡すのは Shell が持つ。Task の無い Tab でも出すので、観測と同じく Workbench を持ち込む骨格の実装に含める。task が足すのは `nameAgentSession` だけ（`docs/packages/task-ledger.md` の「Run」）。

## 出す遷移

`recordHook` が遷移を書いて commit した後、`notificationFor(前の行 | null, event, 次の行)` が通知の理由を返す。`transition` の隣に置く純関数。

| 次の状態 | 出す条件 |
|---|---|
| 質問・許可・エラーの待ち | 新しい待ちに入った |
| 手空き | 前の行が動作中か未観測で、event が Stop |
| それ以外 | 出さない |

- 質問とエラーは、前の行が同じ理由の待ちでないときに新しい待ちになる。PreToolUse(AskUserQuestion) と PermissionRequest(AskUserQuestion) は同じ質問なので 1 回しか出ない。
- 許可は、PermissionRequest（ExitPlanMode と AskUserQuestion を除く）が来るたびに新しい待ちになる。前の行が許可待ちでも、`transition` は `state_changed_at` を更新する。許可した tool が動いている間は許可待ちに見えたままなので、その間に background の subagent が次の許可を求めたときに取りこぼさないため。PermissionRequest に `tool_use_id` は無く、同じダイアログかどうかは見分けられない。
- `notificationFor` は `state_changed_at` を比べず、前の行の待ちの理由と event から新しい待ちかを決める。`state_changed_at` は ms 単位なので、同じ ms に続いた hook では新しい待ちに入っても前の行と同じ値になる。
- SessionStart による手空き（起動・resume の直後）と、待ちから手空きへの変化では出さない。
- agent の仕事が残っている Stop は遷移しないので出ない。agent の仕事が終わった後に Claude Code が自分で起こす turn の Stop で出る。
- 未知の session_id は動作中の行を作ってから遷移を当てる（ADR-0008）ので、最初の event が Stop なら出る。
- PermissionRequest(ExitPlanMode) は遷移しないので、プランの自動承認では出ない。
- edge 1 つに通知 1 つ。dedupe key、outbox、Backend の再起動時のまとめ出しは持たない。
- test は遷移表と同じく表駆動で書く。

## title と body

- title は呼び名。`nameAgentSession(db, agentSessionId)` が文字列を返せばそれを使う。null なら Agent Session の cwd の末尾 2 つ（monica の `shortPath`）を使う。長さは切らない（macOS が切る）。
- `nameAgentSession` は table を読むだけの関数。その Agent Session の Run の Task を引き、無ければ Tab → Runspace → Bench の Task を引いて（CLI の `current` と同じ順）、Bench のラベルと同じ `<repo>#<n> <title>` を返す。後ろの経路は、通知の判定（`recordHook` の commit 直後）が task の購読より先に走り、Bench の Tab で始まったばかりの Agent Session にまだ Run が無い場合のためにある。
- body は `<理由> · <Agent Session の title>`（`手空き · Tania通知の問題`）。理由は `手空き`、`質問`、`許可: <tool>`、`エラー: <error_type>`（error_type が無ければ `エラー`）。Agent Session の title が読めなければ理由だけにし、通知は止めない。title は Task か cwd でしか呼ばないので、同じ repo で claude の Tab を複数開くと、名前が無ければどの Tab の待ちか分からないため。名前を title でなく body に足すのは、sidebar で Runspace → Tab の順に探す並びに合わせるため。名前は切らない（macOS が切る）。
- Agent Session の title は、`transcript_path` が指す Agent Session Transcript の末尾 64 KiB を読み、その中で最後の `{"type":"ai-title","aiTitle":…}` の行の `aiTitle` を使う。Claude Code が Tab の title（OSC 0/2）に出す会話の名前と同じもので、Tab の title は Workbench Ledger に持たない（`docs/packages/workbench-ledger.md`）ので Agent Session Transcript から読む。ptyd に最後の OSC の title を覚えさせる案は、ptyd の protocol と Rust 側の変更が要るので採らない。手元の Agent Session Transcript 87 件では、最後の `ai-title` は末尾から 33 KiB 以内にあった。
- `ai-title` は Claude Code の文書化されていない形式で、短い会話には付かない。Agent Session Transcript が無い、`ai-title` の行が無い、最後の `ai-title` の行が JSON として読めないか `aiTitle` が空でない文字列でないときは、読めないとする。最後の行が読めなくても前の `ai-title` には戻らない。形が変わった後で古い title を出さないため。`ai-title` の行は `"type":"ai-title"` を含む行として探す。Claude Code は詰めた JSON を書くので、会話の本文に出た同じ文字列は escape されて当たらない。
- 音は鳴らさない。

## Backend と Shell

- apps/backend が `createWorkbenchLedger` に渡す `notify({ title, body })` は、stdout に `{"type":"notify","title","body"}` を 1 行書く。test では `notify` と `nameAgentSession` を差し替える。
- `nameAgentSession` か `notify` が throw したら、stderr に 1 行出して捨てる。`recordHook` の記録と `changes` の合図は続ける。
- Backend の stdout は Shell 宛ての JSON 行専用（ADR-0007）。Backend の log は stderr に出す。
- Shell は stdout の行を `type` で振り分ける。`endpoint` は `backend-endpoint` event に、`notify` は tauri-plugin-notification の `app.notification().builder().title(..).body(..).show()` に渡す。解釈できない行は Shell の log に流して捨てる。
- plugin の macOS 実装は NSUserNotificationCenter なので、取り下げ、クリックの受け取り、最前面でのバナーは無い。クリックすると tania が前面に出るだけ。
- dev の通知は plugin が Terminal.app の名義で出す（`tauri::is_dev()` で切り替わる）。Terminal.app に通知の許可が要る。見た目は `bun run install-app` で入れた release で確かめる。
