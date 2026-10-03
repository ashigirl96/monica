---
status: accepted
---

# Agent Session の状態は hook event の純関数で遷移させ、許可待ちを理由に含め、不在中に動作中だったものは未観測にする

monica は Claude Code の hook を受けるたびに TaskRun と TerminalSession の両方へ agent の状態を書き、TaskRun 側だけに 5 つの保護規則（SubagentInFlight / ToolWaitDowngrade / StoppedStaysStopped / StaleTerminalFromOtherSession / ResumeContinuation）を重ね、同じ規則を SQL の CASE 式でもう一度書いていた。PermissionRequest は「他の承認ダイアログが hook プロセスを待たされないように」matcher を ExitPlanMode に絞っていたので、default permission mode で日常的に出る Bash / Edit の許可待ちは見えず、しかも PreToolUse(ExitPlanMode) で待ちに入れた直後に自動承認で戻る往復が通知の無駄撃ちを起こしていた。tania では ADR-0005 で agent 状態の正本が `workbench` の Agent Session 1 つになったので、その遷移を「現在の行 × hook event → 次の行」の純関数 1 つに置き、Backend の oRPC procedure が payload を decode して適用し SSE で流す。状態は 動作中 / ユーザー待ち（手空き・質問・許可・エラー）/ 終了 / 未観測 の 4 つで、許可待ちを理由に含める代わりに PostToolUse と PostToolUseFailure を全 tool に張るコストを受け入れる。Backend は desktop 同寿命（ADR-0007）で不在中の hook は捨てられるが、desktop が閉じている間はユーザーが Tab に入力できないので、不在中に起きうる遷移は「動作中 → ユーザー待ち」の一方向だけであり、未観測にするのは不在直前に動作中だった Agent Session だけで足りる。

## Considered Options

- **PermissionRequest を張らない**（monica 踏襲）: hook のコストは最小だが、v1 の基準「ユーザー待ちに気づく」（#12）が default mode の許可待ちで成り立たない。許可が下りたことを知らせる hook は無く、解消は tool 完了後の PostToolUse / PostToolUseFailure でしか見えないので、全 tool に張るしかない。
- **PostToolUse を `async: true` にする**: Claude を待たせないが、遅れて届いた PostToolUse が後続の PreToolUse(AskUserQuestion) を追い越しうるので「PostToolUse は許可待ちだけを解消し、質問待ちは AskUserQuestion の PostToolUse だけが解消する」ガードが要る。実測では同期でも 1 tool あたり十数 ms しか増えない（`docs/research/hook-payloads.md`）ので、同期のまま張る。
- **プラン承認を専用の理由にする**（monica の ExitPlanMode 理由）: 自動承認が常時 on の v1 では数 ms で解消する flap になる。自動承認は hook CLI の PermissionRequest(ExitPlanMode) handler の方針として状態機械の外に置き、将来 off にしたら decision 無しで通過して普通の許可待ち（tool = ExitPlanMode）になる。
- **再起動後も最後の既知状態を信じる**: 動作中だったものが止まっていても次の hook まで動作中と出る。未観測を置けば #17 が「要確認」を出せる。
- **pid で生死を探る**: hook payload に pid は無く、hook は sh 経由で起動されるので ppid を遡る必要があり、分かるのは生死だけで動作中か手空きかは分からない。
- **transcript を読んで復元する**: 正確だが非公開フォーマットへの依存。
- **SubagentStart / SubagentStop を数える**: monica が実際に drift させて捨てた方式で、SubagentStop は prompt suggestion などの内部の agent でも来る。Stop の payload の `background_tasks`（公式の field）をその場で読み、無ければ background の仕事は無いとみなす。
- **`background_tasks` の type を問わず Stop を保留する**: `run_in_background` の Bash も載るので、dev server を起こしたまま turn を終えた agent がずっと動作中に見える。
- **SubagentStop で保留を解く**: 終わった subagent の SubagentStop の直後に Claude Code が自分で turn を起こすので、手空き → 動作中 → 手空きと揺れ、手空きの通知が 2 回出る。
- **終了を不変にして SessionStart だけで復帰させる**: dev の `bun --watch` 再起動中に SessionStart を取りこぼすと、生きている agent をずっと終了と出し続ける。生存の証拠になる event（SessionStart / UserPromptSubmit / PreToolUse(AskUserQuestion) / PermissionRequest）だけ終了から復帰させ、Stop / PostToolUse / SessionEnd の straggler は無視する。
- **Notification(idle_prompt) で手空きを見る**: 60 秒遅れで理由も無い。Stop で足りる。中断や deny の後の古い状態を直す用途にも、terminal から離れているように見える時だけ出る仕様なので当てにできない。

## Consequences

- 状態と理由は `GLOSSARY.md` の Agent Session 節。遷移表と `agent_session` table は #16 の resolution を #36 の resolution で直したもの。実機の payload は `docs/research/hook-payloads.md`。
- **張る hook**（9 本）: SessionStart、UserPromptSubmit、PreToolUse(`AskUserQuestion`)、PostToolUse（全 tool）、PostToolUseFailure（全 tool）、PermissionRequest（全 tool）、Stop、StopFailure、SessionEnd。張らない: SubagentStart、SubagentStop、Notification、PreCompact / PostCompact、AskUserQuestion 以外の PreToolUse。`timeout` はすべて 5 秒（既定は 600 秒で、Backend が固まると Claude が 10 分止まる）。
- **1 Terminal Session に live な Agent Session は 1 つ**。SessionStart が Terminal Session T に届いたとき、または SessionStart を取りこぼした Agent Session が hook で T に live として入ってきたとき、T 上の他の live な Agent Session を終了（superseded）にする。受け付けた hook が記録と違う T から届いたら、Agent Session の居場所を T に移す。resume の SessionStart を Backend の不在中に取りこぼしても、次の hook で今の Tab に結び直すため。Run は agent_session_id で繋がっているので Task との対応は動かない（ADR-0005）。
- **Stop の保留**: payload の `background_tasks` に agent の仕事（type が `subagent` / `workflow` / `teammate`）が running なら、Stop は遷移しない。動作中なら動作中のまま、subagent の許可待ちなら許可待ちのまま。agent の仕事が終わると Claude Code が UserPromptSubmit 付きの turn を自分で起こすので、保留はその turn の Stop で解ける。`shell` / `monitor` / `MCP task` / `cloud session` と未知の type は数えない（数え違えても早めの手空きで済む）。
- **質問待ちは PreToolUse(AskUserQuestion) と PermissionRequest(AskUserQuestion) のどちらでも入る**（AskUserQuestion では mode によらず両方が来る）。質問待ち中の Stop は無視し、解消は PostToolUse(AskUserQuestion) / UserPromptSubmit / SessionStart / SessionEnd / Terminal Session の終了だけ。許可待ち中に agent の仕事の無い Stop が来たら手空きにする（許可の解消を見落とした後の Stop。deny では Stop は来ない）。
- **StopFailure は理由エラー**の待ちにし、payload の `error` を `error_type` に保存する。auto-resume で再開すれば次の hook で動作中に戻る。
- **未知の session_id** の event は行を動作中で作ってから適用する。
- **Terminal Session が帳簿に無いか終わっている** event は捨てる。Agent Session は Tab の中で動く agent で、env が Tab の外へ漏れた agent（Tab で起こした tmux server、Tab から開いたエディタの端末）や、Tab より長生きした agent は観測しない。
- **許可は PermissionRequest ごとに新しい待ち**にし、前の行が許可待ちでも `state_changed_at` を更新する。許可した tool が終わるまでは許可待ちに見えたままなので、その間に subagent が次の許可を求めても `state_changed_at` が動かず、通知（ADR-0013）が出ないため。
- **Backend 起動時**: 終了でない行について、Terminal Session が死んでいれば終了（terminal_exited）、生きていて動作中なら未観測、ユーザー待ちはそのまま。
- 既知のずれ: 許可が下りてから tool が終わるまでは待ちのまま見える（長い Bash なら数分）。中断（Esc）、許可の deny、質問の Esc では hook が 1 つも来ないので、次の UserPromptSubmit まで動作中・許可待ち・質問待ちのまま見える。claude が SIGKILL などで落ちると SessionEnd が来ず、Terminal Session が生きている間は最後の状態のまま残る。生きている Tab の env が外へ漏れた agent（その Tab で起こした tmux の pane など）は、payload に pid が無いので見分けられず、その Tab の agent として観測され、SessionStart で Tab の agent を superseded にする。background の shell の終了や session の cron（`/loop` など）で起きる自動の turn は、ユーザーの入力無しに手空きから動作中に戻すので、Backend の不在中に始まった自動の turn は、戻った後もその turn の Stop まで手空きに見える。
