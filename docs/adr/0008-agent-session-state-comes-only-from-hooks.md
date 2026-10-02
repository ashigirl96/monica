---
status: accepted
---

# Agent Session の状態は hook event の純関数で遷移させ、許可待ちを理由に含め、不在中に動作中だったものは未観測にする

monica は Claude Code の hook を受けるたびに TaskRun と TerminalSession の両方へ agent の状態を書き、TaskRun 側だけに 5 つの保護規則（SubagentInFlight / ToolWaitDowngrade / StoppedStaysStopped / StaleTerminalFromOtherSession / ResumeContinuation）を重ね、同じ規則を SQL の CASE 式でもう一度書いていた。PermissionRequest は「他の承認ダイアログが hook プロセスを待たされないように」matcher を ExitPlanMode に絞っていたので、default permission mode で日常的に出る Bash / Edit の許可待ちは見えず、しかも PreToolUse(ExitPlanMode) で待ちに入れた直後に自動承認で戻る往復が通知の無駄撃ちを起こしていた。tania では ADR-0005 で agent 状態の正本が `workbench` の Agent Session 1 つになったので、その遷移を「現在の行 × hook event → 次の行」の純関数 1 つに置き、Backend の oRPC procedure が payload を decode して適用し SSE で流す。状態は 動作中 / ユーザー待ち（手空き・質問・許可・エラー）/ 終了 / 未観測 の 4 つで、許可待ちを理由に含める代わりに PostToolUse と PostToolUseFailure を全 tool に張るコストを受け入れる。Backend は desktop 同寿命（ADR-0007）で不在中の hook は捨てられるが、desktop が閉じている間はユーザーが Tab に入力できないので、不在中に起きうる遷移は「動作中 → ユーザー待ち」の一方向だけであり、未観測にするのは不在直前に動作中だった Agent Session だけで足りる。

## Considered Options

- **PermissionRequest を張らない**（monica 踏襲）: hook のコストは最小だが、v1 の基準「ユーザー待ちに気づく」（#12）が default mode の許可待ちで成り立たない。許可が下りたことを知らせる hook は無く、解消は tool 完了後の PostToolUse / PostToolUseFailure でしか見えないので、全 tool に張るしかない。
- **PostToolUse を `async: true` にする**: Claude を待たせないが、遅れて届いた PostToolUse が後続の PreToolUse(AskUserQuestion) を追い越しうるので「PostToolUse は許可待ちだけを解消し、質問待ちは AskUserQuestion の PostToolUse だけが解消する」ガードが要る。同期で始め、実測して痛ければこの形に切り替える。
- **プラン承認を専用の理由にする**（monica の ExitPlanMode 理由）: 自動承認が常時 on の v1 では数 ms で解消する flap になる。自動承認は hook CLI の PermissionRequest(ExitPlanMode) handler の方針として状態機械の外に置き、将来 off にしたら decision 無しで通過して普通の許可待ち（tool = ExitPlanMode）になる。
- **再起動後も最後の既知状態を信じる**: 動作中だったものが止まっていても次の hook まで動作中と出る。未観測を置けば #17 が「要確認」を出せる。
- **pid で生死を探る**: hook payload に pid は無く、hook は sh 経由で起動されるので ppid を遡る必要があり、分かるのは生死だけで動作中か手空きかは分からない。
- **transcript を読んで復元する**: 正確だが非公開フォーマットへの依存。
- **SubagentStart / SubagentStop を数える**: monica が実際に drift させて捨てた方式。Stop / SubagentStop の payload の `background_tasks` をその場で読む。この field は公式 docs に無いので、無ければ subagent 無しとみなして Stop をそのまま適用する。
- **終了を不変にして SessionStart だけで復帰させる**: dev の `bun --watch` 再起動中に SessionStart を取りこぼすと、生きている agent をずっと終了と出し続ける。生存の証拠になる event（SessionStart / UserPromptSubmit / PreToolUse(AskUserQuestion) / PermissionRequest）だけ終了から復帰させ、Stop / PostToolUse / SubagentStop / SessionEnd の straggler は無視する。
- **Notification(idle_prompt) で手空きを見る**: 60 秒遅れで理由も無い。Stop で足りる。

## Consequences

- 状態と理由は `GLOSSARY.md` の Agent Session 節。遷移表と `agent_session` table は #16 の resolution。
- **張る hook**: SessionStart、UserPromptSubmit、PreToolUse(`AskUserQuestion`)、PostToolUse（全 tool）、PostToolUseFailure（全 tool）、PermissionRequest（全 tool）、Stop、StopFailure、SubagentStop、SessionEnd。張らない: SubagentStart、Notification、PreCompact / PostCompact、AskUserQuestion 以外の PreToolUse。`timeout` はすべて 5 秒（既定は 600 秒で、Backend が固まると Claude が 10 分止まる）。
- **1 Terminal Session に live な Agent Session は 1 つ**。SessionStart が Terminal Session T に届いたら、T 上の他の live な Agent Session を終了（superseded）にする。resume が記録と違う T で届いたら Agent Session の居場所を T に移す。Run は agent_session_id で繋がっているので Task との対応は動かない（ADR-0005）。
- **Stop の保留**: payload の `background_tasks` に running があれば Stop を無視して動作中のまま `stop_held` を立て、SubagentStop で残りが無くなったときだけ手空きにする。保留無しの SubagentStop は遷移しない（foreground の subagent）。
- **質問待ち中の Stop は無視**し、解消は PostToolUse(AskUserQuestion) / UserPromptSubmit / SessionStart / SessionEnd / Terminal Session の終了だけ。許可待ち中の Stop は手空きにする（ダイアログは tool 呼び出しの途中なので、Stop が来たなら deny の後）。
- **StopFailure は理由エラー**の待ちにし `error_type` を保存する。auto-resume で再開すれば次の hook で動作中に戻る。
- **未知の session_id** の event は行を動作中で作ってから適用する。
- **Backend 起動時**: 終了でない行について、Terminal Session が死んでいれば終了（terminal_exited）、生きていて動作中なら未観測、ユーザー待ちはそのまま。
- 既知のずれ: 許可が下りてから tool が終わるまでは待ちのまま見える（長い Bash なら数分）。deny の解消は次の Stop / UserPromptSubmit / 別 tool の PostToolUse。質問を Esc で捨てると次の UserPromptSubmit まで質問待ちに見える。`background_tasks` の有無と質問中に Stop が本当に来るかは Run の実装 issue で実機確認する。
