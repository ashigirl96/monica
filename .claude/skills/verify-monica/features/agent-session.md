# Agent Session の状態

Tab で claude が動くと、monica はその Agent Session の状態（Running（動作中）・Waiting（ユーザー待ち）・その理由）を持ち、Waiting になると Notification（通知）を出す。

## Sub-features

- `as-track`: Tab の claude が Agent Session として一覧に出る。
- `as-waiting`: 権限の確認や質問で Waiting になり、理由が分かる。
- `as-notify`: Waiting になると Notification が出る。
- `as-end`: claude が終わると一覧から消える。

## How to get to it (user POV)

- desktop の Tab の status dot と Notification。
- CLI の `monica workbench agent-session list`。
- 本物の claude を Tab で起こす（hook が届く）か、claude と同じ経路で hook の payload を CLI の `monica workbench hook claude` に流す。

## Driving it with headless の Backend と CLI の hook

Preconditions:

- `doctor.sh <name>` が `OK`。
- [Tab と端末](./workbench-tab.md) の「Runspace を開く」で開いた Tab の `terminalSessionId` がある。hook は live な Terminal Session のものしか記録されない。

- **Agent Session を作る.** SessionStart の payload を流す。payload の例は `packages/workbench/src/hook-payloads/`、場面ごとの順は `surfaces/headless.md` の hook の節。`printf '%s' '<payload>' | MONICA_HOME=$H MONICA_TERMINAL_SESSION_ID=<ts-id> scripts/monica-dev workbench hook claude`。`monica workbench agent-session list --format json` にその `session_id` が `waiting`・`idle` で出る。起動の Idle（手空き）では `notify` の行は出ない。
- **Waiting にする.** `"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"` の payload を同じく流す。`agent-session list` の状態が Waiting になり、理由が Question（質問）になる。
- **Notification を見る.** `$E/out.jsonl` に `{"type":"notify",…}` の行が足される。
- **終わらせる.** SessionEnd の payload を流す。`agent-session list` からその id が消える。
- **証拠.** 流した payload・exit code・各段の `agent-session list --format json` を `$E/agent-session.transcript` に残し、`out.jsonl` の `notify` の行を添える。

## Gotchas

- hook の CLI は、hook が記録されなかったときも exit 0 で終わる。記録できたかは `agent-session list` と `$E/err.log` で見る。
- field の欠けた payload（`tool_name` の無い PermissionRequest など）は記録されず、`$E/err.log` に `ignored a hook it cannot read` が出る。live でない Terminal Session の hook は `dropped a <event> hook from Terminal Session <id> (…)` が出る。一覧に出ないときはまずここを見る。
- `MONICA_TERMINAL_SESSION_ID` を渡し忘れると、この session の env にある外側の id（ユーザーの Tab）が使われ、記録されないか、ユーザーの Backend に届く。`MONICA_HOME` と一緒に毎回渡す。
- 本物の claude を Tab で起こす経路は `surfaces/headless.md` の「Tab で本物の claude を起こすとき」。初めての directory では trust の確認で止まり、SessionStart が届かない。
