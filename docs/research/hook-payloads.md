# Claude Code の hook を実機で張った結果

「hook の実機確認と payload の採取」（#36）で確かめた事実。結論は ADR-0008 と #36 の resolution。Claude Code 2.1.286（最初の session）と 2.1.288（途中で自動更新された後の session）、macOS 26、model は haiku 4.5 と sonnet 5.5 で確かめた。採った payload は `hook-payloads/` にあり、decoder の fixture にする（path は `/Users/me/src/hooklab` に置き換えた）。

## やり方

- tmux（専用 socket）の中で `env -i` の bash を起こし、`CLAUDECODE` や monica の変数が無い状態で `claude --settings <file>` を動かした。ユーザー設定（plugin と `defaultMode: auto`）は読んだまま、`--permission-mode` で mode を選んだ。
- settings は `docs/packages.md` の「hook の settings」の 10 本（timeout 5 秒）。command は stdin を `<時刻>-<event>.json` に書くだけの zsh script。

```sh
#!/bin/zsh -f
zmodload zsh/datetime
t0=$EPOCHREALTIME
cat > "$HOOKLAB_OUT/${t0}-$1.json"
print -r -- "$t0 $1" >> "$HOOKLAB_OUT/timeline.log"
```

- StopFailure は `ANTHROPIC_BASE_URL` を 127.0.0.1 の fake server に向け、`ANTHROPIC_AUTH_TOKEN=dummy`、`CLAUDE_CODE_MAX_RETRIES=0` で、server が返す status を変えて起こした。

## 確かめること 5 つ

1. **Stop と SubagentStop の payload に `background_tasks` はある**。`session_crons` もある。両方とも 2.1.28x の公式 docs に載った（https://code.claude.com/docs/en/hooks.md の Stop input）。中身は running の task だけで、終わった task は消える。
   - `type` は `shell`（`run_in_background` の Bash）、`subagent`、`monitor`、`workflow`、`teammate`、`cloud session`、`MCP task`（docs）。実機で見たのは `shell` と `subagent`。
   - `shell` は `command`、`subagent` は `agent_type` を持つ。`status` は `"running"`。
   - 終わった subagent 自身の SubagentStop では、その subagent がまだ `running` として載っている。
2. **質問待ちの間に Stop は来ない**。AskUserQuestion のダイアログを 30 秒置いても何も届かず、回答すると PostToolUse(AskUserQuestion) → Stop の順で来た。
3. **PostToolUse は同期で待たれ、hook CLI の代役で 1 tool あたり約 16ms 増えた**。下の「遅延」の節。
4. **StopFailure の field は `error`**（`error_type` ではない）。`error_details` は来ず、`last_assistant_message` に画面のエラー文が入る。`permission_mode` も無い。
   - 400 `invalid_request_error` → `unknown`
   - 401 → `authentication_failed`
   - 429 → `rate_limit`
   - 500 → `server_error`
   - 529 `overloaded_error` → `server_error`（docs の `overloaded` にならなかった。gateway 経由のためかもしれない）
5. **SIGKILL では何も届かない**。SIGHUP と SIGTERM では SessionEnd(`reason: "other"`) が届いて claude は終わる。Tab を閉じたときは、SessionEnd(other) と Terminal Session の Exit のどちらが先に届いても終了になる。

## ほかに分かったこと

- **AskUserQuestion では PermissionRequest(`AskUserQuestion`) も来る**。PreToolUse の約 20ms 後で、default mode でも auto mode でも来た。docs の「PermissionRequest は auto mode では発火しない」は AskUserQuestion には当てはまらない。
- **中断・deny・質問の Esc では hook が 1 つも来ない**。
  - 動作中の Esc（tool の実行中も含む）: Stop も PostToolUseFailure も来ない。docs も「Stop は user interrupt では走らない」「running の tool の取り消しでは PostToolUseFailure は来ない」と書いている。
  - 許可ダイアログの No: 画面は「Interrupted · What should Claude do instead?」になり、turn はそこで止まる。Stop は来ない。
  - 質問の Esc: 「User declined to answer questions」で turn が終わるが、Stop も PostToolUse も来ない。
  - ExitPlanMode のダイアログの Esc: 何も来ない。
- **background の仕事が終わると、Claude Code が自分で turn を起こす**。その turn にも UserPromptSubmit が来て、`prompt` は `<task-notification>…<status>completed</status>…</task-notification>`。最後の Stop の `background_tasks` は `[]`。background の shell でも subagent でも同じだった。subagent のときは、その SubagentStop の約 46ms 後に UserPromptSubmit が来る。
- **foreground を頼んでも、許可待ちに入った subagent は background に回された**（2.1.288、画面は「Backgrounded agent」）。そのため「subagent の PermissionRequest → main の Stop（`background_tasks` に subagent が running）→ 許可すると subagent の PostToolUse」の順で届く。
- **subagent の tool の event には `agent_id` と `agent_type` が付く**（PermissionRequest、PostToolUse）。main の tool の event には付かない。
- **SubagentStop は内部の agent でも来る**。turn の後の prompt_suggestion（次の prompt の候補）と `/compact` の要約で、`agent_type` は `""`。docs にも書かれている。
- **単独の `sleep N` は Bash tool が実行前に弾く**。このように実行前の検証で失敗した tool には、PostToolUse も PostToolUseFailure も来ない。
- **`/clear`** は旧 id に SessionEnd(`clear`)、24ms 後に新 id に SessionStart(`clear`)。**`--resume`** は同じ id で SessionStart(`resume`)。**`/compact`** は内部 agent の SubagentStop の直後に SessionStart(`compact`) が来て、UserPromptSubmit も Stop も来ない。**`/exit`** は SessionEnd(`prompt_input_exit`)。
- plan mode の PermissionRequest(ExitPlanMode) の `tool_input` は `plan` と `planFilePath`。

## payload の field

共通の `session_id`、`transcript_path`、`cwd`、`hook_event_name` はどの event にもある。`scratchpad_dir` は StopFailure 以外にある。`prompt_id` は turn の中の event にあり、SessionStart / SessionEnd には場面によって付く。そのほかの field は次のとおり。

| event | `permission_mode` | その他 |
|---|---|---|
| SessionStart | 無い | `source`、`model`（startup と compact）。resume には `context_tokens`、`seconds_since_last_response`、`prompt_cache_likely_expired`、`estimated_cache_write_usd` |
| UserPromptSubmit | ある | `prompt` |
| PreToolUse | ある | `tool_name`、`tool_input`、`tool_use_id` |
| PermissionRequest | ある | `tool_name`、`tool_input`、`permission_suggestions`（ある時だけ）、subagent なら `agent_id` / `agent_type`。**`tool_use_id` は無い**（docs も「without `tool_use_id`」） |
| PostToolUse | ある | `tool_name`、`tool_input`、`tool_response`、`tool_use_id`、`duration_ms`、subagent なら `agent_id` / `agent_type` |
| PostToolUseFailure | ある | `tool_name`、`tool_input`、`tool_use_id`、`error`（1 行目が `Exit code N`）、`is_interrupt`、`duration_ms` |
| Stop | ある | `stop_hook_active`、`last_assistant_message`、`background_tasks`、`session_crons` |
| SubagentStop | ある | Stop と同じものに加えて `agent_id`、`agent_type`、`agent_transcript_path` |
| StopFailure | 無い | `error`、`last_assistant_message` |
| SessionEnd | 無い | `reason` |

auto mode の event には `effort`（`{ "level": … }`）も付く。

## 遅延

1 turn に `echo` の Bash を 8 回順に呼ばせ、transcript の tool_use から tool_result までの時刻差を比べた（haiku、各 8 回）。

| PostToolUse / PostToolUseFailure の hook | 中央値 | 範囲 |
|---|---|---|
| 無し | 27ms | 20〜75ms |
| `sleep 0.5` | 552ms | 544〜589ms |
| hook CLI の代役 | 43ms | 37〜79ms |

- `sleep 0.5` の分がほぼそのまま増えるので、tool_result は PostToolUse の hook が終わってから書かれる。つまり Claude は同期で待っている。
- 代役は `bun build --compile --minify-whitespace --minify-syntax --bytecode --format=esm` した binary。stdin を読み、127.0.0.1 の Bun server（SQLite の in-memory に 1 行 insert）に `fetch` で POST する。打ち切りは 2 秒。単体で測ると中央値 9.2ms、p90 11ms。比較として `sh -c true` は 3.6ms だった。
- 本物の `tania workbench hook claude` は compiled で dispatch に約 18ms かかる（`docs/packages.md`）ので、1 tool あたり 25〜30ms 程度と見込む。

## fixture

`hook-payloads/` のファイル名は `<event>-<場面>.json`。

- SessionStart: `startup`、`resume`、`clear`、`compact`
- UserPromptSubmit: 通常の prompt と、background の shell / subagent が終わった後の `task-notification`
- PreToolUse: `ask-user-question`
- PermissionRequest: `ask-user-question`（default と auto mode）、`bash`、`bash-from-subagent`、`exit-plan-mode`
- PostToolUse: `ask-user-question`、`bash`、`bash-background`、`agent-background`、`bash-from-subagent`
- PostToolUseFailure: `bash`
- Stop: 通常、`background-shell`、`background-subagent`、`background-subagent-awaiting-permission`
- StopFailure: HTTP status ごとに 5 本（fake server で起こしたもの）
- SessionEnd: `prompt-input-exit`、`clear`、`other-sighup`

SubagentStop は hook から外したので fixture に含めない。
