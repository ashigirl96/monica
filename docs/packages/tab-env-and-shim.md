# tab の env と shim

Terminal Session を作るときに Backend が ptyd の Create に渡す env と、Backend が `start()` で書くファイル（4 枚の shim、claude wrapper、hook の settings）の仕様。どれも内容に差分があるときだけ書き直す。ここと ADR-0008 の Agent Session の観測は workbench が持つ。Task が無い Tab でも観測するため（ADR-0005）。

## env

| 名前 | 値 |
|---|---|
| `MONICA_HOME` | Backend の home |
| `MONICA_TERMINAL_SESSION_ID` | `ts-<uuidv7>` |
| `ZDOTDIR` | `$MONICA_HOME/shell/zdotdir`（shim） |
| `MONICA_USER_ZDOTDIR` | Backend の env の `ZDOTDIR`。無ければ空で、shim は `$HOME` を使う |
| `PATH` | 先頭に `$MONICA_HOME/bin`。zsh 以外の shell 向けの保険で、zsh では shim が最後に置き直す |

- Tab id、task id と ref、run id、Backend の port と token は渡さない（ADR-0005 / 0007 / 0011）。Runspace は env を持たない。`.monica/setup.sh` にも `MONICA_*` を足さない。
- ptyd を spawn するときは、Backend の env から `MONICA_*`（`MONICA_HOME` は付け直す）、`CLAUDECODE`、`CLAUDE_CODE_*` を落とす。ptyd は自分の env を全 tab に渡すので、Claude Code の中から `bun run desktop` を起こすとこれらが全 tab に漏れ、wrapper の入れ子の判定が壊れる。
- tab で動く CLI は env の `MONICA_TERMINAL_SESSION_ID` を呼び手として procedure の input に入れる（`current`、`attach`、`close`）。Backend はその Terminal Session の live な Agent Session の Run の Task を引き、無ければ Tab → Runspace → Bench の Task を引く。`current` の解決元は `run` か `bench`。Claude Code が Bash tool に渡す `CLAUDE_CODE_SESSION_ID` は非公開なので使わない。

## shim（`$MONICA_HOME/shell/zdotdir/`）

ptyd は shell を常に `--login` で起こすので、zsh は `.zshenv` → `.zprofile` → `.zshrc` → `.zlogin` の順に shim を読む。

- 4 枚とも、ZDOTDIR を一時的にユーザーの値（`MONICA_USER_ZDOTDIR`、空なら `$HOME`）にして同名のファイルを source するだけ。ユーザーの `.zshenv` が ZDOTDIR を変えたら、以降はその値から読む。
- `.zshrc` の最後で `$MONICA_HOME/bin` を PATH の先頭に置き直す。ユーザーの rc が PATH の前に何を足しても、dev の tab の `monica` と `claude` は `$MONICA_HOME/bin` のものを指す。zinit の turbo mode のように `.zshrc` の後で PATH の前に足す plugin の dir はその前に来るが、`monica` と `claude` を持たなければ害は無い。
- `.zlogin` の最後で ZDOTDIR をユーザーの値に戻して export する（元が未設定なら unset）。tab から起こした子（dev の desktop、tmux、Claude Code の Bash tool）は shim を通らない。
- `claude` の shell 関数は定義しない。Claude Code の Bash tool は shell 関数を snapshot に取り込むので、関数にすると agent の中から起こした `claude` にも効いてしまう。

## claude wrapper（`$MONICA_HOME/bin/claude`）

- PATH から自分と同じファイルでない `claude` を探して exec する。無ければ stderr に 1 行出して exit 127 で終わる。
- PATH に別の wrapper（他の home の monica、旧 Monica）があると、どちらも PATH の先頭の `claude` へ戻すので exec が巡回する。wrapper は exec した `claude` を env の `MONICA_CLAUDE_TRAIL`（pid と path の列）に残し、同じ pid で戻ってきたら、それを飛ばして次を探し、`--settings` も足し直さない。exec は pid を変えないので、claude の子に漏れた値とは見分けられる。
- `MONICA_TERMINAL_SESSION_ID` があり、`CLAUDECODE` が無いときだけ `--settings $MONICA_HOME/shell/claude/settings.json` を足す。`CLAUDECODE` があるのは agent の Bash tool から起こした入れ子の claude で、hook を付けると同じ Terminal Session の SessionStart が親の Agent Session を superseded にする（ADR-0008）。
- `--settings` を足すときは `--permission-mode=bypassPermissions` も足し、Tab の claude を許可の確認なしで動かす。足さない条件は `--settings` と同じ。
- 最初の引数が claude の subcommand（`mcp`、`doctor`、`update` など。claude 2.1.288 の `--help` の Commands）なら `--settings` を足さない。claude は `--settings` の後ろの subcommand を prompt として読み、後ろに置くと `unknown option` で落ちる。最初の引数が prompt（`claude "fix the bug"`）なら足す。
- `--session-id` は足さない。Run は Bench の Tab に居る Agent Session から生まれる（ADR-0005）。
- `claude` を絶対パスで呼ぶと wrapper を通らず、その Agent Session は観測されない。

## hook の settings（`$MONICA_HOME/shell/claude/settings.json`）

- 張る hook は 9 本（ADR-0008）で、timeout はすべて 5 秒（既定の 600 秒を必ず上書きする）。SessionStart、UserPromptSubmit、PreToolUse（matcher `AskUserQuestion`）、PostToolUse、PostToolUseFailure、PermissionRequest、Stop、StopFailure、SessionEnd。
- command は `'<home>/bin/monica' workbench hook claude`（絶対パス。agent が PATH を変えても届く）。
- wrapper は file の path を渡すので、Backend が書き直せば既存の tab でも次の `claude` から効く。

## hook CLI（`monica workbench hook claude`）

- `MONICA_TERMINAL_SESSION_ID` が無ければ即 exit 0。
- PermissionRequest で `tool_name == "ExitPlanMode"` なら、Backend に送らずに stdout へ allow を書いて終わる（`updatedInput` に `tool_input` を返し、`updatedPermissions` に `setMode: auto` を付ける。#16）。
- stdin の payload と env の Terminal Session id を `agentSession.recordHook` に渡す。呼び出しは 2 秒で打ち切り、不在・失敗・timeout のどれでも exit 0。retry しない（ADR-0007）。

## payload と decoder

実機の payload は `docs/research/hook-payloads/` にあり、decoder の test の fixture にする。field と、場面ごとにどの hook がどの順で届くかは `docs/research/hook-payloads.md`。遷移表は #36 の resolution。

- Stop は、`background_tasks` に type が `subagent` / `workflow` / `teammate` で status が `running` のものがあるかだけを読む。field が無ければ無いとみなす。
- PreToolUse(AskUserQuestion) と PermissionRequest(AskUserQuestion) は、同じ質問の event にする。
- StopFailure のエラーの種類は `error` から読む（`error_type` ではない）。
- `permission_mode` は SessionStart / SessionEnd / StopFailure に無い。PermissionRequest に `tool_use_id` は無い。
